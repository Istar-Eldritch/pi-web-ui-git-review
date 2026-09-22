/**
 * git-review —— 主区统一 diff 查看器（client/viewer.mjs，Phase 3 / R7、R8、R15）。
 *
 * 裸 ESM、无 npm、无构建 —— 自己画 DOM（navigator/image-toolkit 同款约定）。数据
 * 来自 Phase 1 的受信路由 GET /diff?path=&base=（结构化 hunks/lines，R2 契约）；
 * 取数走全局 fetch + 由 bundle URL 推导的 apiBase（navigator 同款通道），服务端
 * 永远 200 + {ok:false,error}（R13），客户端看 ok 字段。
 *
 * 渲染形态（R8，统一 diff）：
 *   头部：路径 + 状态字母 + 特例注记（新文件/已删除/重命名 old → new/二进制）、
 *         活动基线（ref@短哈希）、截断标记（数据已由服务端 capPatch 截好，R16）、
 *         刷新 / 折叠上下文（展开了更宽 -U 后出现）。
 *   主体：逐行渲染 —— 旧/新行号双 gutter、+/−/空格 符号列、内容列（monospace +
 *         white-space:pre，保留 git 输出的行内空白）；hunk 头行；两 hunk 之间的
 *         折叠空隙行「⋯ N 行未变更」。特例：二进制（注记 + 无行）、未跟踪
 *         （untracked:true 零 hunk → 「还没有 diff」状态）、范围外已跟踪文件
 *         （零 hunk 无 status → 范围外状态）。
 *
 * 折叠空隙的展开（R8）：空隙内容服务端没发过（-U3 的 elided 上下文），展开 =
 * 经 GET /diff&context=<宽度>（git diff -U<width>）重取更宽上下文：空隙变成带
 * 连续行号的 ctx 行、空隙收拢或两 hunk 合并。每次展开把宽度 3→24 再 ×2（封顶
 * MAX_CONTEXT）；头部「折叠上下文」回到缺省宽度。所有空隙全局同宽 —— 简单、
 * 可测，避免逐空隙的宽度状态机。
 *
 * 行命中模型（Phase 3 命中/选中 + Phase 4 评论锚定）：
 *   行身份 = { path, side: "old"|"new", line }。gutter 双击区：旧行号 → old 侧、
 *   新行号 → new 侧；内容列 → 缺省锚 new 侧（R9），del 行锚 old 侧。单行点击 =
 *   fresh 选中；同侧点击在选中区间末端之下 = 从区间起点向下延伸成连续区间；
 *   点击区间内部 = 收拢为单行；点击在起点之上（向上重选）/ 换侧 = 全新单行；
 *   再点同一单行 = 取消；shift 点击 = 无条件把现区间两端 min/max 延伸到该行
 *   （区间倒置也归一化）。
 *   查询 getSelection() → { path, side, start, end } | null（start ≤ end），
 *   变化经 onSelectionChanged(cb) 回调（返回注销函数）。路径/基线变化 → 选中
 *   复位（锚不跨文件/跨基线存活）。
 *
 * 评论 UI（Phase 4, R9）：选中变化 → 行内编辑器（textarea + 保存/取消）就地
 *   打开/换锚 —— 编辑器/评论列表走常驻占位槽就地同步，不重建 diff 主体（大 diff
 *   不因一次点击全量重画）；保存 = 同锚 upsert 草稿（store 写驱动列表与行标记
 *   就地同步）+ 清选中；取消 = 收起（由选中打开的还一并清选中）。头部有文件级
 *   入口（side "file"，对二进制也可用）；列表带编辑/删除；行级草稿覆盖的行带
 *   ● 标记列 + commented 底色。锚都是挂载局部，草稿本体在 store 模块级单例。
 *
 * 共享状态：选中来自 client/store.mjs 单例（selectedPath + selectedBase，由
 * setSelection 原子写入）。viewer 内部订阅 store：任一变化 → 重拉 /diff；无关
 * 写入（视图模式等）经 fetch-key 比对跳过。两个 mount（navigator + viewer，R15）
 * 都活时靠这条通道联动，挂载清理严格对称。
 *
 * 纯逻辑（折叠空隙计算、行模型、状态归类）导出为独立函数，node --test 用极小
 * 假 DOM + 桩 fetch 驱动整个视图（见 test/viewer.test.mjs；fixture 补丁文本
 * 一律经 Phase 1 的 parseUnifiedDiff 取行号 —— 与 git 输出同源）。
 */
import { MAX_CONTEXT } from "./gitcore.mjs";
import { detectLang, localeToLang, makeT, watchLocale } from "./i18n.mjs";
import { commentAnchorLabel } from "./store.mjs";
import * as store from "./store.mjs";

/* ------------------------------------------------------------------ */
/* 常量                                                                  */
/* ------------------------------------------------------------------ */

/** git 缺省上下文宽度（-U3；argv 不带 -U 时 git 自己用这个）。 */
export const DEFAULT_CONTEXT = 3;
/** 第一次展开折叠空隙时的 -U 宽度（3 附近空隙一次展开即闭合）。 */
export const FIRST_EXPAND_CONTEXT = 24;
/** 服务端校验同口径的宽度封顶（MAX_CONTEXT —— 常量在 gitcore 单源）。 */

/* ------------------------------------------------------------------ */
/* 纯逻辑（无 DOM，node --test 直接覆盖）                                 */
/* ------------------------------------------------------------------ */

/**
 * 两 hunk 之间被 elided 的未变更行数（折叠空隙「⋯ N 行未变更」的 N）：
 * git 语义 = 下一 hunk 的起点减去上一 hunk 声明范围的终点。补丁声明用 hunk 头
 * 的计数（elided 上下文在 -U3 下不出现）；格式良好的补丁 old/new 两侧空隙相等，
 * 截断补丁的计数可能不满 —— 取 max 容忍。≤ 0（计数重叠）→ 无空隙。
 */
export function foldGapBetween(prevHunk, nextHunk) {
	const oldGap = Number(nextHunk?.oldStart) - (Number(prevHunk?.oldStart) + Number(prevHunk?.oldLines));
	const newGap = Number(nextHunk?.newStart) - (Number(prevHunk?.newStart) + Number(prevHunk?.newLines));
	if (!(oldGap > 0) && !(newGap > 0)) return 0;
	return Math.max(oldGap > 0 ? oldGap : 0, newGap > 0 ? newGap : 0);
}

/**
 * 结构化 /diff 载荷 → 渲染行模型（无 DOM）。序列：
 *   { kind:"fold", gap, hunkIndex }         —— hunk i 与 i-1 之间的折叠空隙（i>0）
 *   { kind:"hunk-header", hunk, hunkIndex } —— hunk 头行
 *   { kind:"line", hunk, line, hunkIndex, rowType } —— 逐行（parser 的 old/new 行号）
 */
export function buildDiffRows(payload) {
	const rows = [];
	const hunks = Array.isArray(payload?.hunks) ? payload.hunks : [];
	for (let i = 0; i < hunks.length; i++) {
		const hunk = hunks[i];
		if (i > 0) {
			const gap = foldGapBetween(hunks[i - 1], hunk);
			if (gap > 0) rows.push({ kind: "fold", gap, hunkIndex: i });
		}
		rows.push({ kind: "hunk-header", hunk, hunkIndex: i });
		for (const line of hunk.lines ?? []) {
			rows.push({ kind: "line", hunk, line, hunkIndex: i, rowType: line.type });
		}
	}
	return rows;
}

/**
 * /diff 载荷 → 展示归类（R8 特例各态可辨，零 hunk 的三种病因分开）：
 *   mode: "rows"（正常渲染行）| "binary"（二进制注记 + 无行）
 *       | "untracked"（untracked:true 零 hunk）| "out-of-range"（范围内没该文件）
 *   newFile/deleted/renamed/truncated: 头部注记开关。
 */
export function describeViewerState(payload) {
	if (!payload) return { mode: "rows", newFile: false, deleted: false, renamed: false, truncated: false };
	const hunks = Array.isArray(payload.hunks) ? payload.hunks : [];
	const renamed = typeof payload.oldPath === "string" && payload.oldPath !== "";
	return {
		mode: payload.binary
			? "binary"
			: payload.untracked
				? "untracked"
				: hunks.length === 0
					? "out-of-range"
					: "rows",
		newFile: payload.status === "A",
		deleted: payload.status === "D",
		renamed,
		truncated: payload.truncated === true,
	};
}

/** hunk 头展示文本（parser 已把「省略计数 = 1」规范化，照声明渲染）。 */
export function hunkHeaderText(hunk) {
	return `@@ -${hunk.oldStart},${hunk.oldLines} +${hunk.newStart},${hunk.newLines} @@`;
}

/** 状态字母 → 着色类（navigator 同一套语义：A 绿、D 红、M/T 琥珀、R/C 紫）。 */
export function statusClass(status) {
	switch (String(status ?? "")) {
		case "A":
			return "A";
		case "D":
			return "D";
		case "M":
		case "T":
			return "M";
		case "R":
		case "C":
			return "R";
		default:
			return "";
	}
}

/* ------------------------------------------------------------------ */
/* 样式（navigator/styles 模式：一次注入 <head>，gr- 前缀防撞宿主）       */
/* ------------------------------------------------------------------ */

export const VIEWER_CSS = `
.gr-vroot, .gr-vroot * { box-sizing: border-box; }
.gr-vroot {
	--gr-border: var(--border, #262a35);
	--gr-dim: var(--text-dim, #9aa1b4);
	--gr-accent: var(--accent, #8b5cf6);
	--gr-green: var(--green, #34d399);
	--gr-red: var(--red, #f87171);
	--gr-amber: var(--amber, #fbbf24);
	--gr-hover: var(--bg-elev2, #1a1d26);
	--gr-soft: var(--accent-soft, rgba(139, 92, 246, 0.14));
	--gr-addbg: rgba(52, 211, 153, 0.08);
	--gr-delbg: rgba(248, 113, 113, 0.08);
	--gr-selbg: rgba(139, 92, 246, 0.2);
	color: var(--text, #e6e8ef);
	font: 12.5px/1.5 ui-sans-serif, system-ui, -apple-system, "Segoe UI", sans-serif;
	display: flex; flex-direction: column; height: 100%; min-height: 0;
}
.gr-vhead { padding: 6px 8px; border-bottom: 1px solid var(--gr-border); display: flex; flex-direction: column; gap: 4px; }
.gr-vpathrow { display: flex; align-items: baseline; gap: 8px; min-width: 0; }
.gr-vpath {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-weight: 600; font-size: 12px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.gr-vgrow { flex: 1 1 auto; min-width: 0; }
.gr-vbtn {
	font: inherit; font-size: 12px; cursor: pointer; color: inherit; background: transparent;
	border: 1px solid var(--gr-border); border-radius: 6px; padding: 2px 8px; flex: none; white-space: nowrap;
}
.gr-vbtn:hover { background: var(--gr-hover); }
.gr-vst {
	flex: none; font-family: ui-monospace, Menlo, Consolas, monospace; font-weight: 700; font-size: 11px;
	min-width: 13px; text-align: center;
}
.gr-vst.A { color: var(--gr-green); }
.gr-vst.D { color: var(--gr-red); }
.gr-vst.M { color: var(--gr-amber); }
.gr-vst.R { color: var(--gr-accent); }
.gr-vbaserow { display: flex; align-items: baseline; gap: 6px; min-width: 0; color: var(--gr-dim); font-size: 11.5px; }
.gr-vbaseref { font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-vnote { font-size: 11.5px; color: var(--gr-dim); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
.gr-vbanner {
	padding: 5px 8px; font-size: 11.5px; color: var(--gr-amber);
	border-bottom: 1px solid var(--gr-border); white-space: pre-line;
}
.gr-vbody { flex: 1 1 auto; overflow: auto; min-height: 0; font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 12px; line-height: 1.55; }
.gr-vstate { padding: 18px 12px; text-align: center; color: var(--gr-dim); display: flex; flex-direction: column; gap: 6px; align-items: center; }
.gr-vstate-title { color: var(--text, #e6e8ef); font-weight: 600; }
.gr-vstate-hint { font-size: 11.5px; opacity: 0.8; white-space: pre-line; }
.gr-vactions { display: flex; justify-content: center; padding: 2px 12px 12px; }
.gr-vdiff { padding: 2px 0 8px; }
.gr-vhunkhead {
	color: var(--gr-dim); font-size: 11px; padding: 1px 8px;
	white-space: pre; overflow: hidden; text-overflow: ellipsis; cursor: default;
}
.gr-vfold { display: flex; align-items: baseline; gap: 8px; cursor: pointer; padding: 2px 8px; color: var(--gr-accent); font-size: 11.5px; }
.gr-vfold:hover { background: var(--gr-hover); }
.gr-vfoldgap { flex: none; font-family: ui-monospace, Menlo, Consolas, monospace; }
.gr-vfoldhint { color: var(--gr-dim); font-size: 11px; }
.gr-vline { display: grid; grid-template-columns: 6ch 6ch 1.2ch 1.2ch 1fr; align-items: baseline; cursor: default; }
.gr-vg {
	text-align: right; color: var(--gr-dim); padding: 0 4px; user-select: none; font-size: 11px;
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap;
}
.gr-vg.hot { cursor: pointer; }
.gr-vg.hot:hover { background: var(--gr-hover); }
.gr-vsign { text-align: center; white-space: pre; }
.gr-vcontent { white-space: pre; padding-right: 12px; min-width: 0; overflow: hidden; }
.gr-vline.add { background: var(--gr-addbg); }
.gr-vline.add .gr-vsign { color: var(--gr-green); }
.gr-vline.del { background: var(--gr-delbg); }
.gr-vline.del .gr-vsign { color: var(--gr-red); }
.gr-vline.selected { background: var(--gr-selbg); }
.gr-vline.commented { background: var(--gr-soft); }
.gr-vmark { text-align: center; color: var(--gr-accent); font-size: 11px; }
.gr-veditor { padding: 6px 8px; border-bottom: 1px solid var(--gr-border); display: flex; flex-direction: column; gap: 4px; }
.gr-veditor-anchor { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.gr-veditor-title { font-weight: 600; flex: none; }
.gr-veditor-label {
	font-family: ui-monospace, SFMono-Regular, Menlo, Consolas, monospace; font-size: 11px; color: var(--gr-accent);
	overflow: hidden; text-overflow: ellipsis; white-space: nowrap; min-width: 0;
}
.gr-veditor-input {
	width: 100%; font: inherit; font-size: 12px; color: inherit; background: var(--bg, #0d0e12);
	border: 1px solid var(--gr-border); border-radius: 6px; padding: 4px 8px; resize: vertical; min-height: 46px;
}
.gr-veditor-actions { display: flex; gap: 6px; justify-content: flex-end; }
.gr-vcomments { padding: 4px 8px; border-bottom: 1px solid var(--gr-border); display: flex; flex-direction: column; gap: 4px; }
.gr-vcomments-title { font-size: 11px; color: var(--gr-dim); }
.gr-vcomment { display: flex; align-items: baseline; gap: 6px; min-width: 0; }
.gr-vcomment-anchor { flex: none; font-family: ui-monospace, Menlo, Consolas, monospace; font-size: 11px; color: var(--gr-accent); white-space: nowrap; }
.gr-vcomment-text { flex: 1 1 auto; min-width: 0; overflow: hidden; text-overflow: ellipsis; white-space: pre; }
.gr-vcomment .gr-vbtn { padding: 0 6px; font-size: 11px; }
`;

const styledDocs = new WeakSet();

/** 把查看器样式注入文档 <head>（每个文档一次；失败不影响功能）。 */
export function ensureViewerStyles(doc) {
	try {
		if (!doc || styledDocs.has(doc)) return;
		const head = doc.head ?? doc.documentElement;
		if (!head || typeof head.append !== "function") return;
		const style = doc.createElement("style");
		style.textContent = VIEWER_CSS;
		head.append(style);
		styledDocs.add(doc);
	} catch {
		/* 样式是锦上添花，注入失败不拦功能 */
	}
}

/* ------------------------------------------------------------------ */
/* 视图工厂                                                              */
/* ------------------------------------------------------------------ */

/**
 * 创建 diff 查看器。
 *
 * @param {object} opts
 *   apiBase    服务端 API 前缀（缺省由 import.meta.url 推导，navigator 同款）
 *   fetchImpl  fetch 注入（缺省全局 fetch；测试用桩替换）
 *   document   DOM 文档（缺省全局 document；测试注入极小假 DOM）
 *   lang       初始语言（缺省 detectLang()；测试固定用）
 *
 * 选中/基线一律走 ./store.mjs 单例（两个 mount 共享，R15）；viewer 内部订阅：
 * selectedPath / selectedBase 任一变化 → 重拉 /diff（fetch-key 比对跳过无关写入）。
 * @returns {{ root, refresh, expandFolds, collapseFolds, setLang,
 *            getSelection, onSelectionChanged, model, destroy }}
 */
export function createViewer(opts = {}) {
	const doc = opts.document ?? globalThis.document;
	if (!doc || typeof doc.createElement !== "function") {
		throw new Error("createViewer requires a document (DOM)");
	}
	const el = makeEl(doc);
	ensureViewerStyles(doc);

	const api = opts.apiBase ?? apiBaseDefault();
	// fetch 缺省用全局（浏览器）；测试注入桩。不注入时不能静默变成 undefined 调用。
	const doFetch = opts.fetchImpl ?? ((url, init) => fetch(url, init));
	const t0 = makeT(() => lang);

	/* ---- 视图本地状态（挂载局部；跨 mount 活的都在 store） ---- */
	let lang = opts.lang ?? detectLang();
	let t = t0;
	let destroyed = false;
	let seq = 0; // refresh 代际号：慢回包不覆盖新状态
	let loading = false;
	let errorText = null;
	let payload = null; // 最近一次 /diff 载荷
	let contextWidth = DEFAULT_CONTEXT; // 当前 -U 宽度（折叠展开全局同宽）
	let selection = null; // { path, side, start, end }（start ≤ end；延伸语义见文件头）
	const selectionListeners = new Set();

	/* ---- 评论 UI 状态（Phase 4, R9；锚都是挂载局部，草稿本体在 store） ---- */
	let editorAnchor = null; // { path, side, start, end } | null（编辑器当前锚）
	let editorText = ""; // 输入缓冲：重渲染（refresh/语言切换/草稿写）后不丢
	let editorFromSelection = false; // 编辑器由选中打开（取消时要一并收起选中）
	let editorMode = "add"; // "add" | "edit"（列表编辑按钮 → edit，标题切换）
	let pathComments = []; // 当前路径的草稿快照（渲染序 = 提交序）

	// 挂载时刻的选中（store 已有选中 → 立即拉数；无 → R7 空态）。
	const initial = store.getState();
	let mountedPath = initial.selectedPath ?? null;
	let mountedBase = initial.selectedBase ?? null;
	let mountedDraftsVersion = initial.draftsVersion ?? 0;

	const model = { els: {}, rows: [], folds: [], commentButtons: [] };
	const root = el("div", { class: "gr-vroot" });
	model.els.root = root;
	// 常驻占位槽：编辑器/评论列表的**就地**管理 —— 选中/草稿变化不重建 diff 主体
	// （Phase 3 的就地高亮语义保留：大 diff 不该因一次点击全量重画）。槽在 render
	// 里随 root 重建回挂，内容由 sync*Slot 填充/清空。
	const editorSlot = el("div", {});
	const commentsSlot = el("div", {});

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

	/* ---- 装载 ---- */

	async function refresh() {
		if (destroyed) return;
		const my = ++seq;
		const path = mountedPath;
		const base = mountedBase;
		if (!path) {
			payload = null;
			errorText = null;
			loading = false;
			render();
			return;
		}
		loading = true;
		errorText = null;
		render();
		try {
			// context 只在宽度离开缺省时随请求发出（缺省请求与 Phase 1 契约逐字节一致）。
			const width = contextWidth === DEFAULT_CONTEXT ? undefined : contextWidth;
			const res = await doFetch(apiUrl("/diff", { path, base, context: width }), { credentials: "same-origin" });
			const text = await res.text();
			let data;
			try {
				data = text ? JSON.parse(text) : {};
			} catch {
				throw new Error(`bad response (${res.status})`);
			}
			if (!res.ok && !("ok" in data)) throw new Error(`HTTP ${res.status}`);
			if (my !== seq) return;
			if (data?.ok) {
				payload = data;
			} else {
				payload = null;
				errorText = data?.error ?? "unknown error";
			}
		} catch (err) {
			if (my !== seq) return;
			payload = null;
			errorText = err instanceof Error ? err.message : String(err);
		}
		if (my !== seq) return;
		loading = false;
		render();
	}

	/** 折叠空隙「点击展开」：宽度 3→24 再 ×2（封顶 MAX_CONTEXT，服务端校验同口径）。 */
	function expandFolds() {
		if (destroyed) return;
		const next = contextWidth === DEFAULT_CONTEXT ? FIRST_EXPAND_CONTEXT : Math.min(contextWidth * 2, MAX_CONTEXT);
		if (next === contextWidth) return;
		contextWidth = next;
		void refresh();
	}

	/** 头部「折叠上下文」：回到缺省宽度（argv 不带 -U，与 Phase 1 逐字节一致）。 */
	function collapseFolds() {
		if (destroyed || contextWidth === DEFAULT_CONTEXT) return;
		contextWidth = DEFAULT_CONTEXT;
		void refresh();
	}

	/* ---- 行命中模型（Phase 4 消费；本阶段只做选中） ---- */

	function getSelection() {
		if (!selection) return null;
		return { path: selection.path, side: selection.side, start: selection.start, end: selection.end };
	}

	/** 选中变化回调（R15/R9 的 Phase 4 接口；本阶段只暴露，不做评论 UI）。 */
	function onSelectionChanged(cb) {
		if (typeof cb !== "function") return () => {};
		selectionListeners.add(cb);
		return () => selectionListeners.delete(cb);
	}

	function emitSelectionChanged() {
		const snap = getSelection();
		for (const cb of [...selectionListeners]) {
			try {
				cb(snap);
			} catch {
				/* 单个监听出错不拖垮其它 */
			}
		}
		// 高亮就地更新：选中变化不重建整个 diff 主体（大 diff 不该因一次点击全量
		// 重画），只同步现存行元素的 selected 类；重建路径（refresh/setLang）在
		// lineRow 构建时按 isLineSelected 上类，两处语义一致。
		for (const { el: rowEl, line } of model.rows) {
			rowEl.classList.toggle("selected", isLineSelected(line));
		}
	}

	// R9 编辑器联动（内部首听）：选中变化 → 打开/换锚编辑器（就地同步槽，不重渲染
	// diff 主体）；选中取消（同一点再点/保存后的收起/路径复位）→ 由选中打开的
	// 编辑器一并收起。外部监听（Phase 3 契约）照常收到同一份快照。
	onSelectionChanged((snap) => {
		if (destroyed) return;
		if (snap) {
			if (!editorAnchor || editorAnchor.path !== snap.path || editorAnchor.side !== snap.side || editorAnchor.start !== snap.start || editorAnchor.end !== snap.end) {
				openEditor(snap, { fromSelection: true });
			}
		} else if (editorFromSelection) {
			editorAnchor = null;
			editorText = "";
			editorFromSelection = false;
			syncEditorSlot();
		}
	});

	/** 路径/基线变化 → 锚不跨文件/跨基线存活，选中复位（回调照发 null）。 */
	function resetSelection() {
		if (!selection) return;
		selection = null;
		emitSelectionChanged();
	}

	function isLineSelected(line) {
		if (!selection) return false;
		const no = selection.side === "old" ? line.old : line.new;
		if (!Number.isFinite(no)) return false; // 该侧无行号（add 行无 old、del 行无 new）
		return no >= selection.start && no <= selection.end;
	}

	/** 纯点击（GitHub 语义，方向化延伸）：无同侧选中 / 点击在区间起点之上（向上
	 *  重选）/ 换侧换路径 → 全新单行；再点同一单行 → 取消；点区间内部 → 收拢为
	 *  单行；点区间末端之下 → 从区间起点向下延伸成连续区间。 */
	function selectLine(line, side) {
		if (destroyed) return;
		const lineNo = side === "old" ? line.old : line.new;
		const path = payload?.path ?? null;
		if (!Number.isFinite(lineNo) || !path) return; // 该侧无行号 → 点击无效
		const prev = selection && selection.path === path && selection.side === side ? selection : null;
		if (!prev || lineNo < prev.start) {
			selection = { path, side, start: lineNo, end: lineNo }; // fresh 单行（含向上重选）
		} else if (prev.start === lineNo && prev.end === lineNo) {
			selection = null; // 同一单行再次点击 → 取消选中
		} else if (lineNo <= prev.end) {
			selection = { path, side, start: lineNo, end: lineNo }; // 区间内部 → 收拢为单行
		} else {
			selection = { path, side, start: prev.start, end: lineNo }; // 末端之下 → 向下延伸
		}
		emitSelectionChanged();
	}

	/** shift 点击：无条件把现选中区间延伸到该行（min/max；换侧/换路径则全新单行）。 */
	function selectLineShift(line, side) {
		if (destroyed) return;
		const lineNo = side === "old" ? line.old : line.new;
		const path = payload?.path ?? null;
		if (!Number.isFinite(lineNo) || !path) return;
		const prev = selection && selection.path === path && selection.side === side ? selection : null;
		selection = prev
			? { path, side, start: Math.min(prev.start, lineNo), end: Math.max(prev.end, lineNo) }
			: { path, side, start: lineNo, end: lineNo };
		emitSelectionChanged();
	}

	/* ---- 渲染 ---- */

	function refreshPathComments() {
		pathComments = mountedPath ? store.getComments().filter((c) => c.path === mountedPath) : [];
	}

	function render() {
		model.rows = [];
		model.folds = [];
		model.commentButtons = [];
		refreshPathComments();
		root.textContent = "";
		root.append(renderHead(), editorSlot, commentsSlot, renderBody());
		syncEditorSlot();
		syncCommentsSlot();
	}

	/** 编辑器槽就地同步（选中/草稿变化不重渲染 diff 主体）。 */
	function syncEditorSlot() {
		editorSlot.textContent = "";
		if (!editorAnchor) return;
		editorSlot.append(buildEditorPanel());
	}

	/** 评论列表槽就地同步（草稿写盘后列表/标记同步，diff 主体不动）。 */
	function syncCommentsSlot() {
		commentsSlot.textContent = "";
		if (!mountedPath || !pathComments.length) return;
		commentsSlot.append(buildCommentsPanel(pathComments));
	}

	function renderHead() {
		const st = payload && payload.status ? payload.status : null;
		const cls = statusClass(st);
		const head = el("div", { class: "gr-vhead" }, [
			el("div", { class: "gr-vpathrow" }, [
				payload?.path ? el("span", { class: "gr-vpath", text: payload.path }) : null,
				st ? el("span", { class: `gr-vst ${cls}`, text: st }) : null,
				el("span", { class: "gr-vgrow" }),
				contextWidth !== DEFAULT_CONTEXT
					? (model.els.collapseBtn = el("button", { class: "gr-vbtn", text: t("viewer.collapse"), onclick: () => collapseFolds() }))
					// 回到缺省宽度时清掉上一次展开渲染遗留的按钮引用（el 跳过 undefined 子节点，DOM 不受影响）。
					: (model.els.collapseBtn = undefined),
				// R9 文件级入口：头部按钮，对一切文件可用 —— 尤其二进制（行锚定不可用，
				// 文件级评论照常可写）。点开时编辑器换锚为文件级（side "file"）。
				payload?.path
					? (model.els.fileCommentBtn = el("button", {
							class: "gr-vbtn gr-vfilecomment",
							text: t("viewer.fileComment"),
							onclick: () => openEditor({ path: payload.path, side: "file", start: 0, end: 0 }, { fromSelection: false }),
						}))
					: (model.els.fileCommentBtn = undefined),
				(model.els.refreshBtn = el("button", { class: "gr-vbtn", text: t("nav.refresh"), onclick: () => void refresh() })),
			]),
			payload?.base?.ref
				? el("div", { class: "gr-vbaserow" }, [
						el("span", { text: t("nav.base") }),
						el("span", { class: "gr-vbaseref", text: `${payload.base.ref}@${(payload.base.sha ?? "").slice(0, 7)}` }),
					])
				: null,
			...renderNotes(),
		]);
		return head;
	}

	/** 头部特例注记（R8：新文件 / 已删除 / 重命名 old → new / 二进制）。 */
	function renderNotes() {
		if (!payload) return [];
		const d = describeViewerState(payload);
		const notes = [];
		if (d.renamed) notes.push(el("div", { class: "gr-vnote", text: t("viewer.kind.renamed", { old: payload.oldPath, new: payload.path }) }));
		if (d.newFile) notes.push(el("div", { class: "gr-vnote", text: t("viewer.kind.newFile") }));
		if (d.deleted) notes.push(el("div", { class: "gr-vnote", text: t("viewer.kind.deleted") }));
		if (d.mode === "binary") {
			notes.push(el("div", { class: "gr-vnote", text: t("viewer.kind.binary") }));
			notes.push(el("div", { class: "gr-vnote", text: t("viewer.kind.binaryHint") }));
		}
		return notes;
	}

	function stateBox(title, hint, extra) {
		return el("div", { class: "gr-vstate" }, [
			el("div", { class: "gr-vstate-title", text: title }),
			hint ? el("div", { class: "gr-vstate-hint", text: hint }) : null,
			...(extra ?? []),
		]);
	}

	function renderBody() {
		const body = el("div", { class: "gr-vbody" });
		// 非错误渲染一律清掉上一次错误态遗留的重试按钮引用（与 collapseBtn 同类的防悬挂处理，el 跳过 undefined 不影响 DOM）。
		model.els.retryBtn = undefined;
		if (loading) {
			body.append(stateBox(t("viewer.state.loading"), null));
			return body;
		}
		if (errorText) {
			// 状态框只承载错误文案（状态框文本 = 纯信息）；重试按钮是独立可供性，
			// 放状态框外自己的动作行。
			body.append(
				stateBox(t("viewer.state.error", { e: errorText }), null),
				el("div", { class: "gr-vactions" }, [
					(model.els.retryBtn = el("button", { class: "gr-vbtn", text: t("viewer.state.retry"), onclick: () => void refresh() })),
				]),
			);
			return body;
		}
		if (!mountedPath) {
			// R7：无选中打开主视图 → 指向右栏导航的空态提示。
			body.append(stateBox(t("viewer.empty"), t("viewer.emptyHint")));
			return body;
		}
		if (!payload) {
			body.append(stateBox(t("viewer.state.loading"), null));
			return body;
		}
		const d = describeViewerState(payload);
		if (d.truncated) {
			// R8/R16：服务端已截断 → 可见截断标记（数据本身已被 capPatch 截好）。
			body.append(el("div", { class: "gr-vbanner", text: t("viewer.kind.truncated"), dataset: { truncated: "true" } }));
		}
		if (d.mode === "binary") {
			body.append(stateBox(t("viewer.kind.binary"), t("viewer.kind.binaryHint")));
			return body;
		}
		if (d.mode === "untracked") {
			body.append(stateBox(t("viewer.state.untracked"), t("viewer.state.untrackedHint")));
			return body;
		}
		if (d.mode === "out-of-range") {
			body.append(stateBox(t("viewer.state.outOfRange"), t("viewer.state.outOfRangeHint")));
			return body;
		}
		body.append(renderDiffRows());
		return body;
	}

	function renderDiffRows() {
		const box = el("div", { class: "gr-vdiff" });
		for (const row of buildDiffRows(payload)) {
			if (row.kind === "fold") {
				const fold = el(
					"div",
					{ class: "gr-vfold", dataset: { gap: String(row.gap) }, title: t("viewer.foldHint") },
					el("span", { class: "gr-vfoldgap", text: t("viewer.fold", { n: row.gap }) }),
					el("span", { class: "gr-vfoldhint", text: t("viewer.foldHint") }),
				);
				fold.addEventListener("click", () => expandFolds());
				model.folds.push(fold);
				box.append(fold);
				continue;
			}
			if (row.kind === "hunk-header") {
				box.append(el("div", { class: "gr-vhunkhead", text: hunkHeaderText(row.hunk) }));
				continue;
			}
			box.append(lineRow(row.line));
		}
		return box;
	}

	/** 逐行（双 gutter + 符号列 + 内容列；add/del 底色、选中高亮在 selected 类）。 */
	function lineRow(line) {
		const isAdd = line.type === "add";
		const isDel = line.type === "del";
		const oldNo = Number.isFinite(line.old) ? line.old : null;
		const newNo = Number.isFinite(line.new) ? line.new : null;
		const oldCell = oldNo === null
			? el("span", { class: "gr-vg" })
			: el("span", { class: "gr-vg hot", text: String(oldNo), dataset: { side: "old", line: String(oldNo) } });
		const newCell = newNo === null
			? el("span", { class: "gr-vg" })
			: el("span", { class: "gr-vg hot", text: String(newNo), dataset: { side: "new", line: String(newNo) } });
		// 旧行号 → old 侧、新行号 → new 侧；shift 点击无条件从锚延伸。
		if (oldNo !== null) oldCell.addEventListener("click", (event) => onLineClick(line, "old", event));
		if (newNo !== null) newCell.addEventListener("click", (event) => onLineClick(line, "new", event));
		const sign = el("span", { class: "gr-vsign", text: isAdd ? "+" : isDel ? "-" : " " });
		// R9 行标记：行号落在某条同侧草稿区间内的行带 ● + commented 底色
		// （文件级草稿只进头部列表，不逐行打标记）。标记列就属于第 4 列。
		const covered = isLineCommented(line);
		const mark = el("span", { class: "gr-vmark", text: covered ? "●" : "" });
		// 内容列缺省锚 new 侧（R9），del 行（无 new）锚 old 侧 —— 两种行都可点。
		const content = el("span", { class: "gr-vcontent", text: line.text ?? "" });
		content.addEventListener("click", (event) => onLineClick(line, newNo !== null ? "new" : "old", event));
		const rowEl = el("div", {
			class: `gr-vline ${line.type}${isLineSelected(line) ? " selected" : ""}${covered ? " commented" : ""}`,
			dataset: {
				...(oldNo !== null ? { old: String(oldNo) } : {}),
				...(newNo !== null ? { new: String(newNo) } : {}),
				type: line.type,
			},
		});
		rowEl.append(oldCell, newCell, sign, mark, content);
		model.rows.push({ el: rowEl, line, markEl: mark });
		return rowEl;
	}

	/** 某渲染行是否被当前路径的行级草稿覆盖（同侧行号落区间内）。 */
	function isLineCommented(line) {
		for (const c of pathComments) {
			if (c.side === "file") continue;
			const no = c.side === "old" ? line.old : line.new;
			if (Number.isFinite(no) && no >= c.start && no <= c.end) return true;
		}
		return false;
	}

	/* ---- 评论编辑器（R9）---- */

	/**
	 * 打开/换锚编辑器（就地同步槽，不重渲染 diff 主体）。text 显式传入 = 编辑态
	 * （列表编辑按钮）；否则同锚已有草稿预填（对同锚重复选中 = 原位编辑）。
	 */
	function openEditor(anchor, opts2 = {}) {
		if (!anchor || typeof anchor.path !== "string" || !anchor.path) return;
		editorAnchor = { path: anchor.path, side: anchor.side, start: Number(anchor.start ?? 0), end: Number(anchor.end ?? 0) };
		editorFromSelection = Boolean(opts2.fromSelection);
		editorMode = opts2.text != null ? "edit" : "add";
		const existing = store.getComments().find((c) =>
			c.path === editorAnchor.path && c.side === editorAnchor.side && c.start === editorAnchor.start && c.end === editorAnchor.end);
		editorText = opts2.text ?? existing?.text ?? "";
		syncEditorSlot();
	}

	/** 保存：同锚 upsert 草稿（store 写驱动列表/标记就地同步）+ 清选中（高亮就地清）。 */
	function saveEditor() {
		if (!editorAnchor) return;
		const anchor = { ...editorAnchor };
		const text = editorText.trim();
		editorAnchor = null;
		editorText = "";
		editorFromSelection = false;
		if (text) {
			store.setComment({ ...anchor, text }); // notify → 草稿通道（列表/标记/编辑器收起）
		} else {
			syncEditorSlot(); // 空文本保存 = 丢弃收起（空评论永不落草稿）
		}
		resetSelection(); // 高亮就地清 + emit null（编辑器已关，选中监听不重开）
	}

	/** 取消：收起编辑器；由选中打开的还一并清掉选中（编辑态的取消不动选中）。 */
	function cancelEditor() {
		if (!editorAnchor) return;
		const wasFromSelection = editorFromSelection;
		editorAnchor = null;
		editorText = "";
		editorFromSelection = false;
		syncEditorSlot();
		if (wasFromSelection) resetSelection();
	}

	function buildEditorPanel() {
		const placeholder = editorAnchor.side === "file" ? t("viewer.commentEditor.filePlaceholder") : t("viewer.commentEditor.placeholder");
		const input = (model.els.commentInput = el("textarea", {
			class: "gr-veditor-input",
			placeholder,
			value: editorText,
		}));
		input.addEventListener("input", () => {
			editorText = input.value; // 输入缓冲：重渲染（refresh/草稿写）后不丢
		});
		return el("div", { class: "gr-veditor", dataset: { editor: "true" } }, [
			el("div", { class: "gr-veditor-anchor" }, [
				el("span", { class: "gr-veditor-title", text: t(editorMode === "edit" ? "viewer.commentEditor.editTitle" : "viewer.commentEditor.addTitle") }),
				el("span", { class: "gr-veditor-label", text: commentAnchorLabel(editorAnchor) }),
			]),
			input,
			el("div", { class: "gr-veditor-actions" }, [
				(model.els.commentSave = el("button", { class: "gr-vbtn gr-veditor-save", text: t("viewer.commentEditor.save"), onclick: () => saveEditor() })),
				(model.els.commentCancel = el("button", { class: "gr-vbtn gr-veditor-cancel", text: t("viewer.commentEditor.cancel"), onclick: () => cancelEditor() })),
			]),
		]);
	}

	function buildCommentsPanel(list) {
		const box = el("div", { class: "gr-vcomments", dataset: { comments: "true" } }, [
			el("div", { class: "gr-vcomments-title", text: t("viewer.comments.title", { n: list.length }) }),
		]);
		for (const c of list) {
			const editBtn = el("button", {
				class: "gr-vbtn gr-vcomment-edit",
				text: t("viewer.comments.edit"),
				onclick: () => openEditor({ path: c.path, side: c.side, start: c.start, end: c.end }, { text: c.text }),
			});
			const deleteBtn = el("button", {
				class: "gr-vbtn gr-vcomment-delete",
				text: t("viewer.comments.delete"),
				onclick: () => store.removeComment(c), // notify → 草稿通道同步列表与行标记
			});
			model.commentButtons.push({ comment: c, editBtn, deleteBtn });
			box.append(el("div", { class: "gr-vcomment", dataset: { side: c.side, start: String(c.start), end: String(c.end) } }, [
				el("span", { class: "gr-vcomment-anchor", text: commentAnchorLabel(c) }),
				el("span", { class: "gr-vcomment-text", text: c.text }),
				editBtn,
				deleteBtn,
			]));
		}
		return box;
	}

	function onLineClick(line, side, event) {
		if (event && event.shiftKey === true) selectLineShift(line, side);
		else selectLine(line, side);
	}

	/* ---- store 联动（R15：两个 mount 靠共享单例同步） ---- */

	// selectedPath / selectedBase 任一变化 → 选中复位（锚不跨文件/基线）+ 重拉 +
	// 编辑器收起（复位路径 emit null → 内部选中监听就地收起）。fetch-key 未变的
	// 写入（视图模式等）跳过；草稿版本变化 → 就地同步评论槽 + 行标记（不重拉）。
	const unsubscribe = store.subscribe(() => {
		if (destroyed) return;
		const s = store.getState();
		const path = s.selectedPath ?? null;
		const base = s.selectedBase ?? null;
		if (path === mountedPath && base === mountedBase) {
			const version = s.draftsVersion ?? 0;
			if (version !== mountedDraftsVersion) {
				mountedDraftsVersion = version;
				refreshPathComments();
				syncEditorSlot(); // 编辑器可能已被保存/删除清掉（就地收起）；编辑中被另一 mount 写盘则按缓冲重建
				syncCommentsSlot();
				for (const row of model.rows) {
					const covered = isLineCommented(row.line);
					row.el.classList.toggle("commented", covered);
					if (row.markEl) row.markEl.textContent = covered ? "●" : "";
				}
			}
			return;
		}
		resetSelection();
		mountedPath = path;
		mountedBase = base;
		void refresh();
	});

	// R12：宿主切语言 → 就地换文案（onLocale change-only；初始值已在 detectLang 读取，
	// 载荷归一化见 navigator/i18n 的时序说明）。
	const offLocale = watchLocale((loc) => {
		const next = localeToLang(loc);
		if (next !== lang) setLang(next);
	});

	function setLang(next) {
		lang = next === "en" || next === "zh" ? next : detectLang();
		t = makeT(() => lang);
		render();
	}

	render();

	return {
		root,
		refresh,
		expandFolds,
		collapseFolds,
		setLang,
		getSelection,
		onSelectionChanged,
		model,
		get lang() {
			return lang;
		},
		destroy() {
			if (destroyed) return;
			destroyed = true;
			seq += 1; // 在途回包回来后全部作废
			selectionListeners.clear();
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

/** 极简 DOM 构建器（navigator/image-toolkit util el 同款；document 可注入便于测试）。 */
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
