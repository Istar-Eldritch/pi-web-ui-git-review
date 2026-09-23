/**
 * viewer.test.mjs —— 主区 diff 查看器（Phase 3 / R7、R8、R15）的裸 ESM 测试，无 npm。
 *
 * 两个层次（navigator.test.mjs 同款模式）：
 *   1. 纯函数层：折叠空隙计算、行模型（经 Phase 1 parseUnifiedDiff 取行号 ——
 *      fixture 一律是**真实统一 diff 文本**，行号与 git 输出同源）、展示归类、
 *      行命中模型的归类逻辑直接断言；
 *   2. 整个视图用**极小假 DOM** + 桩 fetch 服务端（Phase 1 /diff 契约形态）驱动：
 *      各文件形态（修改/新增/删除/改名/二进制/截断/未跟踪/范围外）的正确表示、
 *      gutter 行号与 git diff 语义一致、hunk 头、折叠展开/收拢（context 参数）、
 *      选中模型（单行/延伸/收拢/取消、old vs new 侧、shift/第二次点击）、store
 *      驱动的重拉（选中/基线变化，无关写入跳过）、entry 级双角色渲染与清理对称。
 *
 * 全局桩次序：假环境收口在 test/fake-env.mjs（与 navigator 套件共享同一份 ——
 * 两个套件被 test/index.js import 进**同一进程**，各装一份全局桩会互相打掉，
 * 正是「单独跑全绿、全量跑必挂」的跨套件污染）。桩在任何被测模块装载之前
 * 安装（store 的持久化每次调用时再判 localStorage，装好即对后续行为生效）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* ------------------------------------------------------------------ */
/* 全局桩（先于被测模块；与 navigator 套件共享 —— 见 fake-env.mjs 头注释）  */
/* ------------------------------------------------------------------ */

import { collect, FakeDocument, FakeElement, installGlobalStubs, localStorageBag } from "./fake-env.mjs";
installGlobalStubs();

const store = await import("../client/store.mjs");
const viewerModule = await import("../client/viewer.mjs");
const entry = (await import("../client/entry.mjs")).default; // R1 宿主契约：client 入口是 `export default { mount(el, ctx) }`
const navModule = await import("../client/navigator.mjs");
const i18n = await import("../client/i18n.mjs");
const gitcore = await import("../client/gitcore.mjs");
// R18 预览助手住在服务端入口（gitcore 尾注：不进共享模块，避免 reload 缓存坑）
const { previewHunks } = await import("../index.mjs");
const { parseUnifiedDiff } = gitcore;

/* ------------------------------------------------------------------ */
/* 断言辅助（假 DOM 与 collect 来自 fake-env.mjs）                        */
/* ------------------------------------------------------------------ */

/** 渲染出的逐行行（行序 = 构建序；gutter 文本取自 dataset）。 */
function lineRowsOf(root) {
	return collect(root, "gr-vline").map((row) => ({
		el: row,
		type: row.dataset.type,
		old: row.dataset.old === undefined ? null : Number(row.dataset.old),
		new: row.dataset.new === undefined ? null : Number(row.dataset.new),
		text: collect(row, "gr-vcontent")[0]?.textContent ?? "",
	}));
}

function foldRowsOf(root) {
	return collect(root, "gr-vfold").map((fold) => ({ el: fold, gap: fold.dataset.gap, text: fold.textContent }));
}

function stateBoxesOf(root) {
	return collect(root, "gr-vstate").map((box) => box.textContent);
}

function notesOf(root) {
	return collect(root, "gr-vnote").map((note) => note.textContent);
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

const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 桩服务端（Phase 1 /diff 契约形态 + entry 级标准路由）                  */
/* ------------------------------------------------------------------ */

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "c".repeat(40);
const SHA_MARKER = "b".repeat(40);

const REVIEW_FILES = [
	{ path: "big.log", status: "M", add: 1, del: 1, flags: [] },
	{ path: "bin.dat", status: "M", add: 0, del: 0, flags: [] },
	{ path: "feature.txt", status: "A", add: 2, del: 0, flags: [] },
	{ path: "gone.txt", status: "D", add: 0, del: 2, flags: [] },
	{ path: "main.txt", status: "M", add: 1, del: 1, flags: [] },
	{ path: "renamed/new.txt", status: "R", oldPath: "renamed/old.txt", add: 1, del: 1, flags: [] },
	{ path: "src/app.ts", status: "M", add: 3, del: 2, flags: [] },
	{ path: "untracked.txt", status: "A", add: 0, del: 0, flags: ["untracked"] },
];

function standardRoutes() {
	return {
		"/marker": { ok: true, sha: SHA_MARKER, repoRoot: "/repo" },
		"/refs": { ok: true, refs: [{ name: "feature", current: true }, { name: "main", current: false }] },
		"/commits": { ok: true, commits: [{ sha: SHA_HEAD, shortSha: "c123456", author: "T", date: "2026-09-22", subject: "s" }] },
		"/resolve": { ok: true, ref: "x", sha: SHA_BASE },
		"/review": {
			ok: true,
			base: { ref: "main", sha: SHA_BASE, source: "marker" },
			head: { sha: SHA_HEAD },
			files: REVIEW_FILES,
			total: REVIEW_FILES.length,
			truncated: false,
		},
		"/tree": { ok: true, files: ["src/app.ts"], total: 1, truncated: false },
	};
}

/**
 * 结构化 /diff 载荷由**真实统一 diff fixture 文本**经 Phase 1 parser 生成
 * （行号与 git 输出同源，不手写 payload）。
 */
function payloadFromPatch(patchText, path, overrides = {}) {
	const parsed = parseUnifiedDiff(patchText);
	return {
		ok: true,
		path,
		base: { ref: "main", sha: SHA_BASE, source: "marker" },
		head: { sha: SHA_HEAD },
		...(parsed.status !== null ? { status: parsed.status } : {}),
		...(parsed.oldPath !== null ? { oldPath: parsed.oldPath } : {}),
		binary: parsed.binary,
		truncated: false,
		hunks: parsed.hunks,
		...overrides,
	};
}

/* fixture：修改（两 hunk，hunk1 旧 1..3 / hunk2 旧 10..12 → 空隙 old 4..9 共 6 行） */
const MODIFIED_PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..2222222 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,3 +1,4 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 20;",
	"+",
	" const c = 3;",
	"@@ -10,3 +11,4 @@ function f() {",
	"   keep1",
	"-  gone",
	"   keep2",
	"+  added",
].join("\n");

/* fixture：context=24 的更宽补丁（空隙完全闭合、两 hunk 合并；旧行 1..16 新行 1..17） */
const WIDE_PATCH = [
	"diff --git a/src/app.ts b/src/app.ts",
	"index 1111111..2222222 100644",
	"--- a/src/app.ts",
	"+++ b/src/app.ts",
	"@@ -1,16 +1,17 @@",
	" const a = 1;",
	"-const b = 2;",
	"+const b = 20;",
	"+",
	" const c = 3;",
	" const d = 4;",
	" const e = 5;",
	" const f = 6;",
	" const g = 7;",
	" const h = 8;",
	" const i = 9;",
	" const j = 10;",
	"   keep1",
	"-  gone",
	"   keep2",
	"+  added",
	" const k = 11;",
	" const l = 12;",
	" const m = 13;",
].join("\n");

/* fixture：特例形态（Phase 1 parser 测试同源的文本） */
const NEW_FILE_PATCH = [
	"diff --git a/feature.txt b/feature.txt",
	"new file mode 100644",
	"index 0000000..3333333",
	"--- /dev/null",
	"+++ b/feature.txt",
	"@@ -0,0 +1,2 @@",
	"+first",
	"+second",
].join("\n");

const DELETED_PATCH = [
	"diff --git a/gone.txt b/gone.txt",
	"deleted file mode 100644",
	"index 4444444..0000000",
	"--- a/gone.txt",
	"+++ /dev/null",
	"@@ -1,2 +0,0 @@",
	"-first",
	"-second",
].join("\n");

const RENAMED_PATCH = [
	"diff --git a/renamed/old.txt b/renamed/new.txt",
	"similarity index 90%",
	"rename from renamed/old.txt",
	"rename to renamed/new.txt",
	"index 5555555..5555555 100644",
	"--- a/renamed/old.txt",
	"+++ b/renamed/new.txt",
	"@@ -1 +1 @@",
	"-old content",
	"+new content",
].join("\n");

const BINARY_PATCH = [
	"diff --git a/bin.dat b/bin.dat",
	"index 6666666..7777777 100644",
	"Binary files a/bin.dat and b/bin.dat differ",
].join("\n");

/* fixture：截断（capPatch 之后的形态 —— 头部声明 7 行、只到达 1 行） */
const TRUNCATED_PATCH_TEXT = [
	"diff --git a/big.log b/big.log",
	"index 1111111..2222222 100644",
	"--- a/big.log",
	"+++ b/big.log",
	"@@ -1,7 +1,7 @@",
	"-line one",
].join("\n");

function diffRoutesFor() {
	return {
		"src/app.ts": (query) => (Number(query.context) >= 24 ? payloadFromPatch(WIDE_PATCH, "src/app.ts") : payloadFromPatch(MODIFIED_PATCH, "src/app.ts")),
		"feature.txt": () => payloadFromPatch(NEW_FILE_PATCH, "feature.txt"),
		"gone.txt": () => payloadFromPatch(DELETED_PATCH, "gone.txt"),
		"renamed/new.txt": () => payloadFromPatch(RENAMED_PATCH, "renamed/new.txt"),
		"bin.dat": () => payloadFromPatch(BINARY_PATCH, "bin.dat"),
		"big.log": () => payloadFromPatch(TRUNCATED_PATCH_TEXT, "big.log", { truncated: true }),
		"untracked.txt": () => ({
			ok: true,
			path: "untracked.txt",
			base: { ref: "main", sha: SHA_BASE, source: "marker" },
			head: { sha: SHA_HEAD },
			binary: false,
			truncated: false,
			hunks: [],
			untracked: true,
		}),
		"main.txt": () => ({
			ok: true,
			path: "main.txt",
			base: { ref: "main", sha: SHA_BASE, source: "marker" },
			head: { sha: SHA_HEAD },
			binary: false,
			truncated: false,
			hunks: [],
		}),
	};
}

/**
 * 桩 fetch 服务端：按 pathname 里**最后**一段 "/plugins-api/git-review/" 之后的
 * 部分匹配路由（entry 级测试的 apiBase 由 entry.mjs 自身的 import.meta.url 推导，
 * 前缀在测试进程里是任意目录 —— 子串匹配兼容任意前缀）。
 */
function createStubServer(extraRoutes = {}) {
	const calls = [];
	const routes = { ...diffRoutesFor(), ...extraRoutes };
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url, "http://stub.local");
		const all = parsed.pathname;
		const anchor = all.lastIndexOf("/plugins-api/git-review");
		const route = anchor >= 0 ? all.slice(anchor + "/plugins-api/git-review".length) : all;
		const query = Object.fromEntries(parsed.searchParams);
		const reqBody = init?.body ? JSON.parse(init.body) : undefined;
		calls.push({ method: init?.method ?? "GET", route, query, body: reqBody });
		// /diff 的路由表按**文件路径**键入（diffRoutesFor），按 query.path 解析；
		// extraRoutes 仍可直接以 "/diff" 为键覆盖（错误注入用）。函数路由可再收
		// 第二参 body（POST /marker 的断言用；既有单参函数不受影响）。
		const respond = routes[route] ?? (route === "/diff" ? routes[query.path] : undefined);
		if (!respond) {
			const body = { ok: false, error: `no stub route: ${route}` };
			return { ok: false, status: 404, text: async () => JSON.stringify(body) };
		}
		const body = typeof respond === "function" ? await respond(query, reqBody) : respond;
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ */
/* 共享状态复位 / 挂载辅助                                               */
/* ------------------------------------------------------------------ */

function resetStore() {
	store.setSelection(null);
	store.setState({ lastReview: null });
	store.setBaseOverride(null);
	store.clearDrafts(); // Phase 4：草稿也是模块级单例 —— 共享进程的套件间卫生
	localStorageBag.clear();
}

/** 工厂级挂载：选中**先**进 store（挂载时初始化），refresh 显式等待（确定性单次取数）。 */
async function mountViewer(path, { lang = "zh", base = "main" } = {}) {
	resetStore();
	if (path) store.setSelection({ path, base });
	const server = createStubServer();
	const view = viewerModule.createViewer({
		document: new FakeDocument(),
		apiBase: "/plugins-api/git-review",
		fetchImpl: server.fetchImpl,
		lang,
	});
	await view.refresh();
	return { view, server };
}

/** 模拟导航侧的第二次点击（同侧延伸）：同侧再点 → 延伸；shift → 无条件延伸。 */
function hotCellOf(row, side) {
	// gutter 单元格 = gr-vg + dataset.side（old/new）；不存在 gr-vgold/gr-vgnew 类名
	return collect(row.el, "gr-vg").find((cell) => cell.dataset.side === side);
}

/* ------------------------------------------------------------------ */
/* 纯函数层                                                             */
/* ------------------------------------------------------------------ */

describe("viewer pure helpers", () => {
	it("computes the fold gap between hunks per git elision semantics", () => {
		const { hunks } = parseUnifiedDiff(MODIFIED_PATCH);
		// hunk1 旧 1..3 / 新 1..4；hunk2 旧 10..12 / 新 11..14 → 两侧空隙都是 6
		assert.equal(viewerModule.foldGapBetween(hunks[0], hunks[1]), 6);
		assert.equal(viewerModule.foldGapBetween(hunks[1], hunks[0]), 0); // 计数重叠 → 无空隙
		const wide = parseUnifiedDiff(WIDE_PATCH);
		assert.equal(wide.hunks.length, 1); // 合并后无第二 hunk
		// 两侧声明不一致（截断补丁）取 max 容忍：git elision 语义 = 下一 hunk 起点 −
		// 上一 hunk 声明终点（起点+行数）→ old 侧 5−(1+2)=2、new 侧 9−(1+5)=3 → max=3
		assert.equal(
			viewerModule.foldGapBetween({ oldStart: 1, oldLines: 2, newStart: 1, newLines: 5 }, { oldStart: 5, oldLines: 1, newStart: 9, newLines: 1 }),
			3,
		);
	});

	it("builds the row model: hunk headers, lines, folds between hunks", () => {
		const payload = payloadFromPatch(MODIFIED_PATCH, "src/app.ts");
		const rows = viewerModule.buildDiffRows(payload);
		assert.deepEqual(
			rows.map((row) => row.kind),
			["hunk-header", "line", "line", "line", "line", "line", "fold", "hunk-header", "line", "line", "line", "line"],
		);
		const fold = rows.find((row) => row.kind === "fold");
		assert.equal(fold.gap, 6);
		assert.equal(fold.hunkIndex, 1);
		// 逐行行号（parser 语义 = git 输出语义）
		assert.deepEqual(
			rows.filter((row) => row.kind === "line").map((row) => [row.line.type, row.line.old ?? null, row.line.new ?? null]),
			[
				["ctx", 1, 1],
				["del", 2, null],
				["add", null, 2],
				["add", null, 3],
				["ctx", 3, 4],
				["ctx", 10, 11],
				["del", 11, null],
				["ctx", 12, 12],
				["add", null, 13],
			],
		);
		assert.deepEqual(viewerModule.buildDiffRows(payloadFromPatch(NEW_FILE_PATCH, "feature.txt")).filter((row) => row.kind === "fold"), []);
		assert.deepEqual(viewerModule.buildDiffRows({ hunks: [] }), []);
	});

	it("classifies the display mode and header notes (R8 special cases)", () => {
		assert.equal(viewerModule.describeViewerState(payloadFromPatch(MODIFIED_PATCH, "src/app.ts")).mode, "rows");
		const added = viewerModule.describeViewerState(payloadFromPatch(NEW_FILE_PATCH, "feature.txt"));
		assert.deepEqual(added, { mode: "rows", newFile: true, deleted: false, renamed: false, truncated: false });
		const deleted = viewerModule.describeViewerState(payloadFromPatch(DELETED_PATCH, "gone.txt"));
		assert.deepEqual(deleted, { mode: "rows", newFile: false, deleted: true, renamed: false, truncated: false });
		const renamed = viewerModule.describeViewerState(payloadFromPatch(RENAMED_PATCH, "renamed/new.txt"));
		assert.deepEqual(renamed, { mode: "rows", newFile: false, deleted: false, renamed: true, truncated: false });
		assert.equal(viewerModule.describeViewerState(payloadFromPatch(BINARY_PATCH, "bin.dat")).mode, "binary");
		assert.equal(viewerModule.describeViewerState({ hunks: [], untracked: true }).mode, "untracked");
		assert.equal(viewerModule.describeViewerState({ hunks: [] }).mode, "out-of-range");
		// R18：预览态（/blob 的 preview:true）—— 优先于 out-of-range，但不抢 binary 态
		assert.equal(viewerModule.describeViewerState({ hunks: [{ lines: [] }], preview: true }).mode, "preview");
		assert.equal(viewerModule.describeViewerState({ hunks: [], preview: true }).mode, "preview");
		assert.equal(viewerModule.describeViewerState({ hunks: [], preview: true, binary: true }).mode, "binary");
		assert.equal(viewerModule.describeViewerState({ hunks: [{ lines: [] }], truncated: true }).truncated, true);
		assert.deepEqual(viewerModule.describeViewerState(null), { mode: "rows", newFile: false, deleted: false, renamed: false, truncated: false });
	});

	it("renders hunk headers from parsed counts and colors statuses", () => {
		const { hunks } = parseUnifiedDiff(MODIFIED_PATCH);
		assert.equal(viewerModule.hunkHeaderText(hunks[0]), "@@ -1,3 +1,4 @@");
		assert.equal(viewerModule.hunkHeaderText(hunks[1]), "@@ -10,3 +11,4 @@");
		assert.equal(viewerModule.statusClass("A"), "A");
		assert.equal(viewerModule.statusClass("D"), "D");
		assert.equal(viewerModule.statusClass("M"), "M");
		assert.equal(viewerModule.statusClass("T"), "M");
		assert.equal(viewerModule.statusClass("R"), "R");
		assert.equal(viewerModule.statusClass("C"), "R");
		assert.equal(viewerModule.statusClass(undefined), "");
	});

	it("pins viewer strings in both languages (R12)", () => {
		assert.equal(i18n.t("zh", "viewer.fold", { n: 6 }), "⋯ 6 行未变更");
		assert.equal(i18n.t("en", "viewer.fold", { n: 6 }), "⋯ 6 unchanged lines");
		assert.equal(i18n.t("zh", "viewer.emptyHint").includes("右侧导航"), true);
		assert.equal(i18n.t("en", "viewer.emptyHint").includes("navigator"), true);
		assert.equal(i18n.t("zh", "viewer.kind.binary"), "二进制文件变更");
		assert.equal(i18n.t("en", "viewer.kind.binary"), "Binary file changed");
		assert.equal(i18n.t("zh", "viewer.kind.renamed", { old: "a", new: "b" }), "重命名：a → b");
	});
});

/* ------------------------------------------------------------------ */
/* gutter 行号 = git diff 语义（fixture 经 Phase 1 parser）              */
/* ------------------------------------------------------------------ */

describe("viewer renders unified diff rows (R8)", () => {
	it("renders gutter numbers matching git diff output, hunk headers, +/- coloring", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		assert.deepEqual(
			rows.map((row) => [row.type, row.old, row.new]),
			[
				["ctx", 1, 1],
				["del", 2, null],
				["add", null, 2],
				["add", null, 3],
				["ctx", 3, 4],
				["ctx", 10, 11],
				["del", 11, null],
				["ctx", 12, 12],
				["add", null, 13],
			],
		);
		// 符号列语义（white-space:pre 由 CSS 承担；textContent 保留行内空白）：
		// add → “+”，del → “-”，ctx → 空格；同一类型名同时用作行底色类（gr-vline add/del/ctx）
		assert.deepEqual(
			rows.map((row) => [row.type, collect(row.el, "gr-vsign")[0]?.textContent]),
			[
				["ctx", " "],
				["del", "-"],
				["add", "+"],
				["add", "+"],
				["ctx", " "],
				["ctx", " "],
				["del", "-"],
				["ctx", " "],
				["add", "+"],
			],
		);
		assert.deepEqual(rows.map((row) => row.text), [
			"const a = 1;",
			"const b = 2;",
			"const b = 20;",
			"",
			"const c = 3;",
			"  keep1",
			"  gone",
			"  keep2",
			"  added",
		]);
		// hunk 头照 parser 声明渲染
		const heads = collect(view.root, "gr-vhunkhead").map((head) => head.textContent);
		assert.deepEqual(heads, ["@@ -1,3 +1,4 @@", "@@ -10,3 +11,4 @@"]);
		// 头部：路径 + 状态字母 + 活动基线
		assert.equal(collect(view.root, "gr-vpath")[0].textContent, "src/app.ts");
		assert.equal(collect(view.root, "gr-vst")[0].textContent, "M");
		assert.ok(collect(view.root, "gr-vbaseref")[0].textContent.startsWith("main@"));
		// 折叠行：两 hunk 之间 ⋯ 6 行未变更
		const folds = foldRowsOf(view.root);
		assert.deepEqual(folds.map((fold) => fold.gap), ["6"]);
		assert.ok(folds[0].text.includes("⋯ 6 行未变更"));
		// 符号列：+ / - / 空格（ASCII，与 git 输出一致）
		assert.deepEqual(collect(view.root, "gr-vsign").map((sign) => sign.textContent), [" ", "-", "+", "+", " ", " ", "-", " ", "+"]);
		view.destroy();
	});

	it("empty store selection → R7 empty-state hint, zero fetches", async () => {
		resetStore();
		const server = createStubServer();
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.deepEqual(stateBoxesOf(view.root), ["主区 diff 查看器从右侧导航（Diff 评审标签页）选择一个文件，即可在此查看它的统一 diff。"]);
		assert.equal(server.calls.length, 0); // 无选中不发请求（确定性）
		view.destroy();
	});

	it("error payload renders the message with a retry that reloads", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		let failing = true;
		const server = createStubServer({
			"/diff": (query) =>
				failing ? { ok: false, error: "git command failed" } : payloadFromPatch(MODIFIED_PATCH, query.path ?? "src/app.ts"),
		});
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.deepEqual(stateBoxesOf(view.root), ["加载失败：git command failed"]);
		failing = false;
		view.model.els.retryBtn.click();
		await assertEventually(() => lineRowsOf(view.root).length === 9, "retry must restore the rows");
		assert.equal(server.calls.filter((call) => call.route === "/diff").length, 2);
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 特例形态（R8）                                                       */
/* ------------------------------------------------------------------ */

describe("viewer special file kinds (R8)", () => {
	it("new file (A): all-additions note, zero old gutters", async () => {
		const { view } = await mountViewer("feature.txt");
		const rows = lineRowsOf(view.root);
		assert.deepEqual(rows.map((row) => [row.type, row.old, row.new]), [
			["add", null, 1],
			["add", null, 2],
		]);
		assert.deepEqual(notesOf(view.root), ["新文件：全部为新增行"]);
		assert.equal(collect(view.root, "gr-vst")[0].textContent, "A");
		view.destroy();
	});

	it("deleted file (D): all-deletions note, zero new gutters", async () => {
		const { view } = await mountViewer("gone.txt");
		const rows = lineRowsOf(view.root);
		assert.deepEqual(rows.map((row) => [row.type, row.old, row.new]), [
			["del", 1, null],
			["del", 2, null],
		]);
		assert.deepEqual(notesOf(view.root), ["已删除文件：全部为删除行"]);
		assert.equal(collect(view.root, "gr-vst")[0].textContent, "D");
		view.destroy();
	});

	it("renamed file (R): anchored to the new path with the old → new header", async () => {
		const { view } = await mountViewer("renamed/new.txt");
		assert.deepEqual(notesOf(view.root), ["重命名：renamed/old.txt → renamed/new.txt"]);
		assert.equal(collect(view.root, "gr-vpath")[0].textContent, "renamed/new.txt");
		const rows = lineRowsOf(view.root);
		assert.deepEqual(rows.map((row) => [row.type, row.old, row.new]), [
			["del", 1, null],
			["add", null, 1],
		]);
		view.destroy();
	});

	it("binary file: message + hint, zero line rows (no anchoring)", async () => {
		const { view } = await mountViewer("bin.dat");
		assert.equal(lineRowsOf(view.root).length, 0);
		assert.equal(collect(view.root, "gr-vhunkhead").length, 0);
		assert.ok(notesOf(view.root).includes("二进制文件变更"));
		assert.deepEqual(stateBoxesOf(view.root), ["二进制文件变更二进制内容不渲染行级 diff，行锚定不可用。"]);
		view.destroy();
	});

	it("truncated diff (R16): visible truncation marker, rows still render", async () => {
		const { view } = await mountViewer("big.log");
		const banner = collect(view.root, "gr-vbanner")[0];
		assert.ok(banner, "truncation marker must render");
		assert.equal(banner.dataset.truncated, "true");
		assert.ok(banner.textContent.includes("diff 已截断"));
		assert.equal(lineRowsOf(view.root).length, 1); // 截断后仍解析到达的行
		view.destroy();
	});

	it("untracked file: untracked:true zero hunks → no-diff state (phase-1 contract)", async () => {
		const { view } = await mountViewer("untracked.txt");
		assert.equal(lineRowsOf(view.root).length, 0);
		assert.deepEqual(stateBoxesOf(view.root), ["未跟踪文件还没有 diff该文件尚未被 git 跟踪；加入暂存或提交后，这里会显示它的 diff。"]);
		view.destroy();
	});

	it("tracked file out of the review range: distinct friendly state (zero hunks, no status)", async () => {
		const { view } = await mountViewer("main.txt");
		assert.equal(lineRowsOf(view.root).length, 0);
		assert.deepEqual(stateBoxesOf(view.root), ["相对评审基线没有该文件的变更该文件在当前范围内未改动；从导航选择评审范围内的文件。"]);
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 折叠展开 / 收拢（context 参数）                                       */
/* ------------------------------------------------------------------ */

describe("viewer fold expand/collapse", () => {
	it("fold click refetches with context=24; the gap becomes ctx rows with continuous numbers", async () => {
		const { view, server } = await mountViewer("src/app.ts");
		const fold = foldRowsOf(view.root)[0];
		assert.ok(fold, "narrow payload must render one fold row");
		assert.equal(fold.gap, "6");

		fold.el.click();
		await assertEventually(
			() => server.calls.some((call) => call.route === "/diff" && call.query.context === "24"),
			"expand must request /diff with context=24",
		);
		await assertEventually(() => foldRowsOf(view.root).length === 0 && lineRowsOf(view.root).length === 19, "wide payload must render the closed gap");
		// 空隙行（old 4..9）以 ctx 呈现，old/new 行号连续
		const gapRows = lineRowsOf(view.root).filter((row) => row.type === "ctx" && row.old >= 4 && row.old <= 9);
		assert.deepEqual(
			gapRows.map((row) => [row.old, row.new]),
			[
				[4, 5],
				[5, 6],
				[6, 7],
				[7, 8],
				[8, 9],
				[9, 10],
			],
		);
		// 合并后的 hunk 头
		assert.deepEqual(collect(view.root, "gr-vhunkhead").map((head) => head.textContent), ["@@ -1,16 +1,17 @@"]);

		// 收拢：头部折叠按钮 → 回缺省宽度（argv 不带 -U，请求无 context 参数）
		const callsBefore = server.calls.length;
		view.model.els.collapseBtn.click();
		await assertEventually(
			() => foldRowsOf(view.root).length === 1 && server.calls.some((call) => call.route === "/diff" && call.query.context === undefined),
			"collapse must refetch without the context parameter",
		);
		assert.equal(view.model.els.collapseBtn, undefined);
		assert.ok(server.calls.length > callsBefore);
		view.destroy();
	});

	it("grows the width on repeated expands: 24 → 48 (capped at MAX_CONTEXT)", async () => {
		const { view, server } = await mountViewer("src/app.ts");
		view.expandFolds();
		await assertEventually(() => server.calls.some((call) => call.route === "/diff" && call.query.context === "24"));
		view.expandFolds();
		await assertEventually(() => server.calls.some((call) => call.route === "/diff" && call.query.context === "48"));
		// 继续倍增直到服务端上限：96 → 192 → 384 → 768 → 1000（Math.min 兜住 1536）
		for (const width of ["96", "192", "384", "768", "1000"]) {
			view.expandFolds();
			await assertEventually(() => server.calls.some((call) => call.route === "/diff" && call.query.context === width));
		}
		// 已在上限：再展开直接提前返回，连新请求都不发（next === contextWidth）
		const callsAtCap = server.calls.length;
		view.expandFolds();
		await tick();
		assert.equal(server.calls.length, callsAtCap, "no refetch once pinned at MAX_CONTEXT");
		view.destroy();
	});

	it("path change closes a foreign file-level editor (input must not misfile into the previous file)", async () => {
		const { view } = await mountViewer("src/app.ts");
		// 文件级编辑器（header 按钮，非选中来源）锚着 src/app.ts
		view.model.els.fileCommentBtn.click();
		await tick();
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts (file-level)");
		// 导航侧点击另一文件 → 换文件分支必须收起旧文件的编辑器
		store.setSelection({ path: "feature.txt", base: "main" });
		await assertEventually(
			() => collect(view.root, "gr-veditor-label").length === 0 && store.getState().selectedPath === "feature.txt",
			"foreign editor must close on path change",
		);
		view.destroy();
	});

	it("cap: width growth never exceeds MAX_CONTEXT (server validates the same bound)", () => {
		assert.equal(gitcore.MAX_CONTEXT, 1000);
		assert.equal(gitcore.validateContext("1000"), 1000);
		// validateContext("1001") 必须抛错（越上限）—— 单独一条断言让失败信息可读
		assert.throws(() => gitcore.validateContext("1001"), /invalid context/);
		assert.throws(() => gitcore.validateContext("abc"), /invalid context/);
		assert.throws(() => gitcore.validateContext("-5"), /invalid context/);
		assert.equal(gitcore.validateContext("24"), 24);
		assert.equal(gitcore.validateContext(undefined), undefined);
		assert.equal(gitcore.validateContext(""), undefined);
	});
});

/* ------------------------------------------------------------------ */
/* 行评论 UI（Phase 4 / R9）：选中 → 行内编辑器 → 草稿/列表/行标记        */
/* ------------------------------------------------------------------ */

describe("viewer comment UI (Phase 4 / R9)", () => {
	it("selection opens the inline comment editor; save attaches the draft and clears the selection", async () => {
		const { view } = await mountViewer("src/app.ts");
		assert.equal(collect(view.root, "gr-veditor").length, 0); // 无选中 → 无编辑器
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[4], "new").click(); // ctx 行 new4 → 内容/新行号缺省锚 new 侧（R9）
		const editor = collect(view.root, "gr-veditor")[0];
		assert.ok(editor, "editor must open on selection");
		assert.equal(collect(editor, "gr-veditor-title")[0].textContent, "添加评论");
		// 编辑器锚标签 = 消息契约形态（固定文本，agent 契约见 README）
		assert.equal(collect(editor, "gr-veditor-label")[0].textContent, "src/app.ts:4 (new side)");
		const input = collect(editor, "gr-veditor-input")[0];
		assert.ok(input, "editor must render a textarea");
		input.value = "fix this";
		input.dispatch("input", {});

		// 打字中重渲染（同一路径 refresh）→ 文本不丢（本地缓冲同步，Phase 3 选中语义保留）
		await view.refresh();
		assert.ok(collect(view.root, "gr-veditor")[0], "editor must survive a same-path refresh");
		assert.equal(collect(view.root, "gr-veditor-input")[0].value, "fix this");

		// 保存：草稿进 store（R9 锚定契约 {path, side, start, end, text}）
		collect(view.root, "gr-veditor-save")[0].click();
		assert.deepEqual(store.getComments(), [{ path: "src/app.ts", side: "new", start: 4, end: 4, text: "fix this" }]);
		// 编辑器关闭 + 选中清空（GitHub 语义：提交后编辑框收起）
		assert.equal(collect(view.root, "gr-veditor").length, 0);
		assert.equal(view.getSelection(), null);
		// 评论列表渲染 + 行标记（new4 行带 ●，其余行不带）
		const list = collect(view.root, "gr-vcomments")[0];
		assert.ok(list, "comment list must render after save");
		assert.equal(collect(list, "gr-vcomment").length, 1);
		assert.equal(collect(list, "gr-vcomment-anchor")[0].textContent, "src/app.ts:4 (new side)");
		assert.deepEqual(
			lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.new),
			[4],
		);
		assert.ok(collect(view.root, "gr-vmark").some((mark) => mark.textContent === "●"));
		view.destroy();
	});

	it("extended range selection anchors <start>-<end> and marks the covered rows", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[4], "new").click(); // 锚 new4
		hotCellOf(rows[5], "new").click(); // 第二次点击（同侧 new11）→ 延伸 new4..11
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 11 });
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts:4-11 (new side)");
		const input = collect(view.root, "gr-veditor-input")[0];
		input.value = "explain the range";
		input.dispatch("input", {});
		collect(view.root, "gr-veditor-save")[0].click();
		assert.deepEqual(store.getComments(), [{ path: "src/app.ts", side: "new", start: 4, end: 11, text: "explain the range" }]);
		// 覆盖行：new 号在 [4,11] 的行（new4、new11）带标记；范围外（new12/13）不带
		assert.deepEqual(
			lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.new),
			[4, 11],
		);
		view.destroy();
	});

	it("old-side selection anchors an (old side) comment on a deletion (R9 selectable old side)", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[6], "old").click(); // del 行 old11 → 旧行号锚 old 侧
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts:11 (old side)");
		const input = collect(view.root, "gr-veditor-input")[0];
		input.value = "this deletion drops the check";
		input.dispatch("input", {});
		collect(view.root, "gr-veditor-save")[0].click();
		assert.deepEqual(store.getComments(), [{ path: "src/app.ts", side: "old", start: 11, end: 11, text: "this deletion drops the check" }]);
		// old 侧标记：old 号在 [11,11] 的行（del old11；ctx old10/new11 不在）
		assert.deepEqual(
			lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.old),
			[11],
		);
		view.destroy();
	});

	it("file-level affordance in the header works for binary files (R9 covers binary)", async () => {
		const { view } = await mountViewer("bin.dat");
		assert.equal(lineRowsOf(view.root).length, 0); // 二进制无行（行锚定不可用）
		const btn = collect(view.root, "gr-vfilecomment")[0];
		assert.ok(btn, "header file-level button must render for binary too");
		btn.click();
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "bin.dat (file-level)");
		assert.equal(collect(view.root, "gr-veditor-input")[0].getAttribute("placeholder"), "针对整个文件的评论…");
		const input = collect(view.root, "gr-veditor-input")[0];
		input.value = "binary blob changed — please regenerate";
		input.dispatch("input", {});
		collect(view.root, "gr-veditor-save")[0].click();
		assert.deepEqual(store.getComments(), [{ path: "bin.dat", side: "file", start: 0, end: 0, text: "binary blob changed — please regenerate" }]);
		view.destroy();
	});

	it("comment list renders drafts with edit/delete; edit opens prefilled; delete removes draft and marker", async () => {
		const { view } = await mountViewer("src/app.ts");
		store.setComment({ path: "src/app.ts", side: "file", start: 0, end: 0, text: "file note" });
		store.setComment({ path: "src/app.ts", side: "new", start: 4, end: 4, text: "first" });
		const comments = collect(view.root, "gr-vcomment");
		assert.equal(comments.length, 2);
		// 列表序 = 提交序（store.getComments 排序：文件级在前）
		assert.equal(collect(comments[0], "gr-vcomment-anchor")[0].textContent, "src/app.ts (file-level)");
		assert.equal(collect(comments[0], "gr-vcomment-text")[0].textContent, "file note");
		assert.equal(collect(comments[1], "gr-vcomment-anchor")[0].textContent, "src/app.ts:4 (new side)");

		// 编辑：按钮 → 编辑器带原锚 + 原文本（编辑态标题）
		collect(comments[0], "gr-vcomment-edit")[0].click();
		assert.equal(collect(view.root, "gr-veditor-title")[0].textContent, "编辑评论");
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts (file-level)");
		assert.equal(collect(view.root, "gr-veditor-input")[0].value, "file note");
		// 取消（编辑态）：编辑器关、原草稿保留
		collect(view.root, "gr-veditor-cancel")[0].click();
		assert.equal(collect(view.root, "gr-veditor").length, 0);
		assert.equal(store.getComments().length, 2);

		// 删除：文件级那条删掉 → 列表与草稿同步、行标记按剩余草稿重算
		collect(comments[0], "gr-vcomment-delete")[0].click();
		assert.deepEqual(store.getComments().map((c) => c.text), ["first"]);
		assert.equal(collect(view.root, "gr-vcomment").length, 1);
		// 文件级草稿不逐行打标记；剩余行级草稿（new4）的标记保留
		assert.deepEqual(
			lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.new),
			[4],
		);
		view.destroy();
	});

	it("clicking another line retargets the editor; cancel closes it and clears the selection", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[4], "new").click();
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts:4 (new side)");
		hotCellOf(rows[2], "new").click(); // 另一行 → 编辑器换锚（新评论模式）
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "src/app.ts:2 (new side)");
		assert.equal(collect(view.root, "gr-veditor-input")[0].value, "");
		collect(view.root, "gr-veditor-cancel")[0].click();
		assert.equal(collect(view.root, "gr-veditor").length, 0);
		assert.equal(view.getSelection(), null);
		view.destroy();
	});

	it("saving with empty text discards: editor closes, no draft stored (R11 empty comment never lands)", async () => {
		const { view } = await mountViewer("src/app.ts");
		hotCellOf(lineRowsOf(view.root)[4], "new").click();
		collect(view.root, "gr-veditor-save")[0].click(); // 空文本直接保存
		assert.equal(collect(view.root, "gr-veditor").length, 0);
		assert.deepEqual(store.getComments(), []);
		assert.equal(view.getSelection(), null);
		view.destroy();
	});

	it("path/base change resets the selection and closes the editor (anchors never cross files/bases)", async () => {
		const { view } = await mountViewer("src/app.ts");
		hotCellOf(lineRowsOf(view.root)[4], "new").click();
		assert.ok(collect(view.root, "gr-veditor")[0]);
		store.setSelection({ path: "feature.txt", base: "main" });
		await assertEventually(() => collect(view.root, "gr-vpath")[0]?.textContent === "feature.txt");
		assert.equal(collect(view.root, "gr-veditor").length, 0);
		assert.equal(view.getSelection(), null);
		// 路径限定的列表：feature.txt 无草稿 → 不渲染列表
		assert.equal(collect(view.root, "gr-vcomments").length, 0);
		view.destroy();
	});

	it("comment list is path-scoped: another file's drafts show neither list nor row markers", async () => {
		const { view } = await mountViewer("src/app.ts");
		store.setComment({ path: "feature.txt", side: "file", start: 0, end: 0, text: "note" });
		assert.equal(collect(view.root, "gr-vcomments").length, 0);
		assert.equal(lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).length, 0);
		view.destroy();
	});

	it("drafts survive viewer unmount/remount (module-state store, R9)", async () => {
		const first = await mountViewer("src/app.ts");
		hotCellOf(lineRowsOf(first.view.root)[4], "new").click();
		const input = collect(first.view.root, "gr-veditor-input")[0];
		input.value = "survives the tab switch";
		input.dispatch("input", {});
		collect(first.view.root, "gr-veditor-save")[0].click();
		assert.equal(store.getComments().length, 1);
		first.view.destroy(); // 模拟右栏 tab 切走（宿主卸载）

		// 重新挂载（新 mount 上下文，选中仍在 store）：草稿原样渲染
		const second = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: first.server.fetchImpl,
			lang: "zh",
		});
		await second.refresh();
		assert.deepEqual(collect(second.root, "gr-vcomment-text").map((node) => node.textContent), ["survives the tab switch"]);
		assert.deepEqual(
			lineRowsOf(second.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.new),
			[4],
		);
		second.destroy();
	});

	it("pins comment UI strings in both languages (R12)", () => {
		assert.equal(i18n.t("zh", "viewer.fileComment"), "评论整个文件");
		assert.equal(i18n.t("en", "viewer.fileComment"), "Comment on file");
		assert.equal(i18n.t("zh", "viewer.commentEditor.addTitle"), "添加评论");
		assert.equal(i18n.t("en", "viewer.commentEditor.addTitle"), "Add comment");
		assert.equal(i18n.t("zh", "viewer.commentEditor.editTitle"), "编辑评论");
		assert.equal(i18n.t("en", "viewer.commentEditor.editTitle"), "Edit comment");
		assert.equal(i18n.t("zh", "viewer.commentEditor.save"), "保存");
		assert.equal(i18n.t("en", "viewer.commentEditor.save"), "Save");
		assert.equal(i18n.t("zh", "viewer.commentEditor.cancel"), "取消");
		assert.equal(i18n.t("en", "viewer.commentEditor.cancel"), "Cancel");
		assert.equal(i18n.t("zh", "viewer.commentEditor.placeholder"), "针对选中行/区间的评论…");
		assert.equal(i18n.t("en", "viewer.commentEditor.filePlaceholder"), "Comment on the whole file…");
		assert.equal(i18n.t("zh", "viewer.comments.title", { n: 2 }), "评论草稿（2）");
		assert.equal(i18n.t("en", "viewer.comments.title", { n: 2 }), "Comment drafts (2)");
		assert.equal(i18n.t("zh", "viewer.comments.edit"), "编辑");
		assert.equal(i18n.t("en", "viewer.comments.delete"), "Delete");
	});
});

/* ------------------------------------------------------------------ */
/* 行命中模型（Phase 4 消费的 API；本阶段不做评论 UI）                    */
/* ------------------------------------------------------------------ */

describe("viewer line-hit selection model", () => {
	it("click sets {path, side, line}; old gutter anchors old, new gutter anchors new", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		const events = [];
		const off = view.onSelectionChanged((snap) => events.push(snap));

		// ctx 行（old3/new4）：新行号 → new 侧
		hotCellOf(rows[4], "new").click();
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 4 });
		assert.deepEqual(events, [{ path: "src/app.ts", side: "new", start: 4, end: 4 }]);
		// 高亮：new 号在 [4,4] 的行（ctx new4；ctx new11 不在）
		const selectedRows = rows.filter((row) => row.el.classList.contains("selected"));
		assert.deepEqual(selectedRows.map((row) => row.new), [4]);

		// del 行（old11，无 new）：旧行号 → old 侧
		hotCellOf(rows[6], "old").click();
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "old", start: 11, end: 11 });
		assert.deepEqual(events.length, 2);

		// add 行（new13，无 old）：旧行号点击无效
		hotCellOf(rows[8], "old")?.click?.();
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "old", start: 11, end: 11 });

		// 内容列缺省锚 new 侧（R9）；del 行内容列锚 old 侧
		const contentOf = (row) => collect(row.el, "gr-vcontent")[0];
		contentOf(rows[2]).click(); // add 行 new2
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 2, end: 2 });
		contentOf(rows[6]).click(); // del 行 old11
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "old", start: 11, end: 11 });

		off();
		view.destroy();
	});

	it("second click / shift-click extends to a contiguous range from the anchor (min/max)", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		const events = [];
		view.onSelectionChanged((snap) => events.push(snap));

		hotCellOf(rows[4], "new").click(); // 锚 new4（单行）
		hotCellOf(rows[5], "new").click(); // 第二次点击（同侧，范围外 new11）→ 延伸
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 11 });

		hotCellOf(rows[8], "new").click(); // 范围外（new13）→ 继续从锚延伸
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 13 });

		// shift 点击：无条件从锚延伸（从 new4 到 new1 —— 区间倒置也归一化）
		hotCellOf(rows[0], "new").click({ shiftKey: true });
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 1, end: 13 });

		// 高亮：new 号在 [1,13] 的所有行（del 行无 new 号 → 不高亮）
		const selected = lineRowsOf(view.root).filter((row) => row.el.classList.contains("selected"));
		assert.deepEqual(
			selected.map((row) => row.new),
			[1, 2, 3, 4, 11, 12, 13],
		);

		// 点已选范围内部的另一行 → 收拢为单行；再点同一行 → 取消（GitHub 语义）
		hotCellOf(rows[4], "new").click(); // 内部 new4
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 4 });
		// 收拢后高亮同步收敛：只有 new4 一行仍带 selected（类移除路径）
		const collapsed = lineRowsOf(view.root).filter((row) => row.el.classList.contains("selected"));
		assert.deepEqual(
			collapsed.map((row) => row.new),
			[4],
		);
		hotCellOf(rows[4], "new").click(); // 同一行再点
		assert.equal(view.getSelection(), null);
		// 取消后高亮全清
		assert.equal(lineRowsOf(view.root).filter((row) => row.el.classList.contains("selected")).length, 0);

		// 取消也照发回调（Phase 4 的编辑器可依此关编辑框）
		assert.deepEqual(events.at(-1), null);
		view.destroy();
	});

	it("switching side or resetting starts a fresh single selection", async () => {
		const { view } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[4], "new").click();
		hotCellOf(rows[8], "new").click(); // 延伸 new4..13
		hotCellOf(rows[6], "old").click(); // 换侧（del 行 old11）→ 全新单行
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "old", start: 11, end: 11 });

		// onSelectionChanged 的注销函数生效
		const events = [];
		const off = view.onSelectionChanged((snap) => events.push(snap));
		off();
		hotCellOf(rows[0], "old").click();
		assert.deepEqual(events, []);
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "old", start: 1, end: 1 });
		view.destroy();
	});

	it("selection survives refresh of the same path (retry), and resets when path/base change", async () => {
		const { view, server } = await mountViewer("src/app.ts");
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[4], "new").click();
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 4 });

		// 同路径 refresh（重试）：锚对同一文件仍有效，重渲染后高亮保留
		await view.refresh();
		const rowsAfter = lineRowsOf(view.root);
		assert.deepEqual(view.getSelection(), { path: "src/app.ts", side: "new", start: 4, end: 4 });
		assert.ok(rowsAfter.find((row) => row.new === 4 && row.el.classList.contains("selected")));

		// 路径变化 → 选中复位并照发 null；viewer 重拉新路径
		const callsBefore = server.calls.length;
		store.setSelection({ path: "feature.txt", base: "main" });
		await assertEventually(() => collect(view.root, "gr-vpath")[0]?.textContent === "feature.txt");
		assert.equal(view.getSelection(), null);
		assert.equal(lineRowsOf(view.root).length, 2);
		assert.ok(server.calls.length > callsBefore);
		assert.ok(server.calls.some((call) => call.route === "/diff" && call.query.path === "feature.txt"));
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* store 驱动的重拉（R15：选中携带 {path, base}）                        */
/* ------------------------------------------------------------------ */

describe("viewer store-driven refetch", () => {
	it("refetches on selection (path or base) change; skips unrelated writes and no-op writes", async () => {
		resetStore();
		const server = createStubServer();
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});

		// 导航点击的等价动作：{path, base} 原子写入 → 拉取
		store.setSelection({ path: "src/app.ts", base: "main" });
		await assertEventually(() => server.calls.some((call) => call.route === "/diff" && call.query.path === "src/app.ts" && call.query.base === "main"));

		// 完全相同的写入（值未变）→ setSelection 不通知 → 不重拉
		const callsAfterFirst = server.calls.length;
		store.setSelection({ path: "src/app.ts", base: "main" });
		await tick();
		assert.equal(server.calls.length, callsAfterFirst);

		// 基线变化（导航把选中重同步到新基线）→ 带 base 重拉
		store.setSelection({ path: "src/app.ts", base: "origin/main" });
		await assertEventually(() => server.calls.some((call) => call.route === "/diff" && call.query.base === "origin/main"));

		// 无关写入（视图模式等）→ fetch-key 比对跳过
		const callsAfterBase = server.calls.length;
		store.setViewModes({ layout: "tree" });
		store.setViewModes({ layout: "flat" });
		store.setBaseOverride(null);
		await tick();
		assert.equal(server.calls.length, callsAfterBase);

		// 选中清除（导航清空）→ 空态，不再有在途请求
		store.setSelection(null);
		await assertEventually(() => stateBoxesOf(view.root).includes("主区 diff 查看器从右侧导航（Diff 评审标签页）选择一个文件，即可在此查看它的统一 diff。"));
		view.destroy();
	});

	it("base param defaults to none when the selection carries no base (server resolves)", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: null });
		const server = createStubServer();
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		const call = server.calls.find((c) => c.route === "/diff");
		assert.equal(call.query.path, "src/app.ts");
		assert.equal(call.query.base, undefined); // 不带 base —— 服务端缺省解析
		assert.equal(call.query.context, undefined); // 缺省宽度不加 -U 参数
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 生命周期（R15 双挂载对称清理）                                        */
/* ------------------------------------------------------------------ */

describe("viewer lifecycle and cleanup symmetry (R15)", () => {
	it("destroy detaches the root, ignores later store writes and in-flight responses, is idempotent", async () => {
		const { view, server } = await mountViewer("src/app.ts");
		const root = view.root;
		const callsAtDestroy = server.calls.length;
		view.destroy();
		assert.equal(root.parentNode, null);
		assert.doesNotThrow(() => view.destroy()); // 幂等
		assert.equal(root.parentNode, null);

		store.setSelection({ path: "feature.txt", base: "main" }); // 订阅已注销：不重拉不重渲染
		await tick();
		assert.equal(server.calls.length, callsAtDestroy);

		// 已注销的选中回调也不再触发
		const events = [];
		view.onSelectionChanged((snap) => events.push(snap));
		assert.deepEqual(events, []);
		store.setSelection(null);
	});

	it("entry viewer role renders the R7 empty hint, then the diff driven by the store selection", async () => {
		resetStore();
		const server = createStubServer();
		const previousFetch = globalThis.fetch;
		const previousDocument = globalThis.document;
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		try {
			const el = new FakeElement("div");
			const cleanup = entry.mount(el, {});
			// 无选中 → R7 空态提示（指向右栏导航），零请求
			await assertEventually(() => collect(el, "gr-vroot").length === 1, "viewer role must render the viewer root");
			assert.ok(collect(el, "gr-vstate").some((box) => box.textContent.includes("主区 diff 查看器")));
			assert.equal(server.calls.length, 0);

			// 导航侧选中（viewer 内部订阅驱动重拉）
			store.setSelection({ path: "src/app.ts", base: "main" });
			await assertEventually(() => lineRowsOf(el).length === 9, "selection must drive the diff render");
			assert.ok(server.calls.some((call) => call.route === "/diff" && call.query.path === "src/app.ts"));

			// 清理：root 卸下；后续 store 写不触达（无 listener 泄漏）
			const callsAtCleanup = server.calls.length;
			assert.doesNotThrow(() => cleanup());
			assert.doesNotThrow(() => cleanup()); // 幂等
			assert.equal(el.childNodes.length, 0);
			store.setSelection({ path: "feature.txt", base: "main" });
			await tick();
			assert.equal(server.calls.length, callsAtCleanup);
		} finally {
			globalThis.fetch = previousFetch;
			globalThis.document = previousDocument;
		}
	});

	it("entry mounts/unmounts repeatedly without listener leaks (symmetric cleanup ×5)", async () => {
		resetStore();
		const server = createStubServer();
		const previousFetch = globalThis.fetch;
		const previousDocument = globalThis.document;
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		try {
			for (let round = 0; round < 5; round++) {
				const el = new FakeElement("div");
				const cleanup = entry.mount(el, {});
				await assertEventually(() => collect(el, "gr-vroot").length === 1);
				cleanup();
				assert.equal(el.childNodes.length, 0);
			}
			// 全部卸载后：store 写既不重拉也不抛错（每次 mount 的订阅都被配对注销）
			const callsBefore = server.calls.length;
			store.setSelection({ path: "src/app.ts", base: "main" });
			await tick();
			assert.equal(server.calls.length, callsBefore);
			store.setSelection(null);
		} finally {
			globalThis.fetch = previousFetch;
			globalThis.document = previousDocument;
		}
	});

	it("with both mounts alive (R15): navigator click reflects in the viewer and switches the main view", async () => {
		resetStore();
		// 导航角色需要 entry 级标准路由（/review /marker /refs …）才能渲染行
		const server = createStubServer(standardRoutes());
		const setViews = [];
		const previousFetch = globalThis.fetch;
		const previousDocument = globalThis.document;
		const previousWindow = globalThis.window;
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		globalThis.window = { __piWebUiHost: { setView: (view) => setViews.push(view) } };
		try {
			const navHost = new FakeElement("div");
			navHost.classList.add("plugin-page-host");
			const viewHost = new FakeElement("div");
			const cleanupNav = entry.mount(navHost, {});
			const cleanupView = entry.mount(viewHost, {});
			await assertEventually(() => collect(navHost, "gr-row").length === REVIEW_FILES.length, "navigator rows must render");
			await assertEventually(() => collect(viewHost, "gr-vroot").length === 1, "viewer role must render (empty state)");

			// 导航点击：选中进 store（{path, base}）+ setView("plugin:git-review")
			const row = collect(navHost, "gr-row").find((el) => el.dataset.path === "src/app.ts");
			row.click();
			assert.equal(store.getState().selectedPath, "src/app.ts");
			assert.equal(store.getState().selectedBase, "main");
			assert.deepEqual(setViews, ["plugin:git-review"]);

			// viewer 经共享 store 重拉并渲染同一文件的 diff（两个 mount 都活着）
			await assertEventually(() => lineRowsOf(viewHost).length === 9, "viewer must render the clicked file's diff");
			assert.ok(server.calls.some((call) => call.route === "/diff" && call.query.path === "src/app.ts" && call.query.base === "main"));

			// 两个 mount 各自清理，反复卸装不报错（对称性）
			for (let round = 0; round < 3; round++) {
				assert.doesNotThrow(() => cleanupNav());
				assert.doesNotThrow(() => cleanupView());
				assert.equal(navHost.childNodes.length, 0);
				assert.equal(viewHost.childNodes.length, 0);
			}
		} finally {
			globalThis.fetch = previousFetch;
			globalThis.document = previousDocument;
			globalThis.window = previousWindow;
			store.setSelection(null);
		}
	});

	it("navigator row click degrades quietly when the setView bridge is absent", async () => {
		resetStore();
		// 导航角色需要 entry 级标准路由（/review /marker /refs …）才能渲染行
		const server = createStubServer(standardRoutes());
		const previousFetch = globalThis.fetch;
		const previousDocument = globalThis.document;
		const previousWindow = globalThis.window;
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		delete globalThis.window; // 桥缺失（占位测试环境）
		try {
			const view = navModule.createNavigator({
				document: new FakeDocument(),
				apiBase: "/plugins-api/git-review",
				fetchImpl: server.fetchImpl,
				lang: "zh",
			});
			await view.refresh();
			const row = collect(view.root, "gr-row").find((el) => el.dataset.path === "src/app.ts");
			assert.doesNotThrow(() => row.click()); // 桥缺失不拖垮行点击
			assert.deepEqual(store.getState().selectedPath, "src/app.ts"); // 选中照常进 store
			assert.deepEqual(store.getState().selectedBase, "main");
			assert.equal(navModule.activateMainView(), false); // 返回 false（安静降级）
			view.destroy();
		} finally {
			globalThis.fetch = previousFetch;
			globalThis.document = previousDocument;
			globalThis.window = previousWindow;
			store.setSelection(null);
		}
	});

	it("cwd-changed broadcast clears the selection back to the R7 empty state (viewer ctx.onData)", async () => {
		const dataCbs = [];
		let offCalled = false;
		const ctx = {
			onData: (cb) => {
				dataCbs.push(cb);
				return () => {
					offCalled = true;
				};
			},
		};
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createStubServer();
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
			ctx,
		});
		await view.refresh();
		assert.ok(lineRowsOf(view.root).length > 0, "precondition: diff rendered");

		// 工作区切换广播 → 清共享选中 → store 通知驱动回落 R7 空态（不发旧仓库的 /diff）
		const callsBefore = server.calls.length;
		for (const cb of dataCbs) cb({ kind: "cwd-changed" });
		await assertEventually(
			() => lineRowsOf(view.root).length === 0 && collect(view.root, "gr-vstate").some((box) => box.textContent.includes("主区 diff 查看器")),
			"viewer must fall back to the empty state after a workspace switch",
		);
		assert.equal(store.getState().selectedPath, null);
		assert.equal(server.calls.length, callsBefore, "no /diff refetch against the old workspace");

		// 与 navigator 侧对称：注销在 destroy 里收尾
		assert.equal(offCalled, false);
		view.destroy();
		assert.equal(offCalled, true);
	});

	it("activateMainView calls the real bridge contract setView(view: string) — void return, 'plugin:<id>' id", async () => {
		const previousWindow = globalThis.window;
		const calls = [];
		globalThis.window = { __piWebUiHost: { setView: (view) => calls.push(view) } };
		try {
			assert.equal(navModule.activateMainView(), true);
			assert.deepEqual(calls, ["plugin:git-review"]);
			assert.equal(navModule.activateMainView("plugin:other"), true);
			assert.deepEqual(calls, ["plugin:git-review", "plugin:other"]);
		} finally {
			globalThis.window = previousWindow;
		}
	});

	it("full journey: navigator click → viewer renders → draft → submit → compose → marker POST → drafts cleared → post-submit refresh", async () => {
		resetStore();
		const markerBodies = [];
		const composeCalls = [];
		const server = createStubServer({
			...standardRoutes(),
			// POST /marker 记录 body（函数路由第二参）；GET 仍回静态形态
			"/marker": (_query, body) => {
				if (body?.sha) {
					markerBodies.push(body);
					return { ok: true, sha: body.sha };
				}
				return { ok: true, sha: SHA_MARKER, repoRoot: "/repo" };
			},
		});
		const setViews = [];
		const previousFetch = globalThis.fetch;
		const previousDocument = globalThis.document;
		const previousWindow = globalThis.window;
		globalThis.fetch = server.fetchImpl;
		globalThis.document = new FakeDocument();
		globalThis.window = {
			__piWebUiHost: {
				setView: (view) => setViews.push(view),
				compose: (payload) => {
					composeCalls.push(payload);
					return true;
				},
			},
		};
		try {
			const navHost = new FakeElement("div");
			navHost.classList.add("plugin-page-host");
			const viewHost = new FakeElement("div");
			const cleanupNav = entry.mount(navHost, {});
			const cleanupView = entry.mount(viewHost, {});
			await assertEventually(() => collect(navHost, "gr-row").length === REVIEW_FILES.length, "navigator rows must render");

			// ① 导航点击 → 主区渲染同一文件（R7/R15 联动）
			const row = collect(navHost, "gr-row").find((el) => el.dataset.path === "src/app.ts");
			row.click();
			assert.deepEqual(setViews, ["plugin:git-review"]);
			await assertEventually(() => lineRowsOf(viewHost).length === 9, "viewer must render the clicked file's diff");

			// ② 草稿（编辑器 UI 由各自套件覆盖，这里走 store 接缝）
			store.setComment({ path: "src/app.ts", side: "new", start: 2, end: 2, text: "explain" });
			store.setSummary("Overall: naming follows repo convention.");
			await tick();

			// ③ 导航提交按钮 → 整条链收尾（compose → marker POST → 清草稿）
			const submitBtn = collect(navHost, "gr-submit")[0];
			assert.ok(submitBtn, "navigator submit button must render");
			submitBtn.click();
			await assertEventually(
				() => composeCalls.length === 1 && markerBodies.length === 1 && store.getComments().length === 0 && store.getSummary() === "",
				"full submit chain must complete",
			);
			assert.equal(markerBodies[0].sha, SHA_HEAD, "marker POST carries the /review-resolved HEAD");
			assert.ok(composeCalls[0].text.includes("Code review (base main@"));
			assert.ok(composeCalls[0].text.includes("1. src/app.ts:2 (new side): explain"));
			assert.ok(composeCalls[0].text.includes("Please fix the raised comments and re-commit."));
			assert.deepEqual(store.getState().baseOverride, null, "post-submit refresh runs on the marker range (override-free)");

			// ④ 提交后导航刷新（第二次 /review）+ 成功通知
			assert.ok(server.calls.filter((call) => call.route === "/review").length >= 2, "navigator must refresh after submit");
			assert.ok(collect(navHost, "gr-notice").some((n) => n.textContent.includes("评审已投递为草稿")));
			assert.doesNotThrow(() => cleanupNav());
			assert.doesNotThrow(() => cleanupView());
		} finally {
			globalThis.fetch = previousFetch;
			globalThis.document = previousDocument;
			globalThis.window = previousWindow;
			store.setSelection(null);
		}
	});
});

/* ------------------------------------------------------------------ */
/* R18：未变更文件的预览态（/diff 范围外 → /blob 链）                     */
/* ------------------------------------------------------------------ */

/** /blob 桩路由：全文经 previewHunks（index.mjs）合成与服务端同构的载荷。 */
function blobRouteFor(text, overrides = {}) {
	return () => {
		const { hunks, truncated } = previewHunks(text);
		return {
			ok: true,
			path: "main.txt",
			base: { ref: "main", sha: SHA_BASE, source: "marker" },
			head: { sha: SHA_HEAD },
			preview: true,
			binary: false,
			truncated,
			hunks,
			...overrides,
		};
	};
}

describe("unchanged-file preview (R18: /blob chain)", () => {
	it("out-of-range /diff chains into /blob and renders the full text without hunk headers", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("alpha\nbeta\ngamma\n") });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(server.calls.some((call) => call.route === "/diff"), "/diff fetched first");
		assert.ok(server.calls.some((call) => call.route === "/blob"), "zero-hunk diff chains into /blob");
		const rows = lineRowsOf(view.root);
		assert.deepEqual(
			rows.map((row) => [row.old, row.new, row.type, row.text]),
			[
				[1, 1, "ctx", "alpha"],
				[2, 2, "ctx", "beta"],
				[3, 3, "ctx", "gamma"],
			],
			"preview lines are all-context with old=new numbering",
		);
		assert.equal(collect(view.root, "gr-vhunkhead").length, 0, "no hunk headers in preview mode");
		assert.ok(notesOf(view.root).some((note) => note.includes("未变更文件")), "preview note renders in the header");
		view.destroy();
	});

	it("in-range zero-hunk previews (e.g. mode-only change, status M) get their own honest note", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({
			"main.txt": () => ({
				ok: true,
				path: "main.txt",
				base: { ref: "main", sha: SHA_BASE, source: "marker" },
				head: { sha: SHA_HEAD },
				status: "M", // 范围内（如 chmod-only）→ 零 hunk 但带 status
				binary: false,
				truncated: false,
				hunks: [],
			}),
			"/blob": blobRouteFor("alpha\n"),
		});
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(notesOf(view.root).some((note) => note.includes("文件内容未变更")), "in-range note, not the unchanged-file note");
		assert.ok(!notesOf(view.root).some((note) => note.includes("未变更文件：")));
		assert.ok(collect(view.root, "gr-vst").some((badge) => badge.textContent === "M"), "status badge survives the chain");
		view.destroy();
	});

	it("line selection and comments work on preview lines (same anchoring as diffs)", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("alpha\nbeta\ngamma\n") });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		const rows = lineRowsOf(view.root);
		hotCellOf(rows[1], "new").click();
		assert.deepEqual(view.getSelection(), { path: "main.txt", side: "new", start: 2, end: 2 });
		assert.equal(collect(view.root, "gr-veditor-label")[0].textContent, "main.txt:2 (new side)");
		const input = collect(view.root, "gr-veditor-input")[0];
		input.value = "rename this?";
		input.dispatch("input", {});
		collect(view.root, "gr-veditor-save")[0].click();
		assert.deepEqual(store.getComments(), [{ path: "main.txt", side: "new", start: 2, end: 2, text: "rename this?" }]);
		assert.deepEqual(
			lineRowsOf(view.root).filter((row) => row.el.classList.contains("commented")).map((row) => row.new),
			[2],
		);
		view.destroy();
	});

	it("blob failure keeps the out-of-range state (no error clobbering)", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({}); // 无 /blob 桩 → 404 {ok:false}
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(server.calls.some((call) => call.route === "/blob"));
		assert.ok(
			stateBoxesOf(view.root).some((text) => text.includes("相对评审基线没有该文件的变更")),
			"out-of-range state survives the failed blob leg",
		);
		assert.equal(lineRowsOf(view.root).length, 0);
		view.destroy();
	});

	it("statuses whose path cannot exist at the base never chain (A/R/C) — no wasted request", async () => {
		for (const status of ["A", "R", "C"]) {
			resetStore();
			store.setSelection({ path: "main.txt", base: "main" });
			const server = createStubServer({
				"main.txt": () => ({
					ok: true,
					path: "main.txt",
					base: { ref: "main", sha: SHA_BASE, source: "marker" },
					head: { sha: SHA_HEAD },
					status,
					...(status === "R" ? { oldPath: "old.txt" } : {}),
					binary: false,
					truncated: false,
					hunks: [],
				}),
			});
			const view = viewerModule.createViewer({
				document: new FakeDocument(),
				apiBase: "/plugins-api/git-review",
				fetchImpl: server.fetchImpl,
				lang: "zh",
			});
			await view.refresh();
			assert.ok(!server.calls.some((call) => call.route === "/blob"), `status ${status} must not fetch /blob`);
			assert.ok(stateBoxesOf(view.root).some((text) => text.includes("相对评审基线没有该文件的变更")));
			view.destroy();
		}
	});

	it("deleted empty files (status D, zero hunks) chain and show the empty-file state", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({
			"main.txt": () => ({
				ok: true,
				path: "main.txt",
				base: { ref: "main", sha: SHA_BASE, source: "marker" },
				head: { sha: SHA_HEAD },
				status: "D",
				binary: false,
				truncated: false,
				hunks: [], // 删除的空文件：补丁零行
			}),
			"/blob": blobRouteFor(""), // 基线上存在 → 空内容
		});
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(server.calls.some((call) => call.route === "/blob"));
		assert.ok(stateBoxesOf(view.root).some((text) => text.includes("空文件（0 行）")), "honest empty-file state, not out-of-range");
		view.destroy();
	});

	it("untracked files never chain into /blob (untracked state stands)", async () => {
		resetStore();
		store.setSelection({ path: "untracked.txt", base: "main" });
		const server = createStubServer({});
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(!server.calls.some((call) => call.route === "/blob"), "untracked short-circuits the blob leg");
		assert.ok(stateBoxesOf(view.root).some((text) => text.includes("未跟踪文件")));
		view.destroy();
	});

	it("binary preview renders the binary state with preview wording and no line rows", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("", { binary: true, hunks: [] }) });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(stateBoxesOf(view.root).some((text) => text.includes("未变更的二进制文件")), "preview wording, not the changed wording");
		assert.ok(!stateBoxesOf(view.root).some((text) => text.includes("二进制文件变更")));
		assert.equal(lineRowsOf(view.root).length, 0);
		assert.ok(collect(view.root, "gr-vfilecomment")[0], "file-level comment entry still available");
		view.destroy();
	});

	it("empty-file preview gets its own state (0 lines is not out-of-range)", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("") });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		assert.ok(stateBoxesOf(view.root).some((text) => text.includes("空文件（0 行）")));
		view.destroy();
	});

	it("truncated preview shows the preview-specific banner", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("x\n".repeat(20), { truncated: true }) });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		const banner = collect(view.root, "gr-vbanner")[0];
		assert.ok(banner, "truncation banner renders");
		assert.equal(banner.dataset.truncated, "true");
		assert.ok(banner.textContent.includes("预览已截断"));
		assert.ok(!banner.textContent.includes("diff 已截断"), "preview wording, not the diff wording");
		view.destroy();
	});

	it("fold expansion is suppressed in preview mode (no collapse button, no fold rows)", async () => {
		resetStore();
		store.setSelection({ path: "main.txt", base: "main" });
		const server = createStubServer({ "/blob": blobRouteFor("alpha\nbeta\n") });
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		await view.refresh();
		view.expandFolds(); // 预览态无折叠语义 → 空操作，不白打请求
		await tick();
		assert.equal(server.calls.filter((call) => call.route === "/blob").length, 1, "expand is a no-op in preview mode");
		assert.equal(lineRowsOf(view.root).length, 2, "rows unchanged");
		assert.equal(collect(view.root, "gr-vfold").length, 0);
		assert.ok(!collect(view.root, "gr-vbtn").some((btn) => btn.textContent === "折叠上下文"), "no collapse button in preview");
		view.destroy();
	});
});
