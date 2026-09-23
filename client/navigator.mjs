/**
 * git-review —— 右栏导航视图（client/navigator.mjs，Phase 2 / R3、R5、R6、R12、R16）。
 *
 * 裸 ESM、无 npm、无构建 —— 自己画 DOM（image-toolkit/notes 的插件视图同款约定）。
 * 数据全部来自 Phase 1 的受信服务端路由：GET /review、/refs、/commits、/marker、
 * /resolve、/tree。取数走**全局 fetch + 由 bundle URL 推导的 apiBase**（notes 的
 * client/data.mjs:18-24 模式；宿主 mount ctx 只有 send/onData，HTTP 通道两边通用，
 * 且多标签页天然一致）。服务端永远 200 + {ok:false,error}（R13），客户端看 ok 字段。
 *
 * 结构：
 *   头部：标题 + 文件数 + 刷新 / 基线行（ref + 短哈希 + 来源徽标 + 更改/还原按钮）
 *   工具条：树形↔平铺、仅变更↔全树（两个独立开关，R6；选择存 store → localStorage）
 *   主体：文件清单（平铺或客户端自建的目录树）/ 基线选择面板 / 各种状态
 *
 * 状态契约（R3/R13/R16）：
 *   - 空评审（基线无差异）→ 友好空态；非仓库 → 友好空态（不是异常栈）；
 *   - 截断：total 保全，列表截到服务端上限，底部「还有 N 个文件未显示」；
 *   - stale marker（存储哈希没了，R13）/ 无可用基线 → 提示手动选基线，不崩挂载；
 *   - 其它错误 → 错误文案 + 重试。
 *
 * 纯逻辑（行模型、树构建、错误分类、基线展示、无 marker 预选）导出为独立函数，
 * node --test 用极小假 DOM 直接驱动整个视图（见 test/navigator.test.mjs）。
 *
 * Phase 5（R17）：文件点击改走**内嵌优先** —— createNavigator 新增可选
 * opts.openFile（entry 注入 inline.open：diff 装进聊天主区的消息面板位置，
 * 输入框留在原地）；未注入（测试/兑底）保留旧的 setView 全屏切换（R7）。
 *
 * Phase 5（R18）：全树模式未变更文件行也可点击 —— 同一选中通道（store 共享
 * 选中）进 viewer；/diff 对这类文件返回范围外空态时 viewer 链式取 /blob 预览
 * 全文，行级评论照常可用（未变更文件基线/HEAD/工作树三处同内容）。
 *
 * R19：目录级聚合增删 —— buildTree 条目支持 {path,add,del} 对象形态，目录行在
 * 右缘展示子树求和的 +add −del（与文件行同款计数列）；头部标题行展示全评审聚合。
 */
import { DEFAULT_BASE_CANDIDATES } from "./gitcore.mjs";
import { detectLang, localeToLang, makeT, watchLocale } from "./i18n.mjs";
import { createReviewSubmitter } from "./submit.mjs";
import * as store from "./store.mjs";

/* ------------------------------------------------------------------ */
/* 纯逻辑（无 DOM，node --test 直接覆盖）                                */
/* ------------------------------------------------------------------ */

/** 提交哈希 → 7 位短哈希（展示用）。 */
export function shortSha(sha) {
	return typeof sha === "string" && sha ? sha.slice(0, 7) : "";
}

/**
 * 服务端错误文本 → 状态类别（R13 的可恢复分支）：
 *   non-repo     工作区不是 git 仓库 → 友好空态（R3）
 *   stale-marker 存储的 marker 哈希不存在/损坏（rebase/amend）→ 提示手动选基线
 *   no-base      无 marker 且主线候选全落空 / 指定 base 解析失败 → 提示手动选基线
 *   unknown      其它 → 错误文案 + 重试
 */
export function classifyReviewError(text) {
	const s = String(text ?? "");
	if (/not a git repository/i.test(s)) return "non-repo";
	if (/stale review marker|corrupt review marker/i.test(s)) return "stale-marker";
	if (/no review base|unknown base|cannot resolve/i.test(s)) return "no-base";
	return "unknown";
}

/**
 * R7：把主区切到本插件视图（宿主桥 `window.__piWebUiHost.setView("plugin:git-review")`，
 * 桥契约 web/src/plugin-host.ts:283/512 —— setView(view: string): void，
 * "plugin:<id>" 切到 App 的 pluginViews 面板）。桥缺失（占位测试 / 桥未就绪）时
 * 安静降级返回 false，绝不抛错拖垮行点击。
 */
export function activateMainView(viewId = "plugin:git-review") {
	try {
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.setView === "function") {
			bridge.setView(viewId);
			return true;
		}
	} catch {
		/* 桥不可用 → no-op */
	}
	return false;
}

/** rename 展示文案：`oldPath → path`；非 rename 返回 null。 */
export function renameText(file) {
	return file && typeof file.oldPath === "string" && file.oldPath !== "" ? `${file.oldPath} → ${file.path}` : null;
}

/** flags → 本地化标签（未知 flag 原样保留，便于发现新类别）。 */
export function flagLabels(flags, t) {
	return (Array.isArray(flags) ? flags : []).map((f) => {
		const key = `nav.flag.${f}`;
		const label = t(key);
		return label === key ? String(f) : label;
	});
}

/**
 * 截断时「还有多少文件没显示」（R16）：total 保全、files 截到上限 → 差值；
 * 未截断返回 0。
 */
export function moreFilesCount(review) {
	if (!review || !review.truncated) return 0;
	return Math.max(0, Number(review.total ?? 0) - (Array.isArray(review.files) ? review.files.length : 0));
}

/**
 * 导航头部的基线展示（R5：活动基线永远可见；来源徽标按 R2 的 source 语义）。
 *   override 活跃           → { ref, key:"override" }（覆盖优先展示）
 *   /review.base 可用       → key = base.source（marker | default | param）
 *   无 review 但有 marker   → 只知道哈希 → ref 显示短哈希、key "marker"
 *   无 marker 有预选        → key "default"（R4：无 marker 时主线候选）
 */
export function baseDisplay(review, override, markerSha = null, suggestedBase = null) {
	if (override && override.ref) {
		// 只在 /review 已按这个 override 返回（base.ref 一致）时才配 sha：覆盖刚落、
		// 重取还在途时 review 仍是上一个基线的载荷，不能把旧 sha 挂到新 ref 上。
		const base = review?.base;
		const sha = base && base.ref === override.ref ? base.sha ?? null : null;
		return { ref: String(override.ref), sha, key: "override" };
	}
	const base = review?.base;
	if (base && base.ref) {
		// source:"param" 只可能是本视图的覆盖请求（?base= 只由这里发）→ 徽标归为覆盖。
		const src = base.source ?? "param";
		return { ref: String(base.ref), sha: base.sha ?? null, key: src === "param" ? "override" : src };
	}
	if (markerSha) return { ref: shortSha(markerSha), sha: markerSha, key: "marker" };
	if (suggestedBase) return { ref: String(suggestedBase), sha: null, key: "default" };
	return null;
}

/**
 * 从平铺条目在客户端建目录树（R6 tree 模式；R19 起条目支持对象形态）。
 * 条目 = 字符串路径 | { path, add, del }（对象形态带入行数，R19 目录级聚合的原料）。
 * 返回节点数组：{ kind:"dir", name, path, depth, children, changed, add, del }
 *             | { kind:"file", name, path, depth, changed, add, del }
 * changed 是「这个文件/这棵子树下有多少变更文件」（isChanged(path)→bool）；
 * add/del 是「这个文件/这棵子树的聚合增删行数」（字符串条目为 0，目录 = 子树求和）。
 * 目录排前、同名按字典序；depth = 目录深度（根下文件为 0）。
 */
export function buildTree(entries, isChanged = () => false) {
	const norm = (Array.isArray(entries) ? entries : []).map((e) =>
		typeof e === "string"
			? { path: e, add: 0, del: 0 }
			: { path: String(e?.path ?? ""), add: Number(e?.add ?? 0) || 0, del: Number(e?.del ?? 0) || 0 },
	);
	const roots = [];
	for (const item of norm.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0))) {
		const segs = item.path.split("/");
		let parent = roots;
		const acc = [];
		for (let i = 0; i < segs.length - 1; i++) {
			acc.push(segs[i]);
			const dirPath = acc.join("/");
			let dir = parent.find((n) => n.kind === "dir" && n.path === dirPath);
			if (!dir) {
				dir = { kind: "dir", name: segs[i], path: dirPath, depth: i, children: [], changed: 0, add: 0, del: 0 };
				parent.push(dir);
			}
			parent = dir.children;
		}
		parent.push({
			kind: "file",
			name: segs[segs.length - 1],
			path: item.path,
			depth: segs.length - 1,
			changed: isChanged(item.path),
			add: item.add,
			del: item.del,
		});
	}
	const finalize = (nodes) => {
		for (const n of nodes) {
			if (n.kind !== "dir") continue;
			finalize(n.children);
			n.changed = n.children.reduce((sum, c) => sum + (c.kind === "dir" ? c.changed : c.changed ? 1 : 0), 0);
			n.add = n.children.reduce((sum, c) => sum + c.add, 0);
			n.del = n.children.reduce((sum, c) => sum + c.del, 0);
		}
		nodes.sort((a, b) => {
			if (a.kind !== b.kind) return a.kind === "dir" ? -1 : 1;
			return a.name < b.name ? -1 : a.name > b.name ? 1 : 0;
		});
	};
	finalize(roots);
	return roots;
}

/**
 * R19：行契约 add/del 的聚合 sum（头部全评审聚合用；截断时只覆盖已列出文件，
 * 与清单一致 —— 截断上限语义 R16 的 total 保全只针对条数）。
 */
export function sumAddDel(files) {
	let add = 0;
	let del = 0;
	for (const f of Array.isArray(files) ? files : []) {
		add += Number(f?.add ?? 0) || 0;
		del += Number(f?.del ?? 0) || 0;
	}
	return { add, del };
}

/** 树节点 → 渲染序列；折叠的目录跳过子树（collapsed: Set<dirPath>）。 */
export function flattenTree(nodes, collapsed = new Set()) {
	const out = [];
	const walk = (list) => {
		for (const n of list) {
			out.push(n);
			if (n.kind === "dir" && !collapsed.has(n.path)) walk(n.children);
		}
	};
	walk(nodes);
	return out;
}

/**
 * R4 无 marker 预选：按 DEFAULT_BASE_CANDIDATES 顺序经 /resolve 找第一个可解析的
 * 主线候选。resolveRef(ref) → Promise<{ok,sha?} | {ok:false}>（调用方注入，便于测试）。
 * 全部落空返回 null（调用方交给「无可用基线」状态）。
 */
export async function pickDefaultBase(resolveRef) {
	for (const candidate of DEFAULT_BASE_CANDIDATES) {
		try {
			const r = await resolveRef(candidate);
			if (r && r.ok && r.sha) return candidate;
		} catch {
			/* 候选不存在 → 试下一个 */
		}
	}
	return null;
}

/* ------------------------------------------------------------------ */
/* 样式（notes/styles.mjs 模式：一次注入 <head>，gr- 前缀防撞宿主）       */
/* ------------------------------------------------------------------ */

export const NAVIGATOR_CSS = `
.gr-root, .gr-root * { box-sizing: border-box; }
.gr-root {
	--gr-border: var(--border, #262a35);
	--gr-dim: var(--text-dim, #9aa1b4);
	--gr-accent: var(--accent, #8b5cf6);
	--gr-green: var(--green, #34d399);
	--gr-red: var(--red, #f87171);
	--gr-amber: var(--amber, #fbbf24);
	--gr-hover: var(--bg-elev2, #1a1d26);
	--gr-soft: var(--accent-soft, rgba(139, 92, 246, 0.14));
	color: var(--text, #e6e8ef);
	font: 12.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	display: flex; flex-direction: column; height: 100%; min-height: 0;
}
.gr-head { padding: 6px 8px; border-bottom: 1px solid var(--gr-border); display: flex; flex-direction: column; gap: 5px; }
.gr-titlerow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.gr-title { font-weight: 600; flex: none; }
.gr-count { font-size: 11px; opacity: 0.7; flex: none; }
.gr-grow { flex: 1 1 auto; min-width: 0; }
.gr-btn {
	font: inherit; font-size: 12px; cursor: pointer; color: inherit; background: transparent;
	border: 1px solid var(--gr-border); border-radius: 6px; padding: 2px 8px; flex: none; white-space: nowrap;
}
.gr-btn:hover { background: var(--gr-hover); }
.gr-baserow { display: flex; align-items: center; gap: 6px; min-width: 0; }
.gr-baselabel { color: var(--gr-dim); flex: none; }
.gr-baseref {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11.5px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.gr-badge {
	flex: none; font-size: 10px; padding: 1px 6px; border-radius: 8px;
	border: 1px solid var(--gr-border); color: var(--gr-dim);
}
.gr-badge.override { color: var(--gr-amber); border-color: currentColor; }
.gr-badge.marker { color: var(--gr-accent); border-color: currentColor; }
.gr-toolbar { display: flex; gap: 6px; padding: 6px 8px; border-bottom: 1px solid var(--gr-border); }
.gr-seg { display: flex; border: 1px solid var(--gr-border); border-radius: 6px; overflow: hidden; }
.gr-segbtn { font: inherit; font-size: 11.5px; cursor: pointer; color: var(--gr-dim); background: transparent; border: 0; padding: 3px 8px; white-space: nowrap; }
.gr-segbtn.on { color: var(--text, #e6e8ef); background: var(--gr-soft); }
.gr-body { flex: 1 1 auto; overflow: auto; min-height: 0; }
.gr-state { padding: 18px 12px; text-align: center; color: var(--gr-dim); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.gr-state-title { color: var(--text, #e6e8ef); font-weight: 600; }
.gr-state-hint { font-size: 11.5px; opacity: 0.8; white-space: pre-line; }
.gr-banner {
	padding: 6px 10px; font-size: 11.5px; color: var(--gr-amber);
	border-bottom: 1px solid var(--gr-border); white-space: pre-line;
}
.gr-list { padding: 2px 0 8px; }
.gr-row { display: flex; align-items: baseline; gap: 6px; padding: 3px 8px; cursor: pointer; }
.gr-row:hover { background: var(--gr-hover); }
.gr-row.selected { background: var(--gr-soft); }
/* R18：全树未变更行可点（预览态）—— 整行降调、悬息恢复，与变更行区分。 */
.gr-row.preview { color: var(--gr-dim); }
.gr-row.preview:hover { color: var(--text, #e6e8ef); }
.gr-st { flex: none; min-width: 13px; text-align: center; font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; font-size: 11px; }
.gr-st.A { color: var(--gr-green); }
.gr-st.D { color: var(--gr-red); }
.gr-st.M, .gr-st.T { color: var(--gr-amber); }
.gr-st.R, .gr-st.C { color: var(--gr-accent); }
.gr-main { flex: 1 1 auto; min-width: 0; }
.gr-name { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-sub { font-size: 11px; color: var(--gr-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-counts { flex: none; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; white-space: nowrap; }
.gr-add { color: var(--gr-green); }
.gr-del { color: var(--gr-red); }
.gr-flag { flex: none; font-size: 10px; padding: 0 5px; border-radius: 7px; border: 1px solid var(--gr-border); color: var(--gr-dim); white-space: nowrap; }
.gr-flag.untracked { color: var(--gr-amber); border-color: currentColor; }
.gr-dirrow { display: flex; align-items: center; gap: 5px; padding: 3px 8px; cursor: pointer; color: var(--gr-dim); font-size: 12px; }
/* R19：目录级聚合计数 —— 右缘对齐文件行的计数列（复用 gr-counts/gr-add/gr-del）。 */
.gr-dirrow .gr-counts { font-size: 10.5px; }
.gr-dirrow:hover { color: var(--text, #e6e8ef); background: var(--gr-hover); }
.gr-caret { flex: none; width: 10px; text-align: center; }
.gr-dirname { overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-dircnt { flex: none; font-size: 10.5px; opacity: 0.8; }
.gr-more { padding: 6px 10px; font-size: 11.5px; color: var(--gr-dim); border-top: 1px dashed var(--gr-border); margin-top: 4px; }
.gr-picker { padding: 8px 10px 12px; display: flex; flex-direction: column; gap: 10px; }
.gr-psec { font-size: 11px; color: var(--gr-dim); margin-bottom: 3px; }
.gr-pitems { display: flex; flex-direction: column; }
.gr-pitem {
	display: block; width: 100%; text-align: left; font: inherit; font-size: 12px; cursor: pointer;
	color: inherit; background: transparent; border: 1px solid transparent; border-radius: 6px;
	padding: 3px 6px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gr-pitem:hover { background: var(--gr-hover); border-color: var(--gr-border); }
.gr-psha { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--gr-accent); }
.gr-pinput {
	width: 100%; font: inherit; font-size: 12px; color: inherit; background: var(--bg, #0d0e12);
	border: 1px solid var(--gr-border); border-radius: 6px; padding: 4px 8px;
}
.gr-prow { display: flex; gap: 6px; }

/* ---- Phase 4（R9/R10/R11）：徽标、评审摘要、提交动作、可见通知 ---- */
.gr-comment-badge {
	flex: none; font-size: 10px; padding: 0 5px; border-radius: 7px;
	border: 1px solid var(--gr-accent); color: var(--gr-accent); white-space: nowrap;
}
.gr-summary { padding: 6px 8px; border-bottom: 1px solid var(--gr-border); display: flex; flex-direction: column; gap: 4px; }
.gr-summary-label { font-size: 11px; color: var(--gr-dim); }
.gr-summary-input {
	width: 100%; font: inherit; font-size: 12px; color: inherit; background: var(--bg, #0d0e12);
	border: 1px solid var(--gr-border); border-radius: 6px; padding: 4px 8px; resize: vertical; min-height: 40px;
}
.gr-submitrow { display: flex; gap: 6px; align-items: center; }
.gr-submit {
	font: inherit; font-size: 12px; cursor: pointer; color: var(--text, #e6e8ef); background: var(--gr-soft);
	border: 1px solid var(--gr-accent); border-radius: 6px; padding: 3px 10px; white-space: nowrap;
}
.gr-submit:hover { background: var(--gr-hover); }
.gr-notice {
	padding: 6px 10px; font-size: 11.5px; border-top: 1px solid var(--gr-border);
	display: flex; align-items: baseline; gap: 6px; white-space: pre-line;
}
.gr-notice.error, .gr-notice.noReview, .gr-notice.clipboardFailed { color: var(--gr-amber); }
.gr-notice.done { color: var(--gr-green); }
.gr-notice-text { flex: none; }
.gr-notice-grow { flex: 1 1 auto; min-width: 0; }
.gr-notice-message {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: pre; min-width: 0; flex: 1 1 auto;
}
`;

const styledDocs = new WeakSet();

/** 把导航样式注入文档 <head>（每个文档一次；失败不影响功能）。 */
export function ensureStyles(doc) {
	try {
		if (!doc || styledDocs.has(doc)) return;
		const head = doc.head ?? doc.documentElement;
		if (!head || typeof head.append !== "function") return;
		const style = doc.createElement("style");
		style.textContent = NAVIGATOR_CSS;
		head.append(style);
		styledDocs.add(doc);
	} catch {
		/* 样式是锦上添花，注入失败不拦功能 */
	}
}

/* ------------------------------------------------------------------ */
/* 视图工厂                                                             */
/* ------------------------------------------------------------------ */

/**
 * 创建导航视图。
 *
 * @param {object} opts
 *   apiBase    服务端 API 前缀（缺省由 import.meta.url 推导，notes 模式）
 *   fetchImpl  fetch 注入（缺省全局 fetch；测试用桩替换）
 *   document   DOM 文档（缺省全局 document；测试注入极小假 DOM）
 *   ctx        宿主 mount 上下文（只消费 onData：服务端 cwd-changed 广播 → 重拉）
 *   openFile   可选：文件点击的展示入口（R17 内嵌优先；entry 注入 inline.open）。
 *              缺省 = activateMainView()（旧的全屏切换，R7；桥不可用时安静降级）。
 *   lang       初始语言（缺省 detectLang()；测试固定用）
 *
 * 共享状态一律走 ./store.mjs 单例（模块级；node --test 用 setter 复位后直测）。
 * @returns {{ root, refresh, destroy, setLang, model }}
 */
export function createNavigator(opts = {}) {
	const doc = opts.document ?? globalThis.document;
	if (!doc || typeof doc.createElement !== "function") {
		throw new Error("createNavigator requires a document (DOM)");
	}
	const el = makeEl(doc);
	ensureStyles(doc);

	const api = opts.apiBase ?? apiBaseDefault();
	// fetch 缺省用全局（浏览器）；测试注入桩。不注入时不能静默变成 undefined 调用。
	const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const t0 = makeT(() => lang);

	/* ---- 视图本地状态（挂载局部；必须跨 tab 活的都在 store） ---- */
	let lang = opts.lang ?? detectLang();
	let t = t0;
	let destroyed = false;
	let seq = 0; // refresh 代际号：慢回包不覆盖新状态
	let loading = true;
	let errorText = null;
	let errorKind = null;
	let review = null;
	let markerSha = null;
	let suggestedBase = null; // R4 预选（无 marker 时经 /resolve 得出）
	let refs = [];
	let commits = [];
	let treeData = null; // 最近一次 /tree（全树模式）
	let treeLoading = false;
	let treeError = null;
	let treeSeq = 0;
	let pickerOpen = false;
	const collapsed = new Set(); // 目录折叠（会话内即可，不持久化）
	let uiNotice = null; // Phase 4 可见通知 { kind, text, copyable?, copyText?, messageText? }（只被新通知替换，卸载随之消失）
	let submitting = false;
	let submitter = null; // 兜底构建的提交流（opts.submitter 已注入时直接用）

	const modes = () => store.getState().viewModes;

	/* ---- HTTP ---- */
	function apiUrl(path, params) {
		const q = new URLSearchParams();
		for (const [k, v] of Object.entries(params ?? {})) {
			if (v === undefined || v === null || v === "") continue;
			q.set(k, String(v));
		}
		const s = q.toString();
		return `${api}${path}${s ? `?${s}` : ""}`;
	}

	async function callApi(path, params) {
		const res = await doFetch(apiUrl(path, params), { credentials: "same-origin" });
		const text = await res.text();
		let data;
		try {
			data = text ? JSON.parse(text) : {};
		} catch {
			throw new Error(`bad response (${res.status})`);
		}
		// 服务端约定 200 + {ok:false,error}（R13）；没带 ok 字段的非 200 是通道层失败
		if (!res.ok && !("ok" in data)) throw new Error(`HTTP ${res.status}`);
		return data;
	}

	/** R4 预选的 /resolve 包装（pickDefaultBase 的注入点）。 */
	const resolveRef = async (ref) => {
		try {
			return await callApi("/resolve", { ref });
		} catch (err) {
			return { ok: false, error: err instanceof Error ? err.message : String(err) };
		}
	};

	/* ---- 渲染 ---- */
	const model = {
		els: {},
		rows: [],
		pickerItems: [],
	};
	const root = el("div", { class: "gr-root" });
	model.els.root = root;

	function stateBox(title, hint, extra) {
		return el("div", { class: "gr-state" }, [
			el("div", { class: "gr-state-title", text: title }),
			hint ? el("div", { class: "gr-state-hint", text: hint }) : null,
			...(extra ?? []),
		]);
	}

	function renderHead() {
		const d = baseDisplay(review, store.getState().baseOverride, markerSha, suggestedBase);
		const badgeKey = d ? d.key : null;
		const head = el("div", { class: "gr-head" }, [
			el("div", { class: "gr-titlerow" }, [
				el("span", { class: "gr-title", text: `🔀 ${t("nav.title")}` }),
				review ? el("span", { class: "gr-count", text: t("nav.count", { n: review.total }) }) : null,
				// R19：全评审聚合增删（对象条目 sum review.files；截断时 = 已列出文件的聚合）。
				(model.els.totals = (() => {
					if (!review) return null;
					const t = sumAddDel(review.files);
					return countsSpan(t.add, t.del);
				})()),
				el("span", { class: "gr-grow" }),
				(model.els.refreshBtn = el("button", { class: "gr-btn", text: t("nav.refresh"), onclick: () => refresh() })),
			]),
			el("div", { class: "gr-baserow" }, [
				el("span", { class: "gr-baselabel", text: t("nav.base") }),
				(model.els.baseRef = el("span", { class: "gr-baseref", text: d ? baseRefText(d) : "—" })),
				(model.els.baseBadge = badgeKey
					? el("span", { class: `gr-badge ${badgeKey}`, text: t(`nav.base.badge.${badgeKey}`), dataset: { badge: badgeKey } })
					: null),
				el("span", { class: "gr-grow" }),
				(model.els.changeBaseBtn = el("button", { class: "gr-btn", text: t("nav.base.change"), onclick: () => togglePicker() })),
				store.getState().baseOverride
					? (model.els.resetBaseBtn = el("button", {
							class: "gr-btn",
							text: t("nav.base.reset"),
							onclick: () => {
								store.setBaseOverride(null);
								refresh();
							},
						}))
					: null,
			]),
		]);
		return head;
	}

	/** `+add −del` 计数列（R19：文件行/目录行/头部聚合共用；零值部分省略，0/0 → 空列）。 */
	function countsSpan(add, del) {
		const span = el("span", { class: "gr-counts" });
		if (add > 0) span.append(el("span", { class: "gr-add", text: `+${add}` }));
		if (del > 0) span.append(el("span", { class: "gr-del", text: `−${del}` }));
		return span;
	}

	function baseRefText(d) {
		const sha = d.sha ? `@${shortSha(d.sha)}` : "";
		return `${d.ref}${sha}`;
	}

	function renderToolbar() {
		const m = modes();
		const segBtn = (label, active, onclick) => el("button", { class: `gr-segbtn${active ? " on" : ""}`, text: label, onclick });
		const bar = el("div", { class: "gr-toolbar" }, [
			(model.els.segLayout = el("div", { class: "gr-seg" }, [
				(model.els.layoutTree = segBtn(t("nav.layout.tree"), m.layout === "tree", () => {
					store.setViewModes({ layout: "tree" });
				})),
				(model.els.layoutFlat = segBtn(t("nav.layout.flat"), m.layout === "flat", () => {
					store.setViewModes({ layout: "flat" });
				})),
			])),
			(model.els.segScope = el("div", { class: "gr-seg" }, [
				(model.els.scopeChanged = segBtn(t("nav.scope.changed"), m.scope === "changed", () => {
					store.setViewModes({ scope: "changed" });
				})),
				(model.els.scopeFull = segBtn(t("nav.scope.full"), m.scope === "full", () => {
					store.setViewModes({ scope: "full" });
					void ensureTree();
				})),
			])),
		]);
		return bar;
	}

	/** 选中并打开（R7/R17/R18 共用入口）：{path, base} 原子写入共享 store（viewer
	 *  对任一变化重拉 /diff，范围外时链式取 /blob 预览），展示内嵌优先（R17）——
	 *  entry 注入 openFile（inline 控制器装进聊天主区消息面板位置，锚不到时它自己
	 *  回落全屏）；未注入（测试/兑底）→ 旧的 setView 全屏切换（桥不可用时安静降级）。 */
	function selectAndOpen(path) {
		const override = store.getState().baseOverride;
		store.setSelection({ path, base: override?.ref ?? review?.base?.ref ?? null });
		if (typeof opts.openFile === "function") opts.openFile();
		else activateMainView();
	}

	/** 文件行（Phase 1 /review 行契约：status 字母、add/del、rename old→new、flags；
	 *  R18：changed:false 的全树未变更行也可点 —— preview 态预览 + 评论）。 */
	function fileRow(file, { depth = 0, selected = false, changed = true } = {}) {
		const row = el("div", {
			class: `gr-row${changed ? "" : " preview"}${selected ? " selected" : ""}`,
			style: `padding-left:${8 + depth * 12}px`,
			dataset: { path: file.path },
			title: t(changed ? "nav.select" : "nav.select.preview", { path: file.path }),
		});
		const main = el("div", { class: "gr-main" });
		const name = file.path.split("/").pop() || file.path;
		const sub = renameText(file) ?? (file.path.includes("/") ? file.path.slice(0, file.path.lastIndexOf("/")) : null);
		if (changed) {
			row.append(el("span", { class: `gr-st ${file.status ?? ""}`, text: file.status ?? "?" }));
			main.append(el("div", { class: "gr-name", text: name }));
			if (sub) main.append(el("div", { class: "gr-sub", text: sub }));
			row.append(main);
			row.append(countsSpan(file.add, file.del));
			const isUntracked = (file.flags ?? []).includes("untracked");
			for (const label of flagLabels(file.flags, t)) {
				row.append(el("span", { class: `gr-flag${isUntracked ? " untracked" : ""}`, text: label }));
			}
			row.addEventListener("click", () => selectAndOpen(file.path));
		} else {
			main.append(el("div", { class: "gr-name", text: name }));
			if (sub) main.append(el("div", { class: "gr-sub", text: sub }));
			row.append(main);
			// R18：未变更行同一条选中通道 —— viewer 预览基线全文，评论照常可写。
			row.addEventListener("click", () => selectAndOpen(file.path));
		}
		// R9 每文件评论数徽标：行级/文件级草稿条数（store 写经 store.subscribe →
		// render 同步，草稿活过 tab 卸载所以徽标也活过）。变更行与全树预览行都显示。
		const draftCount = store.commentCountForPath(file.path);
		if (draftCount > 0) {
			row.append(el("span", { class: "gr-comment-badge", text: `💬${draftCount}`, title: t("nav.commentBadge.title", { n: draftCount }) }));
		}
		return row;
	}

	function dirRow(dir, collapsedSet) {
		const isCollapsed = collapsedSet.has(dir.path);
		const row = el("div", {
			class: "gr-dirrow",
			style: `padding-left:${8 + dir.depth * 12}px`,
			dataset: { dir: dir.path },
		});
		row.append(el("span", { class: "gr-caret", text: isCollapsed ? "▸" : "▾" }));
		row.append(el("span", { class: "gr-dirname", text: dir.name }));
		// R19 目录级聚合增删：右缘对齐文件行的计数列。子树有真实行数（add/del 有值）
		// 时展示聚合；全 0 但确有变更文件（未跟踪/二进制行 add=del=0）才回退旧的
		// 「+N 变更文件」徽标 —— 两种数字不做并排，避免绿色 +N（行数）与旧 +N（文件数）撞脸。
		if (dir.add > 0 || dir.del > 0) {
			row.append(el("span", { class: "gr-grow" }));
			row.append(countsSpan(dir.add, dir.del));
		} else if (dir.changed > 0) {
			row.append(el("span", { class: "gr-grow" }));
			row.append(el("span", { class: "gr-dircnt", text: t("nav.tree.changedCount", { n: dir.changed }) }));
		}
		row.addEventListener("click", () => {
			if (collapsed.has(dir.path)) collapsed.delete(dir.path);
			else collapsed.add(dir.path);
			render();
		});
		return row;
	}

	function noticeEl(n, total) {
		return el("div", { class: "gr-more", text: `${t("nav.more", { n })} · ${t("nav.total", { n: total })}`, dataset: { more: String(n) } });
	}

	function renderErrorPanel() {
		const kind = errorKind ?? "unknown";
		if (kind === "non-repo") {
			return stateBox(t("nav.state.nonRepo"), t("nav.state.nonRepoHint"));
		}
		if (kind === "stale-marker" || kind === "no-base") {
			const title = kind === "stale-marker" ? t("nav.state.stale") : t("nav.state.noBase");
			return stateBox(title, t("nav.state.staleHint"), [
				(model.els.pickBaseBtn = el("button", {
					class: "gr-btn",
					text: t("nav.state.pickBase"),
					onclick: () => {
						pickerOpen = true;
						render();
					},
				})),
			]);
		}
		return stateBox(t("nav.state.error", { e: errorText ?? "" }), null, [
			(model.els.retryBtn = el("button", { class: "gr-btn", text: t("nav.state.retry"), onclick: () => refresh() })),
		]);
	}

	function renderPicker() {
		const override = store.getState().baseOverride;
		const pick = (ref, source) => {
			store.setBaseOverride({ ref, source });
			pickerOpen = false;
			refresh();
		};
		const section = (title, items) => {
			const box = el("div", {}, [el("div", { class: "gr-psec", text: title })]);
			const list = el("div", { class: "gr-pitems" });
			if (!items.length) list.append(el("div", { class: "gr-psec", text: t("nav.base.none") }));
			for (const it of items) list.append(it);
			box.append(list);
			return box;
		};
		// value = 实际传给 ?base= 的 ref（提交用完整哈希，稳定）；label 只管展示。
		const refBtn = (value, label, source) => {
			const b = el("button", { class: "gr-pitem", dataset: { ref: value } });
			b.append(label);
			b.addEventListener("click", () => pick(value, source));
			model.pickerItems.push({ el: b, ref: value, source });
			return b;
		};
		const local = refs.filter((r) => !r.remote).map((r) => refBtn(r.name, r.name + (r.current ? ` (${t("nav.base.current")})` : ""), "branch"));
		const remote = refs.filter((r) => r.remote).map((r) => refBtn(r.name, r.name, "branch"));
		const recent = commits.slice(0, 15).map((c) => refBtn(c.sha, `${c.shortSha} ${c.subject} (${c.date})`, "commit"));

		const input = (model.els.manualInput = el("input", { class: "gr-pinput", placeholder: t("nav.base.manualHint"), dataset: { role: "manual" } }));
		const apply = (model.els.manualApply = el("button", {
			class: "gr-btn",
			text: t("nav.base.apply"),
			onclick: () => {
				const ref = String(input.value ?? "").trim();
				if (!ref) return;
				pick(ref, "manual");
			},
		}));

		const panel = el("div", { class: "gr-picker" }, [
			el("div", { class: "gr-titlerow" }, [
				el("span", { class: "gr-title", text: t("nav.base.pickTitle") }),
				el("span", { class: "gr-grow" }),
				el("button", { class: "gr-btn", text: t("nav.base.close"), onclick: () => togglePicker() }),
			]),
			el("div", { class: "gr-psec", text: t("nav.base.markerInfo", { sha: markerSha ? shortSha(markerSha) : "—" }) }),
			override ? el("div", { class: "gr-psec", text: `${t("nav.base.badge.override")}: ${override.ref}` }) : null,
			section(t("nav.base.branches"), local),
			section(t("nav.base.remote"), remote),
			section(t("nav.base.commits"), recent),
			el("div", {}, [
				el("div", { class: "gr-psec", text: t("nav.base.manual") }),
				el("div", { class: "gr-prow" }, [input, apply]),
			]),
		]);
		return panel;
	}

	function renderChangedList() {
		const files = review?.files ?? [];
		const box = el("div", { class: "gr-list" });
		model.rows = [];
		const fileMap = new Map(files.map((f) => [f.path, f]));
		if (modes().layout === "tree") {
			// R19：目录级聚合增删 —— 树条目用对象形态把行数带进 buildTree（子树求和）。
			const nodes = buildTree(
				files.map((f) => ({ path: f.path, add: f.add, del: f.del })),
				() => true,
			);
			for (const n of flattenTree(nodes, collapsed)) {
				if (n.kind === "dir") box.append(dirRow(n, collapsed));
				else {
					const file = fileMap.get(n.path);
					const row = fileRow(file, { depth: n.depth, selected: store.getState().selectedPath === n.path });
					model.rows.push({ el: row, file });
					box.append(row);
				}
			}
		} else {
			for (const file of files) {
				const row = fileRow(file, { selected: store.getState().selectedPath === file.path });
				model.rows.push({ el: row, file });
				box.append(row);
			}
		}
		const more = moreFilesCount(review);
		const notice = more > 0 ? noticeEl(more, review.total) : null;
		if (notice) box.append(notice);
		model.notice = notice;
		return box;
	}

	function renderFullTree() {
		if (treeLoading) return stateBox(t("nav.state.refreshing"), null);
		if (treeError) {
			return stateBox(t("nav.state.fullError", { e: treeError }), null, [
				(model.els.retryTreeBtn = el("button", { class: "gr-btn", text: t("nav.state.retry"), onclick: () => {
					treeData = null;
					treeError = null;
					void ensureTree(true);
				} })),
			]);
		}
		if (!treeData) return stateBox(t("nav.state.loading"), null);
		if (!treeData.files.length) return stateBox(t("nav.state.empty"), t("nav.state.emptyHint"));
		const changedSet = new Set((review?.files ?? []).map((f) => f.path));
		const fileMap = new Map((review?.files ?? []).map((f) => [f.path, f]));
		const box = el("div", { class: "gr-list" });
		model.rows = [];
		// R19：变更文件用对象形态带行数（目录级聚合增删照常展示），未变更文件保持字符串。
		const nodes = buildTree(
			treeData.files.map((p) => {
				const f = fileMap.get(p);
				return f ? { path: p, add: f.add, del: f.del } : p;
			}),
			(p) => changedSet.has(p),
		);
		for (const n of flattenTree(nodes, collapsed)) {
			if (n.kind === "dir") {
				box.append(dirRow(n, collapsed));
				continue;
			}
			const file = fileMap.get(n.path);
			const row = file
				? fileRow(file, { depth: n.depth, selected: store.getState().selectedPath === n.path })
				: fileRow({ path: n.path }, { depth: n.depth, changed: false, selected: store.getState().selectedPath === n.path });
			model.rows.push({ el: row, file: file ?? { path: n.path } });
			box.append(row);
		}
		const more = moreFilesCount(treeData);
		const notice = more > 0 ? noticeEl(more, treeData.total) : null;
		if (notice) box.append(notice);
		model.notice = notice;
		return box;
	}

	function renderBody() {
		if (pickerOpen) return renderPicker();
		if (loading) return stateBox(t("nav.state.loading"), null);
		if (modes().scope === "full") {
			// 全树模式下工作区浏览不依赖基线：评审出错也照常列树（错误收成顶部细条）。
			const parts = [];
			if (errorText) {
				parts.push(
					el("div", { class: "gr-banner", text: t("nav.state.error", { e: errorText }) }, [
						(model.els.retryBtn = el("button", { class: "gr-btn", text: t("nav.state.retry"), onclick: () => refresh() })),
					]),
				);
			}
			parts.push(renderFullTree());
			const wrap = el("div", {});
			for (const p of parts) wrap.append(p);
			return wrap;
		}
		if (errorText) return renderErrorPanel();
		if (!review) return stateBox(t("nav.state.loading"), null);
		if (!review.files.length) return stateBox(t("nav.state.empty"), t("nav.state.emptyHint"));
		return renderChangedList();
	}

	/* ---- 评审摘要 + 提交动作（Phase 4, R10/R11）---- */

	/**
	 * 摘要框（R10）：挂载局部元素，值从 store 草稿恢复（活过 tab 卸载）；打字经
	 * **静默写盘**进 store（另一 mount 不因打字重渲染）。任何状态都在（评审出错/
	 * 加载中也有）—— 提交的非法态由守卫给可见通知，不是隐藏入口。
	 */
	function renderSummarySection() {
		const input = (model.els.summaryInput = el("textarea", {
			class: "gr-summary-input",
			placeholder: t("nav.summary.placeholder"),
			value: store.getSummary(),
		}));
		input.addEventListener("input", () => {
			store.setSummary(input.value);
		});
		return el("div", { class: "gr-summary" }, [
			el("div", { class: "gr-summary-label", text: t("nav.summary.label") }),
			input,
			el("div", { class: "gr-submitrow" }, [
				(model.els.submitBtn = el("button", { class: "gr-btn gr-submit", text: t("nav.submit"), onclick: () => void submitReview() })),
			]),
		]);
	}

	/** 兜底提交流（entry.mount 未注入 submitter 时按本视图的通道构建）。 */
	function defaultSubmitter() {
		if (!submitter) {
			submitter = opts.submitter ?? createReviewSubmitter({ apiBase: api, fetchImpl: doFetch, clipboard: opts.clipboard });
		}
		return submitter;
	}

	/**
	 * 提交（R11）：草稿 + 摘要 + 最近 /review 载荷交给提交流；结果按 reason 渲染
	 * 可见通知。成功后重拉（marker 已推进 → 基线行显示 post-submit 范围；fresh
	 * navigator 缺省 = post-submit 范围）。
	 */
	async function submitReview() {
		if (submitting) return;
		submitting = true;
		try {
			const result = await defaultSubmitter().submit({
				review: store.getState().lastReview,
				summary: store.getSummary(),
				comments: store.getComments(),
			});
			if (result.ok && result.markerAdvanced === false) {
				// 投递成功但 marker 没推进 —— 如实告知（下次评审仍从原基线开始），amber 警示。
				// 覆盖保持不动：原基线仍是当前真实范围。
				uiNotice = { kind: "error", text: t("nav.submit.markerStale") };
			} else if (result.ok) {
				// marker 已推进到 HEAD —— 会话内覆盖立即失效，本次刷新直接落在
				// post-submit 范围（否则同一批文件被重复列出、重复可评）。
				store.setBaseOverride(null);
				uiNotice = { kind: "done", text: t("nav.submit.done") };
			} else if (result.reason === "empty") {
				uiNotice = { kind: "empty", text: t("nav.submit.empty") };
			} else if (result.reason === "no-review") {
				uiNotice = { kind: "noReview", text: t("nav.submit.noReview") };
			} else if (result.reason === "compose-false") {
				uiNotice = { kind: "fallback", text: t("nav.submit.fallback"), copyable: true, copyText: result.text };
			} else {
				uiNotice = { kind: "clipboardFailed", text: t("nav.submit.clipboardFailed"), copyable: true, copyText: result.text, messageText: result.text };
			}
			render();
			if (result.ok) await refresh();
		} finally {
			submitting = false;
		}
	}

	/** 通知条上的手动兜底复制：成功 → 切回「已复制」；失败 → 保持手动复制提示。 */
	async function copyNotice() {
		const text = uiNotice?.copyText;
		if (typeof text !== "string") return;
		const ok = await store.copyToClipboard(text, opts.clipboard);
		if (!ok) {
			uiNotice = { kind: "clipboardFailed", text: t("nav.submit.clipboardFailed"), copyable: true, copyText: text, messageText: text };
		} else if (uiNotice?.kind === "clipboardFailed") {
			uiNotice = { kind: "fallback", text: t("nav.submit.fallback"), copyable: true, copyText: text };
		}
		render();
	}

	function renderNoticeBar() {
		if (!uiNotice) return null;
		const bar = el("div", { class: `gr-notice ${uiNotice.kind}`, dataset: { notice: uiNotice.kind } }, [
			el("span", { class: "gr-notice-text", text: uiNotice.text }),
			el("span", { class: "gr-notice-grow" }),
		]);
		if (uiNotice.copyable) {
			bar.append((model.els.noticeCopyBtn = el("button", { class: "gr-btn gr-notice-copy", text: t("nav.submit.copy"), onclick: () => void copyNotice() })));
		}
		if (uiNotice.messageText) {
			bar.append(el("span", { class: "gr-notice-message", text: uiNotice.messageText }));
		}
		return bar;
	}

	function render() {
		model.pickerItems = [];
		model.rows = [];
		model.notice = null;
		root.textContent = "";
		root.append(renderHead(), renderToolbar(), renderSummarySection());
		const body = el("div", { class: "gr-body" });
		body.append(renderBody());
		root.append(body);
		const noticeBar = renderNoticeBar();
		if (noticeBar) root.append(noticeBar);
	}

	/* ---- 数据装载 ---- */

	async function refresh() {
		if (destroyed) return;
		const my = ++seq;
		loading = true;
		errorText = null;
		errorKind = null;
		treeData = null;
		treeError = null;
		render();
		try {
			const [markerRes, refsRes, commitsRes] = await Promise.all([
				callApi("/marker", {}).catch(() => null),
				callApi("/refs", {}).catch(() => null),
				callApi("/commits", {}).catch(() => null),
			]);
			if (my !== seq) return;
			markerSha = markerRes?.ok && markerRes.sha ? markerRes.sha : null;
			refs = Array.isArray(refsRes?.refs) ? refsRes.refs : [];
			commits = Array.isArray(commitsRes?.commits) ? commitsRes.commits : [];

			// R4 预选：无 marker 且无覆盖时经 /resolve 找主线候选（展示用；/review
			// 不带 base 参数时服务端按同一规则解析并回 source:"default"）。
			suggestedBase = null;
			if (!markerSha && !store.getState().baseOverride) {
				suggestedBase = await pickDefaultBase(resolveRef);
				if (my !== seq) return;
			}

			const override = store.getState().baseOverride;
			const reviewRes = await callApi("/review", override ? { base: override.ref } : {});
			if (my !== seq) return;
			if (reviewRes?.ok) {
				review = reviewRes;
				store.setLastReview(reviewRes);
				// 活动基线已解析 → 把共享选中同步到同一基线（R15 store 联动：viewer 据
				// selectedPath+selectedBase 拉 /diff，评审基线变化时必须跟着重拉。同步点
				// 放在 /review 返回后 —— 覆盖刚落但解析失败时 viewer 保留旧基线，与
				// 导航的错误态一致）。值未变时 setSelection 不通知，viewer 不重拉。
				const selectedPath = store.getState().selectedPath;
				if (typeof selectedPath === "string" && selectedPath !== "") {
					store.setSelection({ path: selectedPath, base: reviewRes.base?.ref ?? null });
				}
			} else {
				review = null;
				errorText = reviewRes?.error ?? "unknown error";
				errorKind = classifyReviewError(errorText);
			}
		} catch (err) {
			if (my !== seq) return;
			review = null;
			errorText = err instanceof Error ? err.message : String(err);
			errorKind = classifyReviewError(errorText);
		}
		if (my !== seq) return;
		loading = false;
		render();
		// 全树模式下评审装载完接着拉 /tree（await 保证一次 refresh 返回后界面就绪）。
		if (modes().scope === "full") await ensureTree();
	}

	async function ensureTree(force = false) {
		if (modes().scope !== "full") return;
		if (!force && (treeData || treeLoading || treeError)) return;
		const my = ++treeSeq;
		treeLoading = true;
		treeError = null;
		render();
		try {
			const res = await callApi("/tree", {});
			if (my !== treeSeq) return;
			if (res?.ok) {
				treeData = res;
			} else {
				treeData = null;
				treeError = res?.error ?? "unknown error";
			}
		} catch (err) {
			if (my !== treeSeq) return;
			treeData = null;
			treeError = err instanceof Error ? err.message : String(err);
		}
		if (my !== treeSeq) return;
		treeLoading = false;
		render();
	}

	function togglePicker() {
		pickerOpen = !pickerOpen;
		render();
	}

	/* ---- 外部联动 ---- */

	// store 变化（另一 mount 改了视图模式/选中）→ 重渲染；本视图自己的写操作
	// 也走 store，统一从这条通道回渲染，避免双写。
	const unsubscribe = store.subscribe(() => {
		if (!destroyed) render();
	});

	// R12：宿主切语言 → 就地换文案（onLocale change-only，初始值已在 detectLang 读取）。
	// 直接消费 onLocale 的 locale 载荷：宿主在 App 的 effect 里推 onLocale，而
	// documentElement.lang 由其父级 LanguageProvider 的 effect 写入（React 子
	// effect 先跑），回调触发瞬间属性仍是旧值 —— 此处重读属性会永远拿旧语言。
	const offLocale = watchLocale((loc) => {
		const next = localeToLang(loc);
		if (next !== lang) setLang(next);
	});

	// 服务端 cwd-changed 广播（Phase 1 onCwdChange）→ 工作区变了，重拉全部。
	let offData = null;
	if (typeof opts.ctx?.onData === "function") {
		offData = opts.ctx.onData((payload) => {
			if (payload && payload.kind === "cwd-changed") refresh();
		});
	}

	function setLang(next) {
		lang = next === "en" || next === "zh" ? next : detectLang();
		t = makeT(() => lang);
		render();
	}

	render();

	return {
		root,
		refresh,
		ensureTree,
		setLang,
		model,
		get lang() {
			return lang;
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			seq += 1; // 在途请求回来后全部作废
			treeSeq += 1;
			try {
				unsubscribe();
			} catch {
				/* ignore */
			}
			try {
				offLocale?.();
			} catch {
				/* ignore */
			}
			try {
				offData?.();
			} catch {
				/* ignore */
			}
			root.remove();
		},
	};
}

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

/** notes client/data.mjs:18-24 同款：从 bundle URL 推 /plugins-api/git-review 前缀。 */
function apiBaseDefault() {
	try {
		if (typeof import.meta?.url === "string") return store.apiBaseFromUrl(import.meta.url);
	} catch {
		/* fall through */
	}
	return "/plugins-api/git-review";
}

/** 极简 DOM 构建器（image-toolkit util.mjs el 同款；document 可注入便于测试）。 */
function makeEl(doc) {
	return (tag, attrs = {}, children = []) => {
		const node = doc.createElement(tag);
		for (const [k, v] of Object.entries(attrs)) {
			if (v === undefined || v === null || v === false) continue;
			if (k === "class") node.className = String(v);
			else if (k === "text") node.textContent = String(v);
			else if (k === "style") node.style.cssText = String(v);
			else if (k === "dataset") Object.assign(node.dataset, v);
			else if (k === "value") node.value = String(v);
			else if (k.startsWith("on") && typeof v === "function") node.addEventListener(k.slice(2), v);
			else if (v === true) node.setAttribute(k, "");
			else node.setAttribute(k, String(v));
		}
		for (const c of [].concat(children)) {
			if (c === undefined || c === null || c === false) continue;
			node.append(typeof c === "string" || typeof c === "number" ? String(c) : c);
		}
		return node;
	};
}
