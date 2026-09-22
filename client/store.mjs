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
	/** 行级/文件级评论草稿（Phase 4, R9）：key = commentKey(path, side, start, end) →
	 *  { path, side: "old"|"new"|"file", start, end, text }。文件级 side="file"、
	 *  start=end=0。分隔符选 NUL（路径与行号都不可能含它）。这里必须写成 \u0000
	 *  转义而不是原始 0x00 字节 —— 原始 NUL 会让 git 把本文件当二进制
	 *  （"Binary files differ"），永远无法正常 diff/审查。写时整体替换 Map
	 *  （不变式风格）—— 订阅方靠 notify/draftsVersion 察觉，不做原地变异。 */
	comments: new Map(),
	/** 评论写盘的单调版本号：viewer 靠它区分「草稿变化（就地同步面板/行标记）」与
	 *  「无关写入（fetch-key 比对跳过）」—— 摘要写不计数（静默，R10）。 */
	draftsVersion: 0,
	/** 评审摘要草稿（Phase 4, R10）。 */
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

/* ------------------------------------------------------------------ */
/* 评论/摘要草稿（Phase 4, R9/R10）—— 模块级单例，活过右栏 tab 卸载       */
/* ------------------------------------------------------------------ */

/** 锚定 key：同 path/side/start/end 即同一份草稿（重复保存 = 原位编辑）。 */
export function commentKey(path, side, start, end) {
	return `${path}\u0000${side}\u0000${start}\u0000${end}`;
}

/**
 * 合法锚 → 归一化草稿对象；非法（path 空 / side 不认识 / 行号非有限数）→ null。
 * 文件级（side "file"）行号归 0；行级 start/end 必须是有限数（负数也不拦 ——
 * 行号来源是 viewer 的行命中模型，负数根本到不了这里，纯函数不过度设防）。
 */
function normalizeAnchor(comment) {
	if (!comment || typeof comment.path !== "string" || comment.path === "") return null;
	if (comment.side !== "old" && comment.side !== "new" && comment.side !== "file") return null;
	const start = Number(comment.start ?? 0);
	const end = Number(comment.end ?? 0);
	if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
	return { path: comment.path, side: comment.side, start, end };
}

/**
 * 草稿排序 = 提交序（R11 消息里的编号顺序）：路径字典序 → 文件级在前 →
 * 行号升 → 行号相同按区间升 → old 在 new 前。列表渲染与提交编号同源，
 * 「看到的顺序 = 提交后的编号」。 */
export function sortComments(comments) {
	return [...comments].sort((a, b) => {
		if (a.path !== b.path) return a.path < b.path ? -1 : 1;
		const fa = a.side === "file" ? 0 : 1;
		const fb = b.side === "file" ? 0 : 1;
		if (fa !== fb) return fa - fb;
		if (a.start !== b.start) return a.start - b.start;
		if (a.end !== b.end) return a.end - b.end;
		const sa = a.side === "old" ? 0 : 1;
		const sb = b.side === "old" ? 0 : 1;
		return sa - sb;
	});
}

/** 草稿快照（提交序）；不暴露 Map 引用 —— 调用方拿到的数组可随意消费。 */
export function getComments() {
	return sortComments([...state.comments.values()]);
}

/** upsert 一份评论草稿（同锚覆盖）；非法锚被拒（no-op，不抛错）。 */
export function setComment(comment) {
	const anchor = normalizeAnchor(comment);
	if (!anchor) return;
	const next = new Map(state.comments);
	next.set(commentKey(anchor.path, anchor.side, anchor.start, anchor.end), {
		...anchor,
		text: String(comment.text ?? ""),
	});
	state.comments = next;
	state.draftsVersion += 1;
	notify();
}

/** 删除一份评论草稿（按锚）；锚不存在 → no-op（不通知）。 */
export function removeComment(comment) {
	const anchor = normalizeAnchor(comment);
	if (!anchor) return;
	const key = commentKey(anchor.path, anchor.side, anchor.start, anchor.end);
	if (!state.comments.has(key)) return;
	const next = new Map(state.comments);
	next.delete(key);
	state.comments = next;
	state.draftsVersion += 1;
	notify();
}

/** 某路径的草稿条数（navigator 每文件徽标的输入）。 */
export function commentCountForPath(path) {
	let n = 0;
	for (const c of state.comments.values()) {
		if (c.path === path) n += 1;
	}
	return n;
}

/** 评审摘要草稿（R10）。 */
export function getSummary() {
	return state.summary;
}

/**
 * 摘要写盘 —— **静默**（不通知）：摘要只被 navigator 本地输入框和提交读，另一
 * mount 无需因打字重渲染；草稿本身仍在模块级单例里活过 tab 卸载。
 */
export function setSummary(text) {
	state.summary = String(text ?? "");
	return state.summary;
}

/** 清全部草稿（评论 + 摘要；提交成功后调用）；无草稿可清 → no-op。 */
export function clearDrafts() {
	if (state.comments.size === 0 && state.summary === "") return;
	state.comments = new Map();
	state.summary = "";
	state.draftsVersion += 1;
	notify();
}

/* ------------------------------------------------------------------ */
/* R11 固定模板（agent 契约）—— 纯函数，逐字形态见 README                 */
/* ------------------------------------------------------------------ */

/** review.files 里某路径是否未跟踪（未跟踪注记的输入；无载荷 → false）。 */
export function isUntrackedFile(review, path) {
	const files = Array.isArray(review?.files) ? review.files : [];
	const file = files.find((f) => f?.path === path);
	return Array.isArray(file?.flags) && file.flags.includes("untracked");
}

/**
 * 评论块锚标签 = R11 消息契约形态（固定文本，中英不翻译 —— agent 契约）。
 *   单行          `<path>:<line> (new side)` / `<path>:<line> (old side)`
 *   区间          `<path>:<start>-<end> (side)`
 *   文件级        `<path> (file-level)`
 *   未跟踪注记    `<path> [untracked] …`（未跟踪文件无行锚定，实践中只出现在文件级）
 * 契约允许「无歧义的新侧评论省略侧注记」，本构建一律带侧注记（README 记录）。
 */
export function commentAnchorLabel(comment) {
	const path = String(comment?.path ?? "");
	const untracked = comment?.untracked === true ? " [untracked]" : "";
	if (comment?.side === "file") return `${path}${untracked} (file-level)`;
	const start = Number(comment?.start ?? 0);
	const end = Number(comment?.end ?? 0);
	const range = end > start ? `${start}-${end}` : `${start}`;
	const side = comment?.side === "old" ? "old side" : "new side";
	return `${path}${untracked}:${range} (${side})`;
}

/**
 * R11 提交消息组装（spec Open Questions 的 DECIDED 模板，逐字形态）——
 * 纯函数：sections = [范围头?，General?，Comments?]，节间一个空行，
 * 收尾句永远在最后一行。
 *
 * 省略规则：
 *   - 范围头在无变更（total 0 / 无载荷）时整个省略；
 *   - 「; includes uncommitted changes」只在 files 带 staged/unstaged/untracked 标记时带上；
 *   - 空摘要省 General 节；空评论省 Comments 节；
 *   - 计数 N/+A/−D 按载荷 files 求和（载荷截断时是已列文件的和，README 记录）。
 */
export function assembleReviewMessage({ review, summary, comments } = {}) {
	const list = sortComments(Array.isArray(comments) ? comments : []);
	const closing = "Please fix the raised comments and re-commit.";
	const sections = [];

	const files = Array.isArray(review?.files) ? review.files : [];
	const total = Number(review?.total ?? files.length ?? 0);
	if (review && total > 0) {
		const adds = files.reduce((sum, f) => sum + Number(f?.add ?? 0), 0);
		const dels = files.reduce((sum, f) => sum + Number(f?.del ?? 0), 0);
		const uncommitted = files.some((f) =>
			Array.isArray(f?.flags) && f.flags.some((k) => k === "staged" || k === "unstaged" || k === "untracked"));
		const ref = String(review?.base?.ref ?? "");
		const baseSha = String(review?.base?.sha ?? "");
		const headSha = String(review?.head?.sha ?? "");
		sections.push(
			`Code review (base ${ref}@${baseSha.slice(0, 7)} → HEAD@${headSha.slice(0, 7)}, ${total} files changed, +${adds}/−${dels}${uncommitted ? "; includes uncommitted changes" : ""})`,
		);
	}

	const summaryText = String(summary ?? "").trim();
	if (summaryText) sections.push(`General:\n${summaryText}`);

	if (list.length) {
		const blocks = list.map((c, i) =>
			`${i + 1}. ${commentAnchorLabel({ ...c, untracked: isUntrackedFile(review, c.path) })}: ${String(c.text ?? "").trim()}`);
		sections.push(`Comments:\n${blocks.join("\n")}`);
	}

	return [...sections, closing].join("\n\n");
}

/* ------------------------------------------------------------------ */
/* 剪贴板兜底（R11 compose=false 路径）                                  */
/* ------------------------------------------------------------------ */

/**
 * 复制到剪贴板：注入的 clipboard 优先（提交流的测试/宿主桥注入点），其次
 * navigator.clipboard，最后 DOM 临时 textarea + execCommand（无 clipboard 桥的
 * 环境）。全部失败返回 false（调用方给「手动复制」提示）。所有访问带环境守卫 ——
 * node --test 可直接 import（无 clipboard/document 时只是返回 false）。
 */
export async function copyToClipboard(text, clipboard = null) {
	const value = String(text ?? "");
	const tryWrite = async (impl) => {
		if (impl && typeof impl.writeText === "function") {
			await impl.writeText(value);
			return true;
		}
		return false;
	};
	try {
		if (await tryWrite(clipboard)) return true;
	} catch {
		/* fall through */
	}
	try {
		if (await tryWrite(globalThis.navigator?.clipboard)) return true;
	} catch {
		/* fall through */
	}
	try {
		const doc = globalThis.document;
		if (doc && typeof doc.createElement === "function" && typeof doc.execCommand === "function") {
			const box = doc.createElement("textarea");
			box.value = value;
			const parent = doc.body ?? doc.documentElement;
			if (parent && typeof parent.append === "function") {
				parent.append(box);
				box.select?.();
				const ok = doc.execCommand("copy");
				box.remove?.();
				return ok !== false;
			}
		}
	} catch {
		/* fall through */
	}
	return false;
}
