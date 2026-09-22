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
 * Phase 1 = 骨架 + 占位渲染：不拉数据、不画列表、不画 diff（后续 Phase 的
 * navigator.mjs / viewer.mjs 会替换占位实现）。选中状态等跨 mount 共享走
 * client/store.mjs（模块级单例）。
 */
import * as store from "./store.mjs";

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

function placeholderRoot(role) {
	const root = document.createElement("div");
	root.className = `git-review-root git-review-${role}`;
	root.style.cssText = "font:13px/1.6 ui-monospace,SFMono-Regular,Menlo,Consolas,monospace;padding:12px;";
	const title = document.createElement("div");
	title.textContent = role === "navigator" ? "🔀 Diff 评审 · 导航（占位）" : "🔀 Diff Review · viewer (placeholder)";
	title.style.cssText = "font-weight:600;margin-bottom:6px;";
	const note = document.createElement("div");
	note.style.cssText = "opacity:.65;white-space:pre-line;";
	note.textContent =
		role === "navigator"
			? "Phase 1 骨架：文件列表将在 Phase 2 接入 /plugins-api/git-review/*。\nPhase 1 skeleton: the changed-file list arrives in Phase 2."
			: "Phase 1 骨架：diff 渲染将在 Phase 3 接入；请先在右栏选择文件。\nPhase 1 skeleton: the diff renderer arrives in Phase 3.";
	root.append(title, note);
	return root;
}

export default {
	/**
	 * 宿主挂载入口。ctx = { pluginId, send(payload), onData(cb) }（plugin-loader.ts:21）。
	 * Phase 1 不用 ctx（不通信、不订阅）；返回的 cleanup 必须把本次挂的 DOM 和
	 * 订阅清干净（R15 双挂载对称清理）。
	 */
	mount(el, _ctx) {
		if (!el) return () => {};
		el.textContent = "";
		const role = detectRole(el);
		const root = placeholderRoot(role);
		el.appendChild(root);
		// 订阅共享状态（Phase 2/3 起两个角色靠它联动）；退订句柄交给 cleanup，
		// 证明「mount 配对 cleanup」的对称性从骨架期就成立。
		const unsubscribe = store.subscribe(() => {});
		return () => {
			unsubscribe();
			root.remove();
			el.textContent = "";
		};
	},
};
