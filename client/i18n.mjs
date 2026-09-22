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

		// Phase 4（R9/R10/R11）：徽标、评审摘要、提交动作与可见通知。
		// 注意：R11 组装文本本身是固定英文契约（agent 契约，见 README），不在字典里。
		"nav.commentBadge.title": "{n} 条评论草稿",
		"nav.summary.label": "评审摘要",
		"nav.summary.placeholder": "本次评审的整体说明（可选）…",
		"nav.submit": "提交评审",
		"nav.submit.empty": "没有可提交的内容：先添加评论或填写摘要。",
		"nav.submit.noReview": "评审基线未就绪，无法提交。",
		"nav.submit.done": "评审已投递为草稿；标记已推进到 HEAD。",
		"nav.submit.markerStale": "评审已投递为草稿；但标记推进失败 —— 下次评审仍从原基线开始，可再次提交以推进。",
		"nav.submit.fallback": "评审投递失败（聊天输入不可用）：文本已复制到剪贴板。",
		"nav.submit.clipboardFailed": "评审投递失败，且剪贴板不可用；请手动复制下方文本。",
		"nav.submit.copy": "复制",

		"viewer.empty": "主区 diff 查看器",
		"viewer.emptyHint": "从右侧导航（Diff 评审标签页）选择一个文件，即可在此查看它的统一 diff。",
		"viewer.state.loading": "加载中…",
		"viewer.state.error": "加载失败：{e}",
		"viewer.state.retry": "重试",
		"viewer.kind.newFile": "新文件：全部为新增行",
		"viewer.kind.deleted": "已删除文件：全部为删除行",
		"viewer.kind.renamed": "重命名：{old} → {new}",
		"viewer.kind.binary": "二进制文件变更",
		"viewer.kind.binaryHint": "二进制内容不渲染行级 diff，行锚定不可用。",
		"viewer.kind.truncated": "diff 已截断：超出单文件补丁上限，仅显示前半部分。",
		"viewer.state.untracked": "未跟踪文件还没有 diff",
		"viewer.state.untrackedHint": "该文件尚未被 git 跟踪；加入暂存或提交后，这里会显示它的 diff。",
		"viewer.state.outOfRange": "相对评审基线没有该文件的变更",
		"viewer.state.outOfRangeHint": "该文件在当前范围内未改动；从导航选择评审范围内的文件。",
		"viewer.fold": "⋯ {n} 行未变更",
		"viewer.foldHint": "点击展开上下文",
		"viewer.collapse": "折叠上下文",

		// Phase 4（R9）：行内评论编辑器 + 草稿列表 + 文件级入口。
		"viewer.fileComment": "评论整个文件",
		"viewer.comments.title": "评论草稿（{n}）",
		"viewer.comments.edit": "编辑",
		"viewer.comments.delete": "删除",
		"viewer.commentEditor.addTitle": "添加评论",
		"viewer.commentEditor.editTitle": "编辑评论",
		"viewer.commentEditor.placeholder": "针对选中行/区间的评论…",
		"viewer.commentEditor.filePlaceholder": "针对整个文件的评论…",
		"viewer.commentEditor.save": "保存",
		"viewer.commentEditor.cancel": "取消",
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

		// Phase 4 (R9/R10/R11): badge, review summary, submit action, visible notices.
		// Note: the R11 assembled message itself is the fixed English agent contract
		// (see README) and is deliberately not in this dictionary.
		"nav.commentBadge.title": "{n} comment drafts",
		"nav.summary.label": "Review summary",
		"nav.summary.placeholder": "Overall description of this review (optional)…",
		"nav.submit": "Submit review",
		"nav.submit.empty": "Nothing to submit: add a comment or fill in the summary first.",
		"nav.submit.noReview": "The review baseline is not loaded; submit is unavailable.",
		"nav.submit.done": "Review delivered as a draft; the marker advanced to HEAD.",
		"nav.submit.markerStale": "Review delivered as a draft; but the marker could not be advanced — the next review still starts from the previous base (submit again to advance it).",
		"nav.submit.fallback": "Could not deliver the review (no composer): the text was copied to the clipboard.",
		"nav.submit.clipboardFailed": "Could not deliver the review and the clipboard is unavailable; copy the text below manually.",
		"nav.submit.copy": "Copy",

		"viewer.empty": "Diff viewer",
		"viewer.emptyHint": "Pick a file in the right-panel navigator (Diff Review tab) to view its unified diff here.",
		"viewer.state.loading": "Loading…",
		"viewer.state.error": "Failed to load: {e}",
		"viewer.state.retry": "Retry",
		"viewer.kind.newFile": "New file: all additions",
		"viewer.kind.deleted": "Deleted file: all deletions",
		"viewer.kind.renamed": "Renamed: {old} → {new}",
		"viewer.kind.binary": "Binary file changed",
		"viewer.kind.binaryHint": "Binary content has no line-level diff; line anchoring is unavailable.",
		"viewer.kind.truncated": "Diff truncated: the file exceeds the per-file patch cap (only the first part is shown).",
		"viewer.state.untracked": "Untracked file — no diff yet",
		"viewer.state.untrackedHint": "The file is not tracked by git yet; stage or commit it to see a diff here.",
		"viewer.state.outOfRange": "No changes to this file relative to the review base",
		"viewer.state.outOfRangeHint": "The file is unchanged in the current review range; pick a file in the navigator.",
		"viewer.fold": "⋯ {n} unchanged lines",
		"viewer.foldHint": "Click to expand context",
		"viewer.collapse": "Collapse context",

		// Phase 4 (R9): inline comment editor + draft list + file-level affordance.
		"viewer.fileComment": "Comment on file",
		"viewer.comments.title": "Comment drafts ({n})",
		"viewer.comments.edit": "Edit",
		"viewer.comments.delete": "Delete",
		"viewer.commentEditor.addTitle": "Add comment",
		"viewer.commentEditor.editTitle": "Edit comment",
		"viewer.commentEditor.placeholder": "Comment on the selected line/range…",
		"viewer.commentEditor.filePlaceholder": "Comment on the whole file…",
		"viewer.commentEditor.save": "Save",
		"viewer.commentEditor.cancel": "Cancel",
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
