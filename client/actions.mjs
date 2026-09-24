/**
 * git-review —— 文件行快捷动作（client/actions.mjs，R25）。
 *
 * 背景：本插件 tab 要升格为**唯一文件浏览器**（宿主「文件列表」tab 由用户在
 * 设置 → 界面布局 → 右侧面板里取消勾选）。与宿主文件树对齐的行级动作在这里：
 *   引用（reference chip）  = 宿主树的「仅引用路径」—— attachments:[{path,name,mode:"reference"}]
 *   附加（inline 全文）     = 宿主树的「附加内容到对话」—— attachments:[{path:"",fileData,name,size}]
 *   复制路径                = 宿主树的「复制路径」—— 剪贴板
 *
 * 通道全部是**宿主桥受支持契约**（web/src/plugin-host.ts compose，桥版本 11）：
 * `compose({text, attachments})` 只填草稿、绝不发送；attachments 的 reference /
 * inline(fileData) 两种形态是宿主自己也在用的既有形态（全局搜索附着、拖放文件）。
 * 不碰 startChat / prompt —— 与 R11 的「绝不自动发送」不变量同源，只是通道从
 * `{text}` 扩到 `{attachments}`。
 *
 * 纯逻辑（absPath / blobTextFromPayload / planAttach / referenceAttachment）
 * 导出供 node --test 直测；流程对象 createRowActions 的 fetch / 桥 / 仓库根 /
 * 剪贴板全部注入（与 submit.mjs 同款），测试无环境依赖。仓库根不用自己再发
 * 请求 —— navigator 的 refresh 本来就拉 GET /marker（服务端恒返 repoRoot），
 * 由视图注入同步 getter。
 *
 * 绝不抛错给 UI：桥缺失 / compose 拒收 / 网络失败都安静降级（附加→引用→文本→
 * 无操作），返回值只供未来 UI 反馈用，调用方当前不依赖它。
 */
import { copyToClipboard } from "./store.mjs";

/** 附加进输入框的单文件字节上限：超限降级为引用。输入框草稿是会随消息发送的，
 * 太大的内联文本既撑爆草稿也撑爆提示词；64KiB 对「上下文补充」语义足够大。 */
export const MAX_ATTACH_BYTES = 64 * 1024;

/**
 * 仓库根 + 仓库相对路径 → 绝对路径。repoRoot 拿不到（/marker 失败等）时原样
 * 返回相对路径 —— 引用芯片仍然有用（AI 以 cwd 相对读取），只是不如绝对精确。
 */
export function absPath(repoRoot, rel) {
	const root = String(repoRoot ?? "").replace(/\/+$/, "");
	const tail = String(rel ?? "");
	if (!root) return tail;
	if (!tail) return root;
	return `${root}/${tail.replace(/^\/+/, "")}`;
}

/** 路径尾段（展示名用；无分隔符的纯文件名原样返回）。 */
export function baseName(path) {
	const s = String(path ?? "");
	const i = s.lastIndexOf("/");
	return i >= 0 ? s.slice(i + 1) : s;
}

/**
 * /blob 载荷 → 全文文本。服务端 preview/whole-file 形态都是**单个**全 ctx hunk
 * （previewHunks / wholeFileHunks，index.mjs），行文本 join 即全文（尾随换行
 * 不在内 —— 与服务端 split/pop 对称）。hunks 为空 = 空文件（""，合法内容）。
 * 形态不对（多条 hunk / 非 ctx 行）返回 null —— 附加语义要求全文，片段不要。
 */
export function blobTextFromPayload(payload) {
	const hunks = Array.isArray(payload?.hunks) ? payload.hunks : [];
	if (hunks.length === 0) return "";
	if (hunks.length !== 1) return null;
	const lines = Array.isArray(hunks[0]?.lines) ? hunks[0].lines : [];
	let out = "";
	for (const line of lines) {
		if (line?.type !== "ctx") return null;
		out += (out ? "\n" : "") + String(line.text ?? "");
	}
	return out;
}

/** UTF-8 字节数（TextEncoder 每次新建 —— 频度低，不值得缓存实例）。 */
function byteLength(text) {
	try {
		return new TextEncoder().encode(text).length;
	} catch {
		return text.length; // 无 TextEncoder 的极端环境：字符数兜底（只影响上限判断）
	}
}

/**
 * 附加可行性判定（纯函数，决策表测试覆盖）：
 *   ok:false / 无 ok          → reference（"error"）
 *   binary:true               → reference（"binary"）—— 二进制内联进草稿是乱码
 *   truncated:true            → reference（"truncated"）—— 半截文本比没有更糟
 *   全文超 MAX_ATTACH_BYTES   → reference（"too-big"）
 *   其余                      → attach（text 全文 + size 字节 + name 展示名）
 */
export function planAttach(payload, cap = MAX_ATTACH_BYTES) {
	if (!payload || payload.ok !== true) return { kind: "reference", reason: "error" };
	if (payload.binary === true) return { kind: "reference", reason: "binary" };
	if (payload.truncated === true) return { kind: "reference", reason: "truncated" };
	const text = blobTextFromPayload(payload);
	if (text === null) return { kind: "reference", reason: "shape" };
	const size = byteLength(text);
	if (size > cap) return { kind: "reference", reason: "too-big" };
	return { kind: "attach", text, size, name: baseName(payload.path) };
}

/**
 * 引用附件形态（宿主全局搜索附着同款：绝对路径 + 展示名 + mode:"reference"）。
 */
export function referenceAttachment(repoRoot, path) {
	return { path: absPath(repoRoot, path), name: baseName(path), mode: "reference" };
}

/**
 * 行级动作流程。全部 I/O 走注入点：
 *   apiBase      服务端前缀（缺省 /plugins-api/git-review；/blob 附加懒取用）
 *   fetchImpl    fetch（缺省全局；测试桩）
 *   getRepoRoot  仓库根同步 getter（视图注入，来自 refresh 的 /marker 响应；
 *                缺省 () => ""，降级相对路径语义）
 *   getBridge    宿主桥（缺省 window.__piWebUiHost；测试桩）
 *   clipboard    剪贴板注入（透传 store.copyToClipboard；缺省 navigator.clipboard 链）
 */
export function createRowActions(opts = {}) {
	const api = opts.apiBase ?? "/plugins-api/git-review";
	const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const getRepoRoot = opts.getRepoRoot ?? (() => "");
	const getBridge = opts.getBridge ?? (() => globalThis.window?.__piWebUiHost);
	const clipboard = opts.clipboard ?? null;

	/** compose 桥调用：缺桥 / 拒收 / 抛错一律 false（绝不把异常穿给 UI）。 */
	function compose(payload) {
		const bridge = getBridge();
		if (!bridge || typeof bridge.compose !== "function") return false;
		try {
			return bridge.compose(payload) !== false;
		} catch {
			return false;
		}
	}

	/** 引用降级链：reference chip → 纯文本路径（草稿并入语义宿主保证）。 */
	function deliverReference(path) {
		const root = getRepoRoot();
		if (compose({ attachments: [referenceAttachment(root, path)] })) return true;
		return compose({ text: absPath(root, path) });
	}

	return {
		/** 引用：把文件以 reference 附件放进输入框草稿。 */
		async reference(path) {
			return { ok: deliverReference(path), mode: "reference" };
		},

		/**
		 * 附加：GET /blob?side=new（工作树/HEAD 全文，服务端 cap + binary/truncated
		 * 标记）→ planAttach 决策 → inline 全文或降级引用。base 传当前评审基线
		 * （服务端新侧语义其实不依赖 base，带上只为与 /diff 同源一致）。
		 */
		async attach(path, base) {
			const q = new URLSearchParams();
			q.set("path", String(path));
			if (base) q.set("base", String(base));
			q.set("side", "new");
			let payload = null;
			try {
				const res = await doFetch(`${api}/blob?${q.toString()}`, { credentials: "same-origin" });
				const text = await res.text();
				payload = text ? JSON.parse(text) : {};
			} catch {
				payload = null;
			}
			const plan = planAttach(payload);
			if (plan.kind === "attach" && compose({ attachments: [{ path: "", fileData: plan.text, name: plan.name, size: plan.size }] })) {
				return { ok: true, mode: "inline" };
			}
			return { ok: deliverReference(path), mode: "reference", reason: plan.kind === "attach" ? "compose" : plan.reason };
		},

		/** 复制绝对路径（store.copyToClipboard 的注入链；失败仅返回 false）。 */
		async copyPath(path) {
			const copied = await copyToClipboard(absPath(getRepoRoot(), path), clipboard);
			return { ok: copied, mode: "copy" };
		},
	};
}
