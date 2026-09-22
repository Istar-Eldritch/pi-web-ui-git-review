/**
 * git-review —— 客户端入口（client/entry.mjs，`export default { mount(el, ctx) }`）。
 *
 * 裸 ESM：无 npm import、无构建步骤、不与宿主共享 React —— 自己画 DOM
 * （docs/architecture-plugins.md 约定）。
 *
 * 同一个模块以两种角色挂载（R15）：
 *   - 右栏导航 tab：宿主容器带 `plugin-page-host` 类（PluginPage.tsx:160）
 *   - 主区 diff 视图：宿主容器是 `plugin-view`（PluginView.tsx:42），mount 拿到的
 *     el 在它里面 —— 所以角色判定用**默认-else**：容器（或其祖先）带
 *     `.plugin-page-host` = navigator，否则 = viewer。
 *
 * ⚠ 这两个容器类是宿主内部实现细节而非文档化插件 API（spec Phase 1 决策），
 *   依赖会在 README（Phase 4）里记录；判定逻辑收口在 detectRole() 一个函数里，
 *   宿主改类名时只改这一处。
 *
 * Phase 2 = 导航角色接真实现；Phase 3 = viewer 角色接真实现：viewer.mjs 消费
 * Phase 1 的 GET /diff（结构化 hunks，R8），选中来自共享 store 单例的
 * selectedPath+selectedBase（setSelection 原子写入；viewer 内部订阅两者，任一
 * 变化重拉）。无选中 → R7 空态提示指向右栏导航。导航侧的文件点击（navigator.mjs
 * row click）写选中 + 经宿主桥 setView("plugin:git-review") 切主区。
 * 跨 mount 共享一律走 client/store.mjs（模块级单例）。
 * Phase 4 = 导航头部加评审摘要 + 提交动作（R10/R11）：提交流在 submit.mjs，
 * submitter 由本文件在 mount 时创建注入 navigator（entry 级装配点）。
 */
import { createNavigator } from "./navigator.mjs";
import { createViewer } from "./viewer.mjs";
import { createReviewSubmitter } from "./submit.mjs";
import { apiBaseFromUrl } from "./store.mjs";

/**
 * 角色检测：容器（或其任意祖先）带 `plugin-page-host` → navigator；
 * 其余一切（含 el 为空/无 classList）→ viewer（默认-else，见文件头注释）。
 */
export function detectRole(el) {
	for (let node = el; node; node = node.parentElement ?? null) {
		if (typeof node?.classList?.contains === "function" && node.classList.contains("plugin-page-host")) {
			return "navigator";
		}
	}
	return "viewer";
}

export default {
	/**
	 * 宿主挂载入口。ctx = { pluginId, send(payload), onData(cb) }（plugin-loader.ts:21）。
	 * navigator 角色把 ctx 传给视图（onData 收 cwd-changed 广播 → 服务端重拉 →
	 * store 的选中重同步会驱动 viewer 跟随）；viewer 角色暂不消费 ctx。
	 * 返回的 cleanup 必须把本次挂的 DOM 和订阅清干净（R15 双挂载对称清理；
	 * store/locale 订阅都收在视图自身的 destroy 里）。
	 */
	mount(el, ctx) {
		if (!el) return () => {};
		el.textContent = "";
		const role = detectRole(el);
		if (role === "navigator") {
			// 右栏导航：消费 Phase 1 路由的真实现（数据通道见文件头注释）。
			const apiBase = apiBaseFromUrl(import.meta.url);
			const nav = createNavigator({
				apiBase,
				ctx,
				document: el.ownerDocument ?? globalThis.document,
				// R11 提交装配（entry 级装配点）：submitter 在这里创建注入视图 ——
				// 桥投递 / marker 推进 / 剪贴板兜底全在提交流（submit.mjs），视图只渲染通知。
				submitter: createReviewSubmitter({ apiBase }),
			});
			el.appendChild(nav.root);
			void nav.refresh(); // 首次装载（视图自身只渲染 loading 态，不自动发请求，便于测试确定性）
			return () => {
				nav.destroy();
				el.textContent = "";
			};
		}
		// viewer：从共享 store 的选中渲染 diff（R7/R8）。viewer 内部订阅
		// selectedPath/selectedBase —— 导航侧点击/基线变化经 store 驱动重拉；
		// 无选中 → R7 空态提示。无选中时 refresh() 不发请求（确定性）。
		const viewer = createViewer({
			apiBase: apiBaseFromUrl(import.meta.url),
			document: el.ownerDocument ?? globalThis.document,
		});
		el.appendChild(viewer.root);
		void viewer.refresh();
		return () => {
			viewer.destroy();
			el.textContent = "";
		};
	},
};
