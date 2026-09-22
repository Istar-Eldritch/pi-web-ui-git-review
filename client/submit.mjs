/**
 * git-review —— 评审提交流（client/submit.mjs，Phase 4 / R11）。
 *
 * 纯流程模块（无 DOM、无 i18n）：守卫 → 固定模板组装 → `compose({text})` 桥投递 →
 * 失败走剪贴板兜底 → 成功 marker 推进到 HEAD → 清草稿。视图层（navigator）只消费
 * 返回的 {ok, reason} 渲染可见通知 —— 文案按 reason 在视图层查（本模块保持 i18n
 * 无关，便于单元测试逐字断言组装文本）。
 *
 * 装配点：entry.mjs 的 navigator 角色在 mount 时创建 submitter 注入视图（entry 级
 * 装配，R11）；视图层在未注入时用同一工厂兜底构建（fetch/clipboard 走注入点）。
 *
 * **不变量（R11）**：绝不自动发送 —— 桥上只碰 `compose`（草稿注入），startChat /
 * prompt 等自动发送路一次都不触碰；且只投 `{text}`，宿主契约保证草稿**并入**输入
 * 框（plugin-host.ts compose / composer-bridge.ts：既有草稿非空时 `mergeRecalledDraft`
 * = `${current}\\n${recalled}`），这里绝不读改既有草稿文本。
 */
import { assembleReviewMessage, clearDrafts, copyToClipboard } from "./store.mjs";

/**
 * 创建提交流。
 *
 * @param {object} opts
 *   apiBase    服务端 API 前缀（marker 推进用；缺省 /plugins-api/git-review）
 *   fetchImpl  fetch 注入（缺省全局 fetch；测试用桩替换）
 *   clipboard  剪贴板注入点（缺省 navigator.clipboard → DOM execCommand，store 同款）
 *   getBridge  宿主桥注入点（缺省 () => window.__piWebUiHost；测试可注入）
 * @returns {{ submit(input): Promise<{ok:true,text}|{ok:false,text,reason}> }}
 */
export function createReviewSubmitter(opts = {}) {
	const api = opts.apiBase ?? "/plugins-api/git-review";
	const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const clipboard = opts.clipboard ?? null;
	const getBridge = opts.getBridge ?? (() => globalThis.window?.__piWebUiHost);

	return {
		/**
		 * 投递一份评审。返回 { ok: true, text } | { ok: false, text, reason }，
		 * reason ∈ "empty" | "no-review" | "compose-false" | "clipboard-failed"：
		 *   empty            无评论且空摘要（消息只剩收尾句 —— 没有可提交的内容）
		 *   no-review        /review 载荷缺失（范围头/marker 推进都无从谈起）
		 *   compose-false    compose 桥拒收（返回 false / 缺失 / 抛错）→ 剪贴板兜底成功
		 *   clipboard-failed compose 拒收且剪贴板也不可用 → 调用方给手动复制提示
		 * text 永远返回组装后的完整消息（通知渲染「手动复制」时展示用）。
		 */
		async submit({ review, summary, comments } = {}) {
			const text = assembleReviewMessage({ review, summary, comments });
			const hasComments = Array.isArray(comments) && comments.length > 0;
			const hasSummary = String(summary ?? "").trim() !== "";
			if (!hasComments && !hasSummary) return { ok: false, text, reason: "empty" };
			if (!review || review.ok === false || !review.head?.sha) return { ok: false, text, reason: "no-review" };

			const bridge = getBridge();
			let delivered = false;
			if (bridge && typeof bridge.compose === "function") {
				try {
					delivered = bridge.compose({ text }) !== false;
				} catch {
					delivered = false; // 桥调用抛错 = 拒收，走兜底（绝不把异常穿给 UI）
				}
			}
			if (!delivered) {
				const copied = await copyToClipboard(text, clipboard);
				return { ok: false, text, reason: copied ? "compose-false" : "clipboard-failed" };
			}

			// 成功 → marker 推进到 HEAD（R4/R11）：head.sha 已由 GET /review 解析
			// （Phase 1 契约 /review → head:{sha}，无需额外 HEAD 解析路由）。
			try {
				await doFetch(`${api}/marker`, {
					method: "POST",
					credentials: "same-origin",
					headers: { "content-type": "application/json" },
					body: JSON.stringify({ sha: review.head.sha }),
				});
			} catch {
				/* 投递已成功；推进失败不回滚草稿（评审已交，下次提交仍可推进） */
			}
			clearDrafts();
			return { ok: true, text };
		},
	};
}
