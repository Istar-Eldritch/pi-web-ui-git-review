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

/**
 * localStorage 访问收口：环境里没有（node --test）或被禁（隐私模式）→ null。
 * 刻意**每次调用时再判**而非模块加载时定格 —— 同进程里后装的桩（测试）也能生效。
 */
function localStorageOrNull() {
	try {
		return globalThis.localStorage ?? null;
	} catch {
		return null;
	}
}

/** 共享单例：同一页面里所有 mount 共用这一份。 */
const state = {
	/** 导航里选中的文件（/review.files[].path）—— viewer 据此拉 /diff。 */
	selectedPath: null,
	/** 选中携带的基线 ref（/diff?base= 的参数；null = 服务端缺省解析）。与
	 *  selectedPath 由 setSelection() 原子写入：评审基线变化时 navigator 会把
	 *  选中重新同步到新基线，viewer 据此也重拉 /diff（R7/R15 的 store 联动）。 */
	selectedBase: null,
	/**
	 * 本次会话的基线覆盖（R5）；null = 跟随存储的 marker。形态 { ref, source }，
	 * source 记用户选择的类别（"branch" | "commit" | "manual"）。
	 * 刻意**不落 localStorage**（spec Solution Approach：覆盖仅本次会话有效），
	 * 也永不写服务端 marker —— 覆盖只影响这一次 /review?base= 请求。
	 */
	baseOverride: null,
	/** 最近一次 /review 载荷（Phase 1 契约形态 {base,head,files,total,truncated}；
	 *  viewer 用它的 flags/counts/base，避免重复请求）。 */
	lastReview: null,
	/** 视图模式（R6）：layout tree|flat × scope changed|full；模块加载时即从
	 *  localStorage 恢复（守卫见 loadViewModes —— 无 localStorage 的环境用默认值）。 */
	viewModes: loadViewModes(),
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

function notify() {
	for (const fn of [...listeners]) {
		try {
			fn(state);
		} catch {
			/* 单个订阅者出错不拖垮其它 */
		}
	}
}

/** 浅合并 patch 并通知订阅者（两个 mount 之间的同步通道）。 */
export function setState(patch) {
	if (!patch || typeof patch !== "object") return state;
	Object.assign(state, patch);
	notify();
	return state;
}

/**
 * 视图模式 setter（R6）：合并 patch → localStorage 持久化（守卫，存不下就下次用默认）
 * → 通知订阅者。layout: "tree"|"flat"；scope: "changed"|"full"。
 */
export function setViewModes(patch) {
	const next = {
		layout: patch && patch.layout === "tree" ? "tree" : patch && patch.layout === "flat" ? "flat" : state.viewModes.layout,
		scope: patch && patch.scope === "full" ? "full" : patch && patch.scope === "changed" ? "changed" : state.viewModes.scope,
	};
	state.viewModes = next;
	saveViewModes(next);
	notify();
	return next;
}

/**
 * 基线覆盖 setter（R5）。null = 清除覆盖（回到跟随 marker）；对象 = { ref, source? }
 * （source 缺省 "override"）。只动模块状态，不碰 localStorage、不碰服务端 marker。
 */
export function setBaseOverride(override) {
	state.baseOverride =
		override === null || override === undefined
			? null
			: { ref: String(override.ref ?? ""), source: String(override.source ?? "override") };
	notify();
	return state.baseOverride;
}

/**
 * 共享选中（R7/R15）：{ path, base } 原子写入 selectedPath/selectedBase —— 选中
 * 携带基线，viewer 对两者任一变化都重拉 /diff。null（或空 path）= 清除选中。
 * 值完全不变时**不通知**（另一 mount 的无关重渲染/重拉都省掉）。基线为空串 /
 * 非字符串一律归一化为 null（= 服务端缺省解析，与 ?base= 省略同义）。
 */
export function setSelection(selection) {
	const path = selection && typeof selection.path === "string" && selection.path !== "" ? selection.path : null;
	const base = selection && typeof selection.base === "string" && selection.base !== "" ? selection.base : null;
	if (path === state.selectedPath && base === (state.selectedBase ?? null)) return state;
	state.selectedPath = path;
	state.selectedBase = base;
	notify();
	return state;
}

/** 记录最近一次 /review 载荷（Phase 1 契约形态）；viewer 跨 tab 复用。 */
export function setLastReview(review) {
	state.lastReview = review ?? null;
	notify();
	return state.lastReview;
}

/** 订阅状态变化；返回注销函数（mount cleanup 时必须调用）。 */
export function subscribe(fn) {
	if (typeof fn !== "function") return () => {};
	listeners.add(fn);
	return () => listeners.delete(fn);
}

/** 视图模式持久化（R6：跨会话记忆）。Phase 2 起 navigator 调用。 */
export function loadViewModes(fallback = { layout: "flat", scope: "changed" }) {
	const ls = localStorageOrNull();
	if (!ls) return { ...fallback };
	try {
		const raw = ls.getItem("git-review.viewModes");
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
	const ls = localStorageOrNull();
	if (!ls) return;
	try {
		ls.setItem("git-review.viewModes", JSON.stringify(modes ?? {}));
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
