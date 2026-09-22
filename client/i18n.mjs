/**
 * git-review —— 插件自带的中英双语文案（R12）。
 *
 * 插件是裸 ESM，不能 import 主应用的 i18n —— 自带小字典（notes / image-toolkit
 * 同款约定）：初始语言读 document.documentElement.lang（宿主切语言时会写它，
 * web/src/i18n.tsx），后续变化经 window.__piWebUiHost.onLocale 订阅（宿主 API
 * v8+；change-only —— 订阅时**不会**回放当前语言，所以初始值必须自己读）。
 *
 * 缺 key 原样回显 key（便于发现漏配）；`{name}` 占位符由 params 替换。
 * 本文件保持无副作用、无 DOM 硬依赖（globalThis 访问全部带守卫），node --test 可直接 import。
 */

export const DICT = {
	zh: {
		"nav.title": "Diff 评审",
		"nav.count": "{n} 个文件",
		"nav.refresh": "刷新",

		"nav.base": "基线",
		"nav.base.change": "更改",
		"nav.base.reset": "还原为标记",
		"nav.base.marker": "标记",
		"nav.base.default": "默认",
		"nav.base.override": "覆盖",
		"nav.base.badge.marker": "标记",
		"nav.base.badge.default": "默认",
		"nav.base.badge.override": "覆盖",
		"nav.base.pickTitle": "选择评审基线",
		"nav.base.branches": "本地分支",
		"nav.base.remote": "远程分支",
		"nav.base.commits": "最近提交",
		"nav.base.current": "当前",
		"nav.base.none": "（空）",
		"nav.base.manual": "手动输入分支或提交",
		"nav.base.manualHint": "分支名、tag 或提交哈希",
		"nav.base.apply": "应用",
		"nav.base.close": "关闭",
		"nav.base.markerInfo": "存储的标记：{sha}",
		"nav.select": "选择在主区查看 diff：{path}",

		"nav.layout.tree": "树",
		"nav.layout.flat": "平铺",
		"nav.scope.changed": "仅变更",
		"nav.scope.full": "全树",

		"nav.state.loading": "加载中…",
		"nav.state.refreshing": "刷新中…",
		"nav.state.empty": "相对基线没有变更",
		"nav.state.emptyHint": "工作树与评审基线一致；提交或修改文件后这里会出现条目。",
		"nav.state.nonRepo": "当前工作区不是 git 仓库",
		"nav.state.nonRepoHint": "这里展示的是宿主工作区（host.cwd）的评审视图；切到 git 仓库目录后自动恢复。",
		"nav.state.error": "加载失败：{e}",
		"nav.state.fullError": "全树加载失败：{e}",
		"nav.state.retry": "重试",
		"nav.state.stale": "评审基线已失效（存储的提交不存在，可能被 rebase / amend）",
		"nav.state.noBase": "没有可用的评审基线",
		"nav.state.staleHint": "请在下方手动选择一个基线（分支或提交）；本次选择不会移动存储的标记。",
		"nav.state.pickBase": "手动选择基线",

		"nav.more": "还有 {n} 个文件未显示",
		"nav.total": "共 {n} 个",
		"nav.flag.untracked": "未跟踪",
		"nav.flag.staged": "已暂存",
		"nav.flag.unstaged": "未暂存",
		"nav.tree.changedCount": "+{n}",
	},
	en: {
		"nav.title": "Diff Review",
		"nav.count": "{n} files",
		"nav.refresh": "Refresh",

		"nav.base": "Base",
		"nav.base.change": "Change",
		"nav.base.reset": "Reset to marker",
		"nav.base.marker": "marker",
		"nav.base.default": "default",
		"nav.base.override": "override",
		"nav.base.badge.marker": "marker",
		"nav.base.badge.default": "default",
		"nav.base.badge.override": "override",
		"nav.base.pickTitle": "Pick review base",
		"nav.base.branches": "Local branches",
		"nav.base.remote": "Remote branches",
		"nav.base.commits": "Recent commits",
		"nav.base.current": "current",
		"nav.base.none": "(empty)",
		"nav.base.manual": "Enter a branch or commit manually",
		"nav.base.manualHint": "branch, tag or commit hash",
		"nav.base.apply": "Apply",
		"nav.base.close": "Close",
		"nav.base.markerInfo": "Stored marker: {sha}",
		"nav.select": "Select to view the diff in the main area: {path}",

		"nav.layout.tree": "Tree",
		"nav.layout.flat": "Flat",
		"nav.scope.changed": "Changed",
		"nav.scope.full": "Full tree",

		"nav.state.loading": "Loading…",
		"nav.state.refreshing": "Refreshing…",
		"nav.state.empty": "No changes relative to the base",
		"nav.state.emptyHint": "The working tree matches the review base; entries appear here after commits or edits.",
		"nav.state.nonRepo": "This workspace is not a git repository",
		"nav.state.nonRepoHint": "This panel reviews the host workspace (host.cwd); it recovers automatically once the workspace is a git repository.",
		"nav.state.error": "Failed to load: {e}",
		"nav.state.fullError": "Failed to load the full tree: {e}",
		"nav.state.retry": "Retry",
		"nav.state.stale": "The review base is stale (the stored commit no longer exists — likely rebased / amended)",
		"nav.state.noBase": "No review base available",
		"nav.state.staleHint": "Pick a base manually below (branch or commit); the choice never moves the stored marker.",
		"nav.state.pickBase": "Pick a base manually",

		"nav.more": "{n} more files",
		"nav.total": "{n} total",
		"nav.flag.untracked": "untracked",
		"nav.flag.staged": "staged",
		"nav.flag.unstaged": "unstaged",
		"nav.tree.changedCount": "+{n}",
	},
};

/** 从主应用读初始语言（documentElement.lang 优先，退 navigator.language，缺省 zh）。 */
export function detectLang() {
	try {
		const raw = String(globalThis.document?.documentElement?.lang ?? "").toLowerCase();
		if (raw.startsWith("zh")) return "zh";
		if (raw) return "en";
	} catch {
		/* 非浏览器环境（单测）→ 走 navigator / 缺省 */
	}
	const nav = String(globalThis.navigator?.language ?? "").toLowerCase();
	return nav.startsWith("zh") ? "zh" : nav ? "en" : "zh";
}

/**
 * 宿主 onLocale 载荷（BCP-47 locale 字符串，如 "zh-CN"/"en-US"）→ "zh" | "en"。
 * 插件只有两种文案：zh 前缀归 zh，其余（含空值）归 en。
 * 跟随语言变化时**必须用这个**把载荷归一化，而不是回头读 documentElement.lang：
 * 宿主在 App 的 effect 里推 onLocale（plugin-host.ts PluginHostLocaleHandler），
 * 而属性由其父级 LanguageProvider 的 effect 写入 —— React 子 effect 先跑，
 * 回调触发瞬间属性仍是旧值。
 */
export function localeToLang(loc) {
	return String(loc ?? "").toLowerCase().startsWith("zh") ? "zh" : "en";
}

/** 直接取文案：t(lang, key, params)。缺 key 回退另一语言再回退 key 本身。 */
export function t(lang, key, params) {
	const table = DICT[lang] ?? DICT.zh;
	let s = table[key] ?? DICT.zh[key] ?? DICT.en[key] ?? key;
	if (params) {
		for (const [k, v] of Object.entries(params)) s = s.split(`{${k}}`).join(String(v));
	}
	return s;
}

/** 语言取值函数 → t(key, params) 闭包（视图里持一个 lang 变量时用）。 */
export function makeT(getLang) {
	return (key, params) => t(typeof getLang === "function" ? getLang() : getLang, key, params);
}

/**
 * 订阅宿主语言变化（R12，宿主 API v8+ 的 window.__piWebUiHost.onLocale）。
 * change-only：订阅本身不回放 —— 调用方先用 detectLang() 读初始值。
 * handler 收到宿主推来的 locale 字符串载荷（如 "zh-CN"），调用方用 localeToLang()
 * 归一化 —— 不要在回调里重读 documentElement.lang（时序原因见 localeToLang 注释）。
 * 宿主桥不存在（单测 / 桥未就绪）时静默退化为永不触发；返回注销函数。
 */
export function watchLocale(handler) {
	if (typeof handler !== "function") return () => {};
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.onLocale === "function") {
			const off = bridge.onLocale(handler);
			return typeof off === "function" ? off : () => {};
		}
	} catch {
		/* 桥不可用 → 不订阅 */
	}
	return () => {};
}
