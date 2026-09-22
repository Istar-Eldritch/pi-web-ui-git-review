/**
 * comments.test.mjs —— 行评论 + 评审提交（Phase 4 / R9、R10、R11）的裸 ESM 测试，无 npm。
 *
 * 分层（navigator/viewer 套件同款模式）：
 *   1. store 草稿层：评论/摘要的模块级状态 API（锚定 key、排序、计数、静默摘要写），
 *      以及**固定模板**组装（R11 的 agent 契约 —— 文本逐字断言）；
 *   2. 提交流层（entry 装配的 submitter）：compose 桥投递、marker 推进、清草稿、
 *      compose=false 的剪贴板兜底、空内容/无基线守卫、无自动发送不变量
 *      （桥只被摸过 compose —— 用记录访问的 Proxy 断言，startChat/prompt 一次都不碰）；
 *   3. 视图层：navigator 头部摘要框 + 提交按钮、各 reason 的可见通知、每文件评论数
 *      徽标、草稿活过**模拟右栏 tab 卸载/重挂**（R9 模块级语义，SlotTabs 卸载）、
 *      提交成功后 marker 展示推进到 HEAD（fresh navigator 缺省 post-submit 范围）。
 *
 * viewer 侧的评论 UI（编辑器/列表/行标记/二进制文件级）在 test/viewer.test.mjs。
 *
 * 全局桩次序：假环境收口在 test/fake-env.mjs（三个套件共享同一份 —— 被同一进程
 * 加载，各装一份全局桩会互相打掉）。桩在任何被测模块装载之前安装。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* ------------------------------------------------------------------ */
/* 全局桩（先于被测模块；与 navigator/viewer 套件共享 —— 见 fake-env.mjs）  */
/* ------------------------------------------------------------------ */

import { collect, FakeDocument, FakeElement, installGlobalStubs, localStorageBag } from "./fake-env.mjs";
installGlobalStubs();

const store = await import("../client/store.mjs");
const navModule = await import("../client/navigator.mjs");
const viewerModule = await import("../client/viewer.mjs");
const entry = (await import("../client/entry.mjs")).default;
const submitModule = await import("../client/submit.mjs");
const i18n = await import("../client/i18n.mjs");

/* ------------------------------------------------------------------ */
/* 断言辅助                                                             */
/* ------------------------------------------------------------------ */

function rowsOf(root) {
	return collect(root, "gr-row").map((row) => ({ el: row, path: row.dataset.path, text: row.textContent }));
}

function badgesOf(root) {
	return collect(root, "gr-comment-badge").map((badge) => ({
		el: badge,
		text: badge.textContent,
		title: badge.getAttribute("title"),
		rowPath: badge.parentNode?.dataset?.path ?? null,
	}));
}

function noticesOf(root) {
	return collect(root, "gr-notice").map((notice) => ({
		el: notice,
		kind: notice.dataset.notice,
		text: notice.textContent,
	}));
}

function hotCellOf(row, side) {
	return collect(row.el, "gr-vg").find((cell) => cell.dataset.side === side);
}

function lineRowsOf(root) {
	return collect(root, "gr-vline").map((row) => ({
		el: row,
		type: row.dataset.type,
		old: row.dataset.old === undefined ? null : Number(row.dataset.old),
		new: row.dataset.new === undefined ? null : Number(row.dataset.new),
	}));
}

function assertEventually(check, message) {
	return (async () => {
		for (let attempt = 0; attempt < 60; attempt++) {
			if (check()) return;
			await new Promise((resolve) => setTimeout(resolve, 5));
		}
		assert.ok(check(), message);
	})();
}

/* ------------------------------------------------------------------ */
/* 桩服务端（Phase 1 路由契约形态 + **body 记录** —— marker POST 断言用）   */
/* ------------------------------------------------------------------ */

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "c".repeat(40);
const SHA_MARKER = "b".repeat(40);

const REVIEW_FILES = [
	{ path: "bin.dat", status: "M", add: 0, del: 0, flags: [] },
	{ path: "dir/new.txt", status: "R", oldPath: "dir/old.txt", add: 1, del: 0, flags: [] },
	{ path: "feature.txt", status: "A", add: 2, del: 0, flags: [] },
	{ path: "keep.txt", status: "M", add: 1, del: 1, flags: ["staged"] },
	{ path: "unstaged.txt", status: "M", add: 1, del: 1, flags: ["unstaged"] },
	{ path: "untracked.txt", status: "A", add: 0, del: 0, flags: ["untracked"] },
];

/**
 * 标准桩 + 可变 marker：POST /marker 更新 marker 变量、GET /marker 回它，
 * /review 的 base 按当前 marker 动态生成 —— 提交成功后 marker=HEAD、
 * fresh navigator 的基线展示 = post-submit 范围（R4/R11 闭环）。
 */
function markerRoutes(overrides = {}) {
	let marker = SHA_MARKER;
	const routes = {
		"/marker": (_query, body) => {
			if (body?.sha) {
				marker = body.sha;
				return { ok: true, sha: body.sha };
			}
			return { ok: true, sha: marker, repoRoot: "/repo" };
		},
		"/refs": { ok: true, refs: [{ name: "feature", current: true }, { name: "main", current: false }] },
		"/commits": { ok: true, commits: [{ sha: SHA_HEAD, shortSha: "c123456", author: "T", date: "2026-09-22", subject: "s" }] },
		"/resolve": { ok: true, ref: "x", sha: SHA_BASE },
		// /review base 按**当前 marker** 动态生成（真语义：marker = 评审基线提交）——
		// 提交成功 marker=HEAD 后，fresh navigator 的基线展示 = post-submit 范围。
		"/review": (_query, _body) => ({
			ok: true,
			base: { ref: "main", sha: marker, source: "marker" },
			head: { sha: SHA_HEAD },
			files: REVIEW_FILES,
			total: REVIEW_FILES.length,
			truncated: false,
		}),
		"/tree": { ok: true, files: ["feature.txt"], total: 1, truncated: false },
		// viewer 角色的 /diff 桩（草稿活过 tab 切换用例经 viewer 编辑器真实建评论）。
		"/diff": (query) => diffFixture(query.path),
		...overrides,
	};
	return { routes, get: () => marker };
}

/** feature.txt 的新文件 diff（两行 add；行号与 git diff 同源）—— 其余文件结构化报错。 */
function diffFixture(path) {
	if (path !== "feature.txt") return { ok: false, error: `no diff fixture: ${path}` };
	return {
		ok: true,
		path,
		base: { ref: "main", sha: SHA_MARKER, source: "marker" },
		head: { sha: SHA_HEAD },
		status: "A",
		binary: false,
		truncated: false,
		hunks: [
			{
				oldStart: 0,
				oldLines: 0,
				newStart: 1,
				newLines: 2,
				lines: [
					{ type: "add", old: null, new: 1, text: "first" },
					{ type: "add", old: null, new: 2, text: "second" },
				],
			},
		],
	};
}

/** 桩 fetch：与 viewer/navigator 套件同款路由匹配，另记录 **JSON body**（POST 断言）。 */
function createStubServer(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url, "http://stub.local");
		// 匹配 pathname 里**最后**一段 "/plugins-api/git-review/" 之后的部分（viewer 套件
		// 同款）—— entry 级挂载的 apiBase 由 import.meta.url 推导，前缀在测试进程里是
		// 任意目录，子串匹配兼容任意前缀。
		const all = parsed.pathname;
		const anchor = all.lastIndexOf("/plugins-api/git-review");
		const route = anchor >= 0 ? all.slice(anchor + "/plugins-api/git-review".length) : all;
		const query = Object.fromEntries(parsed.searchParams);
		let body = init?.body;
		if (typeof body === "string") {
			try {
				body = JSON.parse(body);
			} catch {
				/* 非 JSON body 原样保留 */
			}
		}
		calls.push({ method: init?.method ?? "GET", route, query, body });
		const respond = routes[route];
		if (!respond) {
			const payload = { ok: false, error: `no stub route: ${route}` };
			return { ok: false, status: 404, text: async () => JSON.stringify(payload) };
		}
		const payload = typeof respond === "function" ? await respond(query, body) : respond;
		return { ok: true, status: 200, text: async () => JSON.stringify(payload) };
	};
	return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ */
/* 共享状态复位 / 挂载辅助                                               */
/* ------------------------------------------------------------------ */

function resetStore() {
	store.setSelection(null);
	store.setState({ lastReview: null, selectedBase: null });
	store.setBaseOverride(null);
	store.setViewModes({ layout: "flat", scope: "changed" });
	store.clearDrafts(); // Phase 4：草稿也是共享进程里的模块级单例 —— 套件间卫生
	localStorageBag.clear();
}

/**
 * 挂载导航（真提交装配路径：不传 submitter —— navigator 用 entry 同款工厂兜底
 * 构建，fetch/clipboard 走注入点）。bridge 可选注入（window.__piWebUiHost）。
 */
// 不内含 resetStore：同用例内**重挂**（模拟 tab 卸载后回来）必须保留草稿 ——
// 复位由调用方在用例开始时做（共享进程卫生），重挂路径绝不复位。
async function mountNavigator(routes, { lang = "zh", bridge, clipboard } = {}) {
	const server = createStubServer(routes);
	const windowPrev = globalThis.window;
	// 桥**保留**到用例结束（提交流在按钮点击时才读 window）—— restoreWindow 由调用
	// 方在 finally 里调（共享进程卫生：window 桩不跨用例泄漏）。
	if (bridge !== undefined) globalThis.window = bridge ? { __piWebUiHost: bridge } : undefined;
	const view = navModule.createNavigator({
		document: new FakeDocument(),
		apiBase: "/plugins-api/git-review",
		fetchImpl: server.fetchImpl,
		lang,
		clipboard,
	});
	await view.refresh();
	return { view, server, restoreWindow: () => {
		globalThis.window = windowPrev;
	} };
}

/** R11 固定模板的提交流单元桩：window 桥 + fetch/clipboard 注入全走记录桩。 */
function submitterHarness({ composeResult = true, clipboardOk = true, markerThrows = false } = {}) {
	const composeCalls = [];
	const clipboardCalls = [];
	const windowPrev = globalThis.window;
	globalThis.window = {
		__piWebUiHost: {
			compose: (payload) => {
				composeCalls.push(payload);
				return composeResult;
			},
			onLocale: () => () => {},
		},
	};
	const markerCalls = [];
	const server = createStubServer({
		"/marker": (_query, body) => {
			markerCalls.push(body);
			if (markerThrows) throw new Error("marker boom");
			return { ok: true, sha: body?.sha ?? SHA_HEAD };
		},
	});
	const submitter = submitModule.createReviewSubmitter({
		apiBase: "/plugins-api/git-review",
		fetchImpl: server.fetchImpl,
		clipboard: clipboardOk
			? { writeText: async (t) => {
					clipboardCalls.push(t);
					return;
				} }
			: { writeText: async () => {
					throw new Error("clipboard dead");
				} },
	});
	return {
		submitter,
		server,
		composeCalls,
		clipboardCalls,
		markerCalls,
		restore() {
			globalThis.window = windowPrev;
		},
	};
}

/* ------------------------------------------------------------------ */
/* store 草稿层（R9/R10）                                                */
/* ------------------------------------------------------------------ */

describe("comment draft state (store, R9)", () => {
	it("setComment/getComments round-trips with message-order sorting; upsert edits in place; removeComment deletes", () => {
		resetStore();
		store.setComment({ path: "b.ts", side: "new", start: 4, end: 4, text: "line b" });
		store.setComment({ path: "a.ts", side: "old", start: 11, end: 11, text: "old a" });
		store.setComment({ path: "a.ts", side: "file", start: 0, end: 0, text: "file a" });
		store.setComment({ path: "a.ts", side: "new", start: 4, end: 11, text: "range a" });
		// 提交序：路径字典序 → 文件级在前 → 行号升 → old 在 new 前
		assert.deepEqual(store.getComments().map((c) => c.text), ["file a", "range a", "old a", "line b"]);
		assert.deepEqual(store.getComments()[0], { path: "a.ts", side: "file", start: 0, end: 0, text: "file a" });
		assert.deepEqual(store.getComments()[2], { path: "a.ts", side: "old", start: 11, end: 11, text: "old a" });

		// 重复锚（同 path/side/start/end）= 原位编辑（upsert，不新增）
		store.setComment({ path: "a.ts", side: "file", start: 0, end: 0, text: "file a (edited)" });
		assert.equal(store.getComments().length, 4);
		assert.deepEqual(store.getComments().map((c) => c.text), ["file a (edited)", "range a", "old a", "line b"]);

		// 删除
		store.removeComment({ path: "a.ts", side: "file", start: 0, end: 0 });
		assert.deepEqual(store.getComments().map((c) => c.text), ["range a", "old a", "line b"]);
		// 删除不存在的锚 → no-op（不抛错）
		assert.doesNotThrow(() => store.removeComment({ path: "ghost", side: "file", start: 0, end: 0 }));
		assert.equal(store.getComments().length, 3);
		// 非法锚被拒（side 非法 / path 空）
		assert.doesNotThrow(() => store.setComment({ path: "", side: "new", start: 1, end: 1, text: "x" }));
		assert.doesNotThrow(() => store.setComment({ path: "a.ts", side: "weird", start: 1, end: 1, text: "x" }));
		assert.equal(store.getComments().length, 3);
	});

	it("commentCountForPath counts per path (navigator badge input)", () => {
		resetStore();
		store.setComment({ path: "a.ts", side: "new", start: 1, end: 1, text: "1" });
		store.setComment({ path: "a.ts", side: "old", start: 2, end: 2, text: "2" });
		store.setComment({ path: "b.ts", side: "file", start: 0, end: 0, text: "3" });
		assert.equal(store.commentCountForPath("a.ts"), 2);
		assert.equal(store.commentCountForPath("b.ts"), 1);
		assert.equal(store.commentCountForPath("missing.ts"), 0);
	});

	it("setSummary/getSummary are silent writes; comment writes notify via draftsVersion; clearDrafts resets and notifies", () => {
		resetStore();
		let notifications = 0;
		const off = store.subscribe(() => {
			notifications += 1;
		});
		// R10 摘要：静默写盘（另一 mount 无需因打字重渲染）但进模块级草稿（活过 tab 卸载）
		store.setSummary("draft summary");
		assert.equal(store.getSummary(), "draft summary");
		assert.equal(notifications, 0);
		// 评论写：通知（viewer 的列表/行标记通道）+ draftsVersion 单调
		const v0 = store.getState().draftsVersion;
		store.setComment({ path: "a.ts", side: "new", start: 1, end: 1, text: "c" });
		assert.equal(notifications, 1);
		assert.equal(store.getState().draftsVersion, v0 + 1);
		store.setComment({ path: "b.ts", side: "new", start: 1, end: 1, text: "c2" });
		assert.equal(store.getState().draftsVersion, v0 + 2);
		// 清草稿：评论 + 摘要一起清、照发通知（前两次 setComment 已 2 次）
		store.clearDrafts();
		assert.equal(notifications, 3);
		assert.deepEqual(store.getComments(), []);
		assert.equal(store.getSummary(), "");
		off();
		// 无草稿可清 → no-op
		let more = 0;
		const off2 = store.subscribe(() => {
			more += 1;
		});
		store.clearDrafts();
		assert.equal(more, 0);
		off2();
	});
});

/* ------------------------------------------------------------------ */
/* R11 固定模板（agent 契约 —— 逐字断言）                                */
/* ------------------------------------------------------------------ */

describe("assembleReviewMessage (R11 fixed template)", () => {
	const REVIEW_OK = {
		ok: true,
		base: { ref: "main", sha: SHA_BASE, source: "marker" },
		head: { sha: SHA_HEAD },
		files: [
			{ path: "src/app.ts", status: "M", add: 3, del: 5, flags: [] },
			{ path: "keep.txt", status: "M", add: 2, del: 3, flags: ["staged"] },
			{ path: "unstaged.txt", status: "M", add: 4, del: 4, flags: ["unstaged"] },
			{ path: "bin.dat", status: "M", add: 0, del: 0, flags: [] },
			{ path: "untracked.txt", status: "A", add: 0, del: 0, flags: ["untracked"] },
		],
		total: 5,
		truncated: false,
	};

	it("assembles the exact fixed shape: range header with uncommitted note, General, numbered Comments, closing", () => {
		const message = store.assembleReviewMessage({
			review: REVIEW_OK,
			summary: "Timer logic needs a fix; naming follows repo convention.",
			comments: [
				{ path: "src/app.ts", side: "new", start: 4, end: 4, text: "fix this" },
				{ path: "src/app.ts", side: "new", start: 4, end: 11, text: "explain the range" },
				{ path: "src/app.ts", side: "old", start: 11, end: 11, text: "this deletion drops the check" },
				{ path: "src/app.ts", side: "file", start: 0, end: 0, text: "the module needs a rename" },
				{ path: "untracked.txt", side: "file", start: 0, end: 0, text: "please track this file" },
			],
		});
		const expected = [
			`Code review (base main@${SHA_BASE.slice(0, 7)} → HEAD@${SHA_HEAD.slice(0, 7)}, 5 files changed, +9/−12; includes uncommitted changes)`,
			"",
			"General:",
			"Timer logic needs a fix; naming follows repo convention.",
			"",
			"Comments:",
			"1. src/app.ts (file-level): the module needs a rename",
			"2. src/app.ts:4 (new side): fix this",
			"3. src/app.ts:4-11 (new side): explain the range",
			"4. src/app.ts:11 (old side): this deletion drops the check",
			"5. untracked.txt [untracked] (file-level): please track this file",
			"",
			"Please fix the raised comments and re-commit.",
		].join("\n");
		assert.equal(message, expected);
	});

	it("omits the range header when there are no changes (total 0), and the uncommitted note when all files are committed", () => {
		// 全部已提交（无 staged/unstaged/untracked 标记 —— 未跟踪也算未提交的工作树差异）
		const committed = {
			...REVIEW_OK,
			files: REVIEW_OK.files.map((f) => ({ ...f, flags: [] })),
		};
		const message = store.assembleReviewMessage({ review: committed, summary: "s", comments: [] });
		assert.equal(message.includes("includes uncommitted changes"), false);
		assert.ok(message.startsWith(`Code review (base main@${SHA_BASE.slice(0, 7)} → HEAD@${SHA_HEAD.slice(0, 7)}, 5 files changed, +9/−12)`));

		const noChanges = { ...REVIEW_OK, files: [], total: 0 };
		const empty = store.assembleReviewMessage({ review: noChanges, summary: "only a summary", comments: [] });
		assert.equal(empty, `General:\nonly a summary\n\nPlease fix the raised comments and re-commit.`);
	});

	it("omits empty General/Comments sections; everything empty → just the closing line", () => {
		const onlyComments = store.assembleReviewMessage({ review: REVIEW_OK, summary: "   ", comments: [{ path: "src/app.ts", side: "new", start: 4, end: 4, text: "c" }] });
		assert.equal(onlyComments.includes("General:"), false);
		assert.ok(onlyComments.startsWith(`Code review (base main@${SHA_BASE.slice(0, 7)}`));
		assert.ok(onlyComments.includes("Comments:\n1. src/app.ts:4 (new side): c"));

		const nothing = store.assembleReviewMessage({ review: null, summary: "", comments: [] });
		assert.equal(nothing, "Please fix the raised comments and re-commit.");
		// review 缺失 → 纯函数容忍（提交流有 no-review 守卫，不会走到这里）
		assert.equal(store.assembleReviewMessage({ review: REVIEW_OK, summary: "s", comments: null }).includes("Comments:"), false);
	});

	it("comment labels: single line, range, old side, file-level, untracked annotation", () => {
		assert.equal(store.commentAnchorLabel({ path: "a.ts", side: "new", start: 4, end: 4 }), "a.ts:4 (new side)");
		assert.equal(store.commentAnchorLabel({ path: "a.ts", side: "new", start: 4, end: 11 }), "a.ts:4-11 (new side)");
		assert.equal(store.commentAnchorLabel({ path: "a.ts", side: "old", start: 11, end: 11 }), "a.ts:11 (old side)");
		assert.equal(store.commentAnchorLabel({ path: "bin.dat", side: "file", start: 0, end: 0 }), "bin.dat (file-level)");
		assert.equal(store.commentAnchorLabel({ path: "u.txt", side: "file", start: 0, end: 0, untracked: true }), "u.txt [untracked] (file-level)");
		// 未跟踪注记由 review.files.flags 计算（R9：untracked 文件按契约标注）
		assert.equal(store.isUntrackedFile(REVIEW_OK, "untracked.txt"), true);
		assert.equal(store.isUntrackedFile(REVIEW_OK, "keep.txt"), false);
		assert.equal(store.isUntrackedFile(null, "untracked.txt"), false);
	});
});

/* ------------------------------------------------------------------ */
/* 提交流（entry 装配的 submitter，R11）                                 */
/* ------------------------------------------------------------------ */

describe("review submitter (entry wiring, R11)", () => {
	const REVIEW_OK = {
		ok: true,
		base: { ref: "main", sha: SHA_BASE, source: "marker" },
		head: { sha: SHA_HEAD },
		files: REVIEW_FILES,
		total: REVIEW_FILES.length,
		truncated: false,
	};
	const SUMMARY = "Overall: naming follows repo convention.";
	const COMMENTS = [
		{ path: "feature.txt", side: "new", start: 1, end: 2, text: "explain" },
		{ path: "untracked.txt", side: "file", start: 0, end: 0, text: "please track this file" },
	];
	const EXPECTED = [
		`Code review (base main@${SHA_BASE.slice(0, 7)} → HEAD@${SHA_HEAD.slice(0, 7)}, 6 files changed, +5/−2; includes uncommitted changes)`,
		"",
		"General:",
		SUMMARY,
		"",
		"Comments:",
		"1. feature.txt:1-2 (new side): explain",
		"2. untracked.txt [untracked] (file-level): please track this file",
		"",
		"Please fix the raised comments and re-commit.",
	].join("\n");

	it("submit success: compose called once with the exact message; marker POSTed with the /review head; drafts cleared; clipboard untouched", async () => {
		const harness = submitterHarness();
		try {
			store.setSummary(SUMMARY);
			store.setComment({ ...COMMENTS[0] });
			store.setComment({ ...COMMENTS[1] });
			const result = await harness.submitter.submit({ review: REVIEW_OK, summary: store.getSummary(), comments: store.getComments() });
			assert.deepEqual(result, { ok: true, text: EXPECTED, markerAdvanced: true });
			// 桥投递：一次、只带 {text}（合并语义见 README —— 绝不读改既有草稿）
			assert.equal(harness.composeCalls.length, 1);
			assert.deepEqual(Object.keys(harness.composeCalls[0]), ["text"]);
			assert.equal(harness.composeCalls[0].text, EXPECTED);
			// marker 推进：POST /marker body.sha = /review 解析的 head.sha（R4/R11）
			assert.deepEqual(harness.markerCalls, [{ sha: SHA_HEAD }]);
			// 成功路径不走剪贴板兜底
			assert.deepEqual(harness.clipboardCalls, []);
			// 草稿清空（成功路径）
			assert.deepEqual(store.getComments(), []);
			assert.equal(store.getSummary(), "");
		} finally {
			harness.restore();
			resetStore();
		}
	});

	it("no-auto-send invariant: the bridge is touched only for compose/onLocale — never startChat/prompt/send", async () => {
		const touched = [];
		const base = {
			onLocale: () => () => {},
			compose: (payload) => {
				compose_calls.push(payload);
				return true;
			},
		};
		const compose_calls = [];
		const bridge = new Proxy(base, {
			get(target, prop) {
				touched.push(String(prop));
				return target[prop];
			},
		});
		const windowPrev = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge };
		try {
			const submitter = submitModule.createReviewSubmitter({
				apiBase: "/plugins-api/git-review",
				fetchImpl: async () => ({ ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sha: SHA_HEAD }) }),
			});
			const result = await submitter.submit({ review: REVIEW_OK, summary: SUMMARY, comments: COMMENTS });
			assert.equal(result.ok, true);
			assert.deepEqual(store.getComments(), []);
			// startChat / prompt（自动发送路）一次都没被触碰 —— 触摸即 undefined 调用会抛
			assert.deepEqual(touched.filter((p) => p === "startChat" || p === "prompt" || p === "send"), []);
			assert.ok(touched.includes("compose"));
			assert.deepEqual(compose_calls.map((c) => Object.keys(c)), [["text"]]);
		} finally {
			globalThis.window = windowPrev;
			resetStore();
		}
	});

	it("marker POST failure → ok:true with markerAdvanced:false (delivery kept, honestly reported)", async () => {
		const windowPrev = globalThis.window;
		globalThis.window = { __piWebUiHost: { compose: () => true } };
		try {
			store.setSummary(SUMMARY);
			store.setComment({ ...COMMENTS[0] });
			const submitter = submitModule.createReviewSubmitter({
				apiBase: "/plugins-api/git-review",
				// /marker 返回 200 + {ok:false}（R13 阶梯）—— 推进失败必须如实上报
				fetchImpl: async (url) => {
					if (String(url).includes("/marker")) {
						return { ok: true, status: 200, text: async () => JSON.stringify({ ok: false, error: "storage denied" }) };
					}
					return { ok: true, status: 200, text: async () => JSON.stringify({ ok: true, sha: SHA_HEAD }) };
				},
			});
			const result = await submitter.submit({ review: REVIEW_OK, summary: SUMMARY, comments: store.getComments() });
			assert.equal(result.ok, true);
			assert.equal(result.markerAdvanced, false);
			// 投递不回滚：草稿已清、消息已交
			assert.deepEqual(store.getComments(), []);
		} finally {
			globalThis.window = windowPrev;
			resetStore();
		}
	});

	it("compose false → automatic clipboard copy of the assembled message; drafts kept; marker not advanced", async () => {
		const harness = submitterHarness({ composeResult: false, clipboardOk: true });
		try {
			store.setSummary(SUMMARY);
			store.setComment({ ...COMMENTS[0] });
			store.setComment({ ...COMMENTS[1] });
			const result = await harness.submitter.submit({ review: REVIEW_OK, summary: SUMMARY, comments: store.getComments() });
			assert.equal(result.ok, false);
			assert.equal(result.reason, "compose-false");
			assert.equal(result.text, EXPECTED);
			// 剪贴板兜底：组装文本进剪贴板
			assert.deepEqual(harness.clipboardCalls, [EXPECTED]);
			assert.equal(harness.composeCalls.length, 1);
			// 投递失败 → 草稿保留（用户还有这份评审）、marker 不推进
			assert.equal(store.getComments().length, 2);
			assert.equal(store.getSummary(), SUMMARY);
			assert.deepEqual(harness.markerCalls, []);
		} finally {
			harness.restore();
			resetStore();
		}
	});

	it("clipboard dead → reason clipboard-failed (caller shows the manual-copy fallback)", async () => {
		const harness = submitterHarness({ composeResult: false, clipboardOk: false });
		try {
			const result = await harness.submitter.submit({ review: REVIEW_OK, summary: SUMMARY, comments: COMMENTS });
			assert.equal(result.ok, false);
			assert.equal(result.reason, "clipboard-failed");
			assert.deepEqual(harness.markerCalls, []);
		} finally {
			harness.restore();
			resetStore();
		}
	});

	it("marker POST failure does not fail the delivery: result ok, drafts still cleared", async () => {
		const harness = submitterHarness({ markerThrows: true });
		try {
			store.setComment({ ...COMMENTS[0] });
			const result = await harness.submitter.submit({ review: REVIEW_OK, summary: "", comments: store.getComments() });
			assert.equal(result.ok, true);
			assert.deepEqual(store.getComments(), []); // 投递已成功；推进失败不回滚草稿
		} finally {
			harness.restore();
			resetStore();
		}
	});

	it("guards: empty content → empty; no review payload → no-review (order: empty wins); bridge missing → compose-false", async () => {
		const harness = submitterHarness();
		try {
			// 全空（无评论 + 空摘要）→ empty（比 no-review 先断）
			let result = await harness.submitter.submit({ review: null, summary: "", comments: [] });
			assert.deepEqual({ ok: result.ok, reason: result.reason }, { ok: false, reason: "empty" });
			// 有内容但无基线载荷 → no-review
			result = await harness.submitter.submit({ review: null, summary: SUMMARY, comments: COMMENTS });
			assert.equal(result.reason, "no-review");
			assert.equal(harness.composeCalls.length, 0);
			assert.deepEqual(harness.markerCalls, []);
			// 桥缺失（无 window / 无 compose）→ 当 false 处理（剪贴板兜底），绝不静默丢
			harness.restore();
			delete globalThis.window;
			result = await harness.submitter.submit({ review: REVIEW_OK, summary: SUMMARY, comments: COMMENTS });
			assert.equal(result.reason, "compose-false");
			assert.deepEqual(harness.clipboardCalls, [EXPECTED]);
		} finally {
			harness.restore();
			resetStore();
		}
	});
});

/* ------------------------------------------------------------------ */
/* 视图层：navigator 摘要 + 提交 + 徽标 + 通知                            */
/* ------------------------------------------------------------------ */

describe("navigator summary field + submit button (R10/R11)", () => {
	it("summary textarea exists in the header; typing writes the store draft silently; remount restores it", async () => {
		resetStore();
		const first = await mountNavigator(markerRoutes().routes);
		try {
			const input = collect(first.view.root, "gr-summary-input")[0];
			assert.ok(input, "navigator header must render the summary field");
			assert.equal(input.value, "");
			input.value = "typed before the tab switch";
			input.dispatch("input", {});
			assert.equal(store.getSummary(), "typed before the tab switch");

			// 静默写盘：订阅 spy 不触发（另一 mount 不因打字重渲染）
			let notifications = 0;
			const off = store.subscribe(() => {
				notifications += 1;
			});
			input.value = "typed again";
			input.dispatch("input", {});
			assert.equal(store.getSummary(), "typed again");
			assert.equal(notifications, 0);
			off();

			// 模拟 tab 卸载重挂：textarea 从 store 草稿恢复（R10 草稿活过 tab 卸载）
			first.view.destroy();
			// 重挂不复位（同用例内的 tab 切换语义）：摘要草稿原样恢复
			const second = await mountNavigator(markerRoutes().routes);
			assert.equal(collect(second.view.root, "gr-summary-input")[0].value, "typed again");
			second.view.destroy();
		} finally {
			first.view.destroy();
			first.restoreWindow();
			resetStore();
		}
	});

	it("per-file comment count badge on navigator rows (R9)", async () => {
		resetStore();
		const { view, restoreWindow } = await mountNavigator(markerRoutes().routes);
		try {
			assert.deepEqual(badgesOf(view.root), []);
			store.setComment({ path: "feature.txt", side: "new", start: 1, end: 1, text: "a" });
			store.setComment({ path: "feature.txt", side: "old", start: 3, end: 3, text: "b" });
			store.setComment({ path: "keep.txt", side: "file", start: 0, end: 0, text: "c" });
			const badges = badgesOf(view.root);
			assert.deepEqual(badges.map((badge) => badge.text), ["💬2", "💬1"]);
			assert.deepEqual(badges.map((badge) => badge.rowPath), ["feature.txt", "keep.txt"]);
			assert.equal(badges[0].title, "2 条评论草稿");
			// 删除一条草稿 → 徽标计数同步减一（feature 还剩 old 侧那条）
			store.removeComment({ path: "feature.txt", side: "new", start: 1, end: 1 });
			assert.deepEqual(badgesOf(view.root).map((badge) => ({ text: badge.text, rowPath: badge.rowPath })), [
				{ text: "💬1", rowPath: "feature.txt" },
				{ text: "💬1", rowPath: "keep.txt" },
			]);
		} finally {
			view.destroy();
			restoreWindow();
			resetStore();
		}
	});

	it("pins navigator submit strings in both languages (R12)", () => {
		assert.equal(i18n.t("zh", "nav.summary.label"), "评审摘要");
		assert.equal(i18n.t("en", "nav.summary.label"), "Review summary");
		assert.equal(i18n.t("zh", "nav.submit"), "提交评审");
		assert.equal(i18n.t("en", "nav.submit"), "Submit review");
		assert.ok(i18n.t("zh", "nav.submit.done").includes("标记"));
		assert.ok(i18n.t("en", "nav.submit.done").includes("marker"));
		assert.ok(i18n.t("zh", "nav.submit.fallback").includes("剪贴板"));
		assert.ok(i18n.t("en", "nav.submit.fallback").includes("clipboard"));
		assert.ok(i18n.t("zh", "nav.submit.clipboardFailed").includes("剪贴板不可用"));
		assert.ok(i18n.t("en", "nav.submit.clipboardFailed").includes("clipboard is unavailable"));
		assert.equal(i18n.t("zh", "nav.commentBadge.title", { n: 2 }), "2 条评论草稿");
		assert.equal(i18n.t("en", "nav.commentBadge.title", { n: 2 }), "2 comment drafts");
	});
});

describe("navigator submit flow (R11)", () => {
	function bridgeSpy(composeResult) {
		const composeCalls = [];
		return {
			composeCalls,
			bridge: {
				compose: (payload) => {
					composeCalls.push(payload);
					return composeResult;
				},
				onLocale: () => () => {},
			},
		};
	}

	it("submit success: done notice, marker display advances to HEAD (fresh navigator defaults to post-submit range), drafts cleared", async () => {
		resetStore();
		const spy = bridgeSpy(true);
		const box = markerRoutes();
		const clipboardCalls = [];
		// 基线 = 当前 marker（桩 /review base 动态生成）→ 提交前头部是 marker 短哈希
		const { view, server, restoreWindow } = await mountNavigator(box.routes, {
			bridge: spy.bridge,
			clipboard: { writeText: async (t) => {
				clipboardCalls.push(t);
				return;
			} },
		});
		try {
			// 会话内基线覆盖（picker 之前选过 dev）—— marker 推进成功后必须失效
			store.setBaseOverride({ ref: "dev", source: "branch" });
			// 写草稿（viewer 编辑器保存后的 store 形态）
			store.setSummary("Overall: the naming follows repo convention.");
			store.setComment({ path: "feature.txt", side: "new", start: 1, end: 2, text: "explain" });
			store.setComment({ path: "untracked.txt", side: "file", start: 0, end: 0, text: "please track this file" });

			view.model.els.submitBtn.click();
			// 等待**整条链**收尾（compose → marker POST → 清草稿），不是只等 compose ——
			// compose 调用与 clearDrafts 之间隔着 marker fetch 的 await（轮询早到会假挂）。
			await assertEventually(
				() => spy.composeCalls.length === 1 && store.getComments().length === 0 && store.getSummary() === "",
				"submit must deliver, advance the marker and clear drafts",
			);
			const expected = [
				`Code review (base main@${SHA_MARKER.slice(0, 7)} → HEAD@${SHA_HEAD.slice(0, 7)}, 6 files changed, +5/−2; includes uncommitted changes)`,
				"",
				"General:",
				"Overall: the naming follows repo convention.",
				"",
				"Comments:",
				"1. feature.txt:1-2 (new side): explain",
				"2. untracked.txt [untracked] (file-level): please track this file",
				"",
				"Please fix the raised comments and re-commit.",
			].join("\n");
			assert.equal(spy.composeCalls[0].text, expected);
			// marker 推进：POST body = /review 解析的 head（桩 /marker 动态更新）
			const post = server.calls.find((call) => call.method === "POST" && call.route === "/marker");
			assert.ok(post, "submit must POST the marker");
			assert.deepEqual(post.body, { sha: SHA_HEAD });
			assert.equal(box.get(), SHA_HEAD);
			// 草稿清空 + 成功通知
			assert.deepEqual(store.getComments(), []);
			assert.equal(store.getSummary(), "");
			assert.ok(noticesOf(view.root).some((notice) => notice.kind === "done"));
			// marker 推进成功 → 会话内覆盖立即失效（post-submit 刷新直接落 marker 范围，
			// 同一批文件不被重复列出、重复可评）
			assert.equal(store.getState().baseOverride, null);
			// 基线展示推进到提交后的 marker（桩 /review base=marker → main@c123456）——
			// fresh navigator 缺省 = post-submit 范围（R4/R11 闭环）
			await assertEventually(
				() => collect(view.root, "gr-baseref").some((el) => el.textContent.includes(SHA_HEAD.slice(0, 7))),
				"the base row must display the advanced marker",
			);
			// 成功路径不触碰剪贴板
			assert.deepEqual(clipboardCalls, []);
		} finally {
			view.destroy();
			restoreWindow();
			resetStore();
		}
	});

	it("compose false → fallback notice (copied) + copy button; drafts and marker untouched", async () => {
		resetStore();
		const spy = bridgeSpy(false);
		const box = markerRoutes();
		const clipboardCalls = [];
		const { view, server, restoreWindow } = await mountNavigator(box.routes, {
			bridge: spy.bridge,
			clipboard: { writeText: async (t) => {
				clipboardCalls.push(t);
				return;
			} },
		});
		try {
			store.setSummary("summary text");
			store.setComment({ path: "feature.txt", side: "new", start: 1, end: 1, text: "fallback me" });
			const markerBefore = box.get();

			view.model.els.submitBtn.click();
			await assertEventually(() => noticesOf(view.root).length > 0);
			const notice = noticesOf(view.root)[0];
			assert.equal(notice.kind, "fallback");
			assert.ok(notice.text.includes("已复制到剪贴板"));
			// 自动兜底复制成功
			assert.equal(clipboardCalls.length, 1);
			assert.ok(clipboardCalls[0].includes("fallback me"));
			// 手动兜底按钮可再复制
			const before = clipboardCalls.length;
			collect(notice.el, "gr-notice-copy")[0].click();
			await assertEventually(() => clipboardCalls.length === before + 1);
			// 投递失败 → 草稿保留、marker 不推进、无 POST
			assert.deepEqual(store.getComments().map((c) => c.text), ["fallback me"]);
			assert.equal(store.getSummary(), "summary text");
			assert.equal(box.get(), markerBefore);
			assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
		} finally {
			view.destroy();
			restoreWindow();
			resetStore();
		}
	});

	it("clipboard dead → clipboardFailed notice with the assembled text visible for manual copying", async () => {
		resetStore();
		const spy = bridgeSpy(false);
		const { view, restoreWindow } = await mountNavigator(markerRoutes().routes, {
			bridge: spy.bridge,
			clipboard: { writeText: async () => {
				throw new Error("clipboard dead");
			} },
		});
		try {
			store.setComment({ path: "feature.txt", side: "new", start: 1, end: 1, text: "manual copy" });
			view.model.els.submitBtn.click();
			await assertEventually(() => noticesOf(view.root).length > 0);
			const notice = noticesOf(view.root)[0];
			assert.equal(notice.kind, "clipboardFailed");
			assert.ok(notice.text.includes("剪贴板不可用"));
			// 组装文本可见（手动复制）；兜底按钮仍在（剪贴板可能恢复）
			assert.ok(collect(notice.el, "gr-notice-message").some((node) => node.textContent.includes("Please fix the raised comments and re-commit.")));
			assert.equal(collect(notice.el, "gr-notice-copy").length, 1);
			assert.deepEqual(store.getComments().map((c) => c.text), ["manual copy"]);
		} finally {
			view.destroy();
			restoreWindow();
			resetStore();
		}
	});

	it("guards surface as notices: review error → noReview; empty drafts → empty; neither reaches compose", async () => {
		resetStore();
		const spy = bridgeSpy(true);
		const box = markerRoutes({ "/review": { ok: false, error: "git command failed" } });
		const { view, server, restoreWindow } = await mountNavigator(box.routes, { bridge: spy.bridge });
		try {
			// 摘要框 + 提交按钮在任何状态都在（守卫给可见通知，不是隐藏入口）
			assert.ok(collect(view.root, "gr-summary-input")[0]);
			// 评审出错 + 有内容 → noReview（全空则 empty 先断 —— 守卫顺序，第二 mount 验证）
			store.setSummary("content for the guard");
			view.model.els.submitBtn.click();
			await assertEventually(() => noticesOf(view.root).length > 0);
			assert.equal(noticesOf(view.root)[0].kind, "noReview");
			assert.equal(spy.composeCalls.length, 0);
		} finally {
			view.destroy();
			restoreWindow();
			resetStore();
		}

		// 全空（评审就绪 + 无草稿）→ empty 通知（重挂不复位：本用例本就无草稿）
		const second = await mountNavigator(markerRoutes().routes, { bridge: spy.bridge });
		try {
			second.view.model.els.submitBtn.click();
			await assertEventually(() => noticesOf(second.view.root).length > 0);
			assert.equal(noticesOf(second.view.root)[0].kind, "empty");
			assert.equal(spy.composeCalls.length, 0);
			// 两条守卫路径都没有 marker POST
			assert.equal(server.calls.filter((call) => call.method === "POST").length, 0);
		} finally {
			second.view.destroy();
			second.restoreWindow();
			resetStore();
		}
	});
});

/* ------------------------------------------------------------------ */
/* entry 级装配 + 草稿活过模拟 tab 切换（R9/R15）                         */
/* ------------------------------------------------------------------ */

describe("draft survival across simulated tab switches (entry-level, R9)", () => {
	it("comment made through the viewer editor survives unmounting BOTH roles and remounting the navigator", async () => {
		resetStore();
		const box = markerRoutes();
		const server = createStubServer(box.routes);
		const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		delete globalThis.window; // 桥缺失（占位环境；提交流不在本用例）
		try {
			// 双角色挂载（R15：navigator + viewer 同 bundle）
			const navHost = new FakeElement("div");
			navHost.classList.add("plugin-page-host");
			const viewHost = new FakeElement("div");
			const cleanupNav = entry.mount(navHost, {});
			const cleanupView = entry.mount(viewHost, {});
			await assertEventually(() => collect(navHost, "gr-row").length === REVIEW_FILES.length, "navigator rows must render");
			await assertEventually(() => collect(viewHost, "gr-vroot").length === 1, "viewer role must render");

			// viewer 编辑器里真实建评论：选中 → 输入 → 保存
			store.setSelection({ path: "feature.txt", base: "main" });
			await assertEventually(() => lineRowsOf(viewHost).length === 2, "viewer must render the selected file");
			hotCellOf(lineRowsOf(viewHost)[0], "new").click();
			const editor = collect(viewHost, "gr-veditor")[0];
			assert.ok(editor, "selection must open the editor");
			const input = collect(editor, "gr-veditor-input")[0];
			input.value = "made through the editor";
			input.dispatch("input", {});
			collect(editor, "gr-veditor-save")[0].click();
			assert.deepEqual(store.getComments().map((c) => c.text), ["made through the editor"]);

			// 模拟宿主 tab 切换：两个角色都卸载
			cleanupNav();
			cleanupView();
			assert.equal(navHost.childNodes.length, 0);
			assert.equal(viewHost.childNodes.length, 0);
			assert.equal(store.getComments().length, 1); // 草稿在模块级 store，卸载不掉

			// 重挂 navigator（fresh 角色上下文）：徽标原样可见
			const navHost2 = new FakeElement("div");
			navHost2.classList.add("plugin-page-host");
			const cleanupNav2 = entry.mount(navHost2, {});
			await assertEventually(() => collect(navHost2, "gr-row").length === REVIEW_FILES.length, "fresh navigator rows must render");
			const badge = badgesOf(navHost2).find((b) => b.text === "💬1");
			assert.ok(badge, "fresh navigator must show the comment badge");
			assert.equal(badge.rowPath, "feature.txt");

			// 重挂 viewer：评论列表原样渲染（草稿活过卸载，R9 模块级语义）
			const viewHost2 = new FakeElement("div");
			const cleanupView2 = entry.mount(viewHost2, {});
			await assertEventually(() => collect(viewHost2, "gr-vcomment").length === 1, "fresh viewer must render the comment list");
			assert.deepEqual(collect(viewHost2, "gr-vcomment-text").map((node) => node.textContent), ["made through the editor"]);

			cleanupNav2();
			cleanupView2();
			assert.equal(navHost2.childNodes.length, 0);
			assert.equal(viewHost2.childNodes.length, 0);
		} finally {
			globalThis.fetch = previous.fetch;
			globalThis.document = previous.document;
			globalThis.window = previous.window;
			resetStore();
		}
	});

	it("entry wiring (navigator role): the submit button drives entry's submitter through global fetch", async () => {
		resetStore();
		const box = markerRoutes();
		const server = createStubServer(box.routes);
		const previous = { fetch: globalThis.fetch, document: globalThis.document, window: globalThis.window };
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		const composeCalls = [];
		globalThis.window = { __piWebUiHost: { compose: (payload) => {
			composeCalls.push(payload);
			return true;
		}, onLocale: () => () => {} } };
		try {
			const host = new FakeElement("div");
			host.classList.add("plugin-page-host");
			const cleanup = entry.mount(host, {});
			await assertEventually(() => collect(host, "gr-row").length === REVIEW_FILES.length, "navigator rows must render");
			store.setSummary("entry-level wiring");
			store.setComment({ path: "feature.txt", side: "new", start: 1, end: 1, text: "wired" });
			collect(host, "gr-submit")[0].click();
			// 等待整条链收尾（compose → marker POST → 清草稿）—— 同 submit success 的理由
			await assertEventually(
				() => composeCalls.length === 1 && store.getComments().length === 0,
				"submit must deliver through the bridge and clear drafts",
			);
			assert.ok(composeCalls[0].text.includes("entry-level wiring"));
			assert.ok(composeCalls[0].text.includes("1. feature.txt:1 (new side): wired"));
			const post = server.calls.find((call) => call.method === "POST" && call.route === "/marker");
			assert.ok(post && post.body?.sha === SHA_HEAD, "entry-level submit must advance the marker");
			assert.deepEqual(store.getComments(), []);
			cleanup();
			assert.equal(host.childNodes.length, 0);
		} finally {
			globalThis.fetch = previous.fetch;
			globalThis.document = previous.document;
			globalThis.window = previous.window;
			resetStore();
		}
	});
});
