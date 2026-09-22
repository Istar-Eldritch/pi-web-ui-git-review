/**
 * git-review —— 模块级共享状态（client/store.mjs）。
 *
 * 这个 bundle 会被宿主**同时挂两份**（R15）：右栏导航 tab（PluginPage）+ 主区
 * diff 视图（PluginView）。右栏 tab 切走即被卸载（SlotTabs 的挂载语义），而主区
 * 视图切走时只是隐藏、保持挂载 —— 所以选中文件、评论草稿这类「必须活过 tab 切换」
 * 的状态放**模块级单例**，不放进任何一次 mount 的局部作用域。
 *
 * Phase 1 只立骨架（字段 + setState/subscribe + apiBase 推导）；Phase 2 加视图
 * 模式的 localStorage 持久化，Phase 4 加评论/摘要的完整生命周期。
 *
 * 本文件必须保持无 DOM 依赖（node --test 直接 import）—— localStorage 访问都带
 * 环境守卫。
 */

/** 共享单例：同一页面里所有 mount 共用这一份。 */
const state = {
	/** 导航里选中的文件（/review.files[].path）—— viewer 据此拉 /diff。 */
	selectedPath: null,
	/** 本次会话的基线覆盖（ref 字符串）；null = 跟随存储的 marker。覆盖永不落 marker。 */
	baseOverride: null,
	/** 最近一次 /review 载荷（viewer 用它的 flags/counts/base，避免重复请求）。 */
	lastReview: null,
	/** 视图模式（R6，Phase 2 接 localStorage 持久化）：tree|flat × changed|full。 */
	viewModes: { layout: "flat", scope: "changed" },
	/** 行级/文件级评论草稿（Phase 4）：key = `${path}\u0000${side}\u0000${line}` → { text, … }。
	 *  分隔符选 NUL（路径与行号都不可能含它）。这里必须写成 \u0000 转义而不是原始
	 *  0x00 字节 —— 原始 NUL 会让 git 把本文件当二进制（"Binary files differ"），
	 *  永远无法正常 diff/审查。 */
	comments: new Map(),
	/** 评审摘要（Phase 4）。 */
	summary: "",
};

const listeners = new Set();

export function getState() {
	return state;
}

/** 浅合并 patch 并通知订阅者（两个 mount 之间的同步通道）。 */
export function setState(patch) {
	if (!patch || typeof patch !== "object") return state;
	Object.assign(state, patch);
	for (const fn of [...listeners]) {
		try {
			fn(state);
		} catch {
			/* 单个订阅者出错不拖垮其它 */
		}
	}
	return state;
}

/** 订阅状态变化；返回注销函数（mount cleanup 时必须调用）。 */
export function subscribe(fn) {
	if (typeof fn !== "function") return () => {};
	listeners.add(fn);
	return () => listeners.delete(fn);
}

const hasLocalStorage = typeof localStorage !== "undefined";

/** 视图模式持久化（R6：跨会话记忆）。Phase 2 起 navigator 调用。 */
export function loadViewModes(fallback = { layout: "flat", scope: "changed" }) {
	if (!hasLocalStorage) return { ...fallback };
	try {
		const raw = localStorage.getItem("git-review.viewModes");
		if (!raw) return { ...fallback };
		const parsed = JSON.parse(raw);
		return {
			layout: parsed?.layout === "tree" ? "tree" : "flat",
			scope: parsed?.scope === "full" ? "full" : "changed",
		};
	} catch {
		return { ...fallback };
	}
}

export function saveViewModes(modes) {
	if (!hasLocalStorage) return;
	try {
		localStorage.setItem("git-review.viewModes", JSON.stringify(modes ?? {}));
	} catch {
		/* 存不下就下次用默认 —— 非关键路径 */
	}
}

/**
 * 从 bundle 自己的 URL 推 API 前缀（notes 插件 client/data.mjs:18-24 模式）：
 * `<base>/plugins/git-review/client/entry.mjs` → `<base>/plugins-api/git-review`。
 * nginx 子路径反代（页面挂在 /pi/ 下）天然兼容。**注意（R1 身份不变量）**：
 * 插件 id = 安装目录名，必须恰好是 `git-review`，这里的硬编码才成立。
 */
export function apiBaseFromUrl(importMetaUrl) {
	const base = String(importMetaUrl ?? "");
	const idx = base.indexOf("/plugins/");
	const root = idx >= 0 ? base.slice(0, idx) : base.replace(/\/[^/]*$/, "");
	return `${root}/plugins-api/git-review`;
}
