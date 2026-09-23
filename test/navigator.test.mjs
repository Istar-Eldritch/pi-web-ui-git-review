/**
 * navigator.test.mjs —— 右栏导航视图（Phase 2）的裸 ESM 测试，无 npm。
 *
 * 两个层次：
 *   1. 纯函数层（行契约、树构建、错误归类、基线展示、R4 预选）直接断言；
 *   2. 整个视图用**极小假 DOM**（约 80 行，createElement/append/classList/textContent/
 *      addEventListener/value 的最小面）+ 桩 fetch 服务端（Phase 1 路由契约形态）
 *      驱动：行渲染、两个开关 + localStorage 持久化、基线选择器（分支/提交/手动）、
 *      状态机（空评审、截断、非仓库、stale marker、无基线、通用错误）、
 *      文件筛选（R24）、清理。
 *
 * 全局桩次序：假环境收口在 test/fake-env.mjs（与 viewer 套件共享同一份 ——
 * 两个套件被 test/index.js import 进**同一进程**，各装一份全局桩会互相打掉，
 * 正是「单独跑全绿、全量跑必挂」的跨套件污染）。桩在任何被测模块装载之前
 * 安装（store 的持久化每次调用时再判 localStorage，装好即对后续行为生效）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* ------------------------------------------------------------------ */
/* 全局桩（先于被测模块；与 viewer 套件共享 —— 见 fake-env.mjs 头注释）     */
/* ------------------------------------------------------------------ */

import { collect, createBridgeSpy, FakeDocument, installGlobalStubs, localStorageBag } from "./fake-env.mjs";
installGlobalStubs();

const store = await import("../client/store.mjs");
const navModule = await import("../client/navigator.mjs");
const i18n = await import("../client/i18n.mjs");

/* ------------------------------------------------------------------ */
/* 断言辅助（假 DOM 与 collect 来自 fake-env.mjs）                        */
/* ------------------------------------------------------------------ */

function rowsOf(root) {
	return collect(root, "gr-row").map((row) => ({ el: row, path: row.dataset.path, text: row.textContent }));
}

function statusOf(row) {
	return collect(row?.el ?? row, "gr-st")[0]?.textContent ?? null;
}

function flagsOf(row) {
	return collect(row?.el ?? row, "gr-flag").map((flag) => flag.textContent);
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
/* 桩服务端（Phase 1 路由契约形态）                                       */
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

const REFS_PAYLOAD = {
	ok: true,
	refs: [
		{ name: "feature", current: true },
		{ name: "main", current: false },
		{ name: "origin/main", current: false, remote: "origin" },
	],
};

const COMMITS_PAYLOAD = {
	ok: true,
	commits: [
		{ sha: SHA_HEAD, shortSha: "c123456", author: "Test", date: "2026-09-22", subject: "f2 feature more" },
		{ sha: SHA_BASE, shortSha: "a123456", author: "Test", date: "2026-09-21", subject: "base" },
	],
};

const TREE_PAYLOAD = {
	ok: true,
	files: [
		"bin.dat",
		"dir/new.txt",
		"dir/old.txt",
		"feature.txt",
		"keep.txt",
		"readme.md",
		"unstaged.txt",
		"untracked.txt",
	],
	total: 8,
	truncated: false,
};

function createStubServer(routes) {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url, "http://stub.local");
		const prefix = "/plugins-api/git-review";
		const route = parsed.pathname.startsWith(prefix) ? parsed.pathname.slice(prefix.length) : parsed.pathname;
		const query = Object.fromEntries(parsed.searchParams);
		calls.push({ method: init?.method ?? "GET", route, query });
		const respond = routes[route];
		if (!respond) {
			const body = { ok: false, error: `no stub route: ${route}` };
			return { ok: false, status: 404, text: async () => JSON.stringify(body) };
		}
		const body = typeof respond === "function" ? await respond(query) : respond;
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	return { fetchImpl, calls };
}

/** 标准桩：marker=SHA_MARKER（source marker），/review 原样回 REVIEW_FILES。 */
function standardRoutes(overrides = {}) {
	return {
		"/marker": { ok: true, sha: SHA_MARKER, repoRoot: "/repo" },
		"/refs": REFS_PAYLOAD,
		"/commits": COMMITS_PAYLOAD,
		"/resolve": { ok: true, ref: "x", sha: SHA_BASE },
		"/review": {
			ok: true,
			base: { ref: "main", sha: SHA_BASE, source: "marker" },
			head: { sha: SHA_HEAD },
			files: REVIEW_FILES,
			total: REVIEW_FILES.length,
			truncated: false,
		},
		"/tree": TREE_PAYLOAD,
		...overrides,
	};
}

function resetStore() {
	store.setState({ selectedPath: null, lastReview: null });
	store.setBaseOverride(null);
	store.setViewModes({ layout: "flat", scope: "changed" });
	localStorageBag.clear();
}

async function mountNavigator(routes, { lang = "zh", ctx, openFile } = {}) {
	const server = createStubServer(routes);
	const view = navModule.createNavigator({
		document: new FakeDocument(),
		apiBase: "/plugins-api/git-review",
		fetchImpl: server.fetchImpl,
		lang,
		ctx,
		openFile,
	});
	await view.refresh();
	return { view, server };
}

/* ------------------------------------------------------------------ */
/* 纯函数层                                                             */
/* ------------------------------------------------------------------ */

describe("navigator pure helpers", () => {
	it("classifies structured errors into recoverable states (R13)", () => {
		assert.equal(navModule.classifyReviewError("not a git repository"), "non-repo");
		assert.equal(navModule.classifyReviewError("stale review marker: commit f00d no longer exists — pick a base manually"), "stale-marker");
		assert.equal(navModule.classifyReviewError("corrupt review marker: \"junk\" is not a valid commit hash — pick a base manually"), "stale-marker");
		assert.equal(navModule.classifyReviewError("no review base: no stored marker and none of origin/HEAD, origin/main, origin/master, main, master resolves — pass ?base="), "no-base");
		// 覆盖用的 base 解析失败（分支被删）→ 同一条「手动选基线」恢复路径
		assert.equal(navModule.classifyReviewError("unknown base: ghost"), "no-base");
		// unrelated histories：merge-base 失败也归类 no-base（服务端 rethrow 同前缀，
		// 指向手动选基线而不是 unknown + 永远失败的 Retry）
		assert.equal(navModule.classifyReviewError("unknown base: f00d — no common ancestor with HEAD (git command failed)"), "no-base");
		assert.equal(navModule.classifyReviewError(undefined), "unknown");
	});

	it("picks the base display: override wins, then review.source, then marker, then suggestion (R5)", () => {
		assert.deepEqual(navModule.baseDisplay(null, { ref: "dev", source: "branch" }, SHA_MARKER, "origin/main"), {
			ref: "dev",
			sha: null,
			key: "override",
		});
		assert.deepEqual(navModule.baseDisplay({ base: { ref: "main", sha: SHA_BASE, source: "marker" } }, null, SHA_MARKER, null), {
			ref: "main",
			sha: SHA_BASE,
			key: "marker",
		});
		assert.deepEqual(navModule.baseDisplay({ base: { ref: "origin/main", sha: SHA_BASE, source: "default" } }, null, null, "origin/main"), {
			ref: "origin/main",
			sha: SHA_BASE,
			key: "default",
		});
		// source:"param" = 本视图发出的覆盖请求 → 覆盖徽标
		assert.deepEqual(navModule.baseDisplay({ base: { ref: "feature", sha: SHA_BASE, source: "param" } }, null, null, null), {
			ref: "feature",
			sha: SHA_BASE,
			key: "override",
		});
		// review 未就绪但 marker 存在 → 只能展示短哈希
		assert.deepEqual(navModule.baseDisplay(null, null, SHA_MARKER, null), {
			ref: navModule.shortSha(SHA_MARKER),
			sha: SHA_MARKER,
			key: "marker",
		});
		assert.equal(navModule.baseDisplay(null, null, null, null), null);
		// 覆盖刚落、/review 还没回来：review.base 还是上一个基线的载荷 → 不得把旧 sha 配到新 ref 上
		assert.deepEqual(
			navModule.baseDisplay({ base: { ref: "main", sha: SHA_BASE, source: "marker" } }, { ref: "origin/main", source: "branch" }, SHA_MARKER, null),
			{ ref: "origin/main", sha: null, key: "override" },
		);
		// /review 已按覆盖返回（base.ref === override.ref）→ sha 正常配对
		assert.deepEqual(
			navModule.baseDisplay({ base: { ref: "origin/main", sha: SHA_BASE, source: "param" } }, { ref: "origin/main", source: "branch" }, SHA_MARKER, null),
			{ ref: "origin/main", sha: SHA_BASE, key: "override" },
		);
	});

	it("pins the row model: rename text, localized flags, more-files count (R3/R16)", () => {
		assert.equal(navModule.renameText({ path: "dir/new.txt", oldPath: "dir/old.txt" }), "dir/old.txt → dir/new.txt");
		assert.equal(navModule.renameText({ path: "keep.txt" }), null);
		const zh = i18n.makeT("zh");
		const en = i18n.makeT("en");
		assert.deepEqual(navModule.flagLabels(["untracked", "staged", "unstaged"], zh), ["未跟踪", "已暂存", "未暂存"]);
		assert.deepEqual(navModule.flagLabels(["untracked", "staged", "unstaged"], en), ["untracked", "staged", "unstaged"]);
		assert.deepEqual(navModule.flagLabels(["mystery"], zh), ["mystery"]); // 未知 flag 原样保留
		assert.equal(navModule.moreFilesCount({ truncated: true, total: 12, files: [{}, {}] }), 10);
		assert.equal(navModule.moreFilesCount({ truncated: false, total: 12, files: [] }), 0);
		assert.equal(navModule.moreFilesCount(null), 0);
	});

	it("builds the tree client-side: dirs first, sorted, with per-dir change counts", () => {
		const tree = navModule.buildTree(
			["b/f2.txt", "a/f1.txt", "top.txt", "a/c/f3.txt"],
			(path) => path === "a/f1.txt" || path === "top.txt",
		);
		assert.deepEqual(
			tree.map((node) => `${node.kind}:${node.path}`),
			["dir:a", "dir:b", "file:top.txt"],
		);
		const dirA = tree[0];
		assert.deepEqual(dirA.children.map((node) => `${node.kind}:${node.path}`), ["dir:a/c", "file:a/f1.txt"]);
		assert.equal(dirA.changed, 1); // 只有 a/f1.txt 变更（a/c 子树无变更）
		assert.equal(tree[1].changed, 0);
		assert.deepEqual(navModule.flattenTree(tree, new Set(["a"])).map((node) => node.path), ["a", "b", "b/f2.txt", "top.txt"]);
		assert.equal(navModule.flattenTree(tree, new Set()).length, 7); // 3 目录 + 4 文件，全展开
	});

	it("aggregates per-dir add/del through object entries and sums the row contract (R19)", () => {
		// 对象条目：{ path, add, del } 带入行数；字符串条目行数保持 0（向后兼容）
		const tree = navModule.buildTree(
			[
				{ path: "src/one.txt", add: 3, del: 1 },
				{ path: "src/deep/two.txt", add: 1, del: 2 },
				{ path: "top.txt", add: 2, del: 0 },
				"src/plain.txt",
			],
			() => true,
		);
		const src = tree.find((node) => node.path === "src");
		assert.equal(src.add, 4); // 子树求和：3+1，plain.txt 字符串条目不计
		assert.equal(src.del, 3); // 1+2
		const deep = src.children.find((node) => node.path === "src/deep");
		assert.deepEqual(deep.add, 1);
		assert.deepEqual(deep.del, 2);
		const plain = src.children.find((node) => node.path === "src/plain.txt");
		assert.deepEqual({ add: plain.add, del: plain.del, changed: plain.changed }, { add: 0, del: 0, changed: true });
		// 头部聚合：对行契约 add/del 的 sum（截断时只覆盖已列出文件，与清单一致）
		assert.deepEqual(navModule.sumAddDel([{ add: 1, del: 2 }, { add: 3, del: 0 }, {}, null]), { add: 4, del: 2 });
		assert.deepEqual(navModule.sumAddDel("junk"), { add: 0, del: 0 });
	});

	it("preselects the first resolvable mainline candidate via /resolve (R4)", async () => {
		const attempts = [];
		const resolveRef = async (ref) => {
			attempts.push(ref);
			if (ref === "origin/main") return { ok: true, ref, sha: SHA_BASE };
			return { ok: false, error: `unknown ref: ${ref}` };
		};
		assert.equal(await navModule.pickDefaultBase(resolveRef), "origin/main");
		assert.deepEqual(attempts, ["origin/HEAD", "origin/main"]); // 顺序停在第一个可解析
		assert.equal(
			await navModule.pickDefaultBase(async () => ({ ok: false, error: "unknown ref" })),
			null,
		);
	});
});

/* ------------------------------------------------------------------ */
/* 行契约（Phase 1 /review 行 → 导航行）                                 */
/* ------------------------------------------------------------------ */

describe("navigator file rows (phase-1 row contract)", () => {
	it("renders status letter, add/del counts, rename old → new, and flags", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		const rows = rowsOf(view.root);
		assert.deepEqual(rows.map((row) => row.path), REVIEW_FILES.map((file) => file.path));

		const renamed = rows.find((row) => row.path === "dir/new.txt");
		assert.equal(statusOf(renamed), "R");
		assert.ok(renamed.text.includes("dir/old.txt → dir/new.txt"));
		assert.ok(renamed.text.includes("+1"));

		const staged = rows.find((row) => row.path === "keep.txt");
		assert.equal(statusOf(staged), "M");
		assert.deepEqual(flagsOf(staged), ["已暂存"]);
		assert.ok(staged.text.includes("+1") && staged.text.includes("−1"));

		const untracked = rows.find((row) => row.path === "untracked.txt");
		assert.deepEqual(flagsOf(untracked), ["未跟踪"]);
		assert.ok(untracked.el.classList.contains("untracked") === false); // 类在 chip 上
		assert.ok(collect(untracked.el, "gr-flag")[0].classList.contains("untracked"));

		const binary = rows.find((row) => row.path === "bin.dat");
		assert.equal(statusOf(binary), "M");
		assert.deepEqual(flagsOf(binary), []);
		assert.ok(!binary.text.includes("+") && !binary.text.includes("−"));

		view.destroy();
	});

	it("shows the whole-review aggregate in the head and per-dir aggregates in tree layout (R19)", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		// 头部标题行：REVIEW_FILES 的 add/del sum = +5 −2（REVIEW_FILES：1+0+2+1+1，del 0+1+1）
		assert.equal(view.model.els.totals.textContent, "+5−2");
		assert.equal(collect(view.model.els.totals, "gr-add")[0]?.textContent, "+5");
		assert.equal(collect(view.model.els.totals, "gr-del")[0]?.textContent, "−2");

		// 树形：目录行右缘展示子树聚合（dir/ 子树 = dir/new.txt 的 +1 −0 → 零值部分省略）
		collect(view.root, "gr-segbtn").find((button) => button.textContent === "树").click();
		const dirrow = collect(view.root, "gr-dirrow").find((row) => row.dataset.dir === "dir");
		assert.equal(collect(dirrow, "gr-add")[0]?.textContent, "+1");
		assert.equal(collect(dirrow, "gr-del").length, 0);
		assert.equal(collect(dirrow, "gr-dircnt").length, 0); // 有真实行数时旧的「+N 变更文件」徽标不并排
		view.destroy();
	});

	it("selecting a row stores the shared selection (module store)", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		const row = rowsOf(view.root).find((entry) => entry.path === "keep.txt");
		row.el.click();
		assert.equal(store.getState().selectedPath, "keep.txt");
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 两个独立开关（R6）                                                    */
/* ------------------------------------------------------------------ */

describe("navigator toggles (tree/flat and changed/full)", () => {
	it("tree/flat switches the layout and persists across sessions (R6)", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		assert.equal(store.getState().viewModes.layout, "flat");
		// 平铺模式：不渲染任何目录行；rename 行仍保留 old → new 文案
		assert.equal(collect(view.root, "gr-dirrow").length, 0);
		const renamedFlat = rowsOf(view.root).find((row) => row.path === "dir/new.txt");
		assert.ok(renamedFlat, "renamed file must render in flat mode");
		assert.ok(renamedFlat.text.includes("dir/old.txt → dir/new.txt"));

		collect(view.root, "gr-segbtn").find((button) => button.textContent === "树").click();
		assert.equal(store.getState().viewModes.layout, "tree");
		const dirRows = collect(view.root, "gr-dirrow");
		assert.ok(dirRows.some((row) => row.dataset.dir === "dir"));
		// 树形下 rename 行仍在
		assert.ok(rowsOf(view.root).some((row) => row.path === "dir/new.txt"));

		assert.deepEqual(JSON.parse(localStorageBag.get("git-review.viewModes")), { layout: "tree", scope: "changed" });
		assert.deepEqual(store.loadViewModes(), { layout: "tree", scope: "changed" }); // 跨会话读回

		collect(view.root, "gr-segbtn").find((button) => button.textContent === "平铺").click();
		assert.equal(store.getState().viewModes.layout, "flat");
		assert.equal(collect(view.root, "gr-dirrow").length, 0);
		view.destroy();
	});

	it("changed/full fetches /tree, badges changed files; unchanged rows open the preview (R18)", async () => {
		resetStore();
		const opened = [];
		const { view, server } = await mountNavigator(standardRoutes(), { openFile: () => opened.push(store.getState().selectedPath) });
		collect(view.root, "gr-segbtn").find((button) => button.textContent === "全树").click();
		await assertEventually(() => rowsOf(view.root).some((row) => row.path === "readme.md"), "full tree must render");

		assert.ok(server.calls.some((call) => call.route === "/tree"));
		assert.equal(store.getState().viewModes.scope, "full");
		assert.deepEqual(JSON.parse(localStorageBag.get("git-review.viewModes")), { layout: "flat", scope: "full" });

		const rows = rowsOf(view.root);
		assert.ok(rows.some((row) => row.path === "readme.md"));
		const changed = rows.find((row) => row.path === "keep.txt");
		assert.equal(statusOf(changed), "M"); // 变更徽章（状态字母）
		const unchanged = rows.find((row) => row.path === "readme.md");
		assert.equal(statusOf(unchanged), null);
		assert.ok(unchanged.el.classList.contains("preview"), "unchanged rows render in preview style");
		assert.ok(!unchanged.el.classList.contains("static"));

		const dirBadge = collect(view.root, "gr-dirrow").find((row) => row.dataset.dir === "dir");
		assert.ok(dirBadge.textContent.includes("+1")); // 目录变更徽章

		// R18：未变更行也可选中 —— 同一条 {path, base} 原子写入 + 内嵌优先的展示入口
		unchanged.el.click();
		assert.equal(store.getState().selectedPath, "readme.md");
		assert.deepEqual(opened, ["readme.md"], "unchanged row click routes through openFile like changed rows");
		// 重渲染后选中高亮落在预览行上（与变更行一致的高亮语义）
		assert.ok(
			rowsOf(view.root).find((row) => row.path === "readme.md").el.classList.contains("selected"),
			"selected highlight lands on the preview row",
		);
		changed.el.click();
		assert.equal(store.getState().selectedPath, "keep.txt");
		assert.deepEqual(opened, ["readme.md", "keep.txt"]);

		// 回到仅变更：/review 清单恢复
		collect(view.root, "gr-segbtn").find((button) => button.textContent === "仅变更").click();
		await view.refresh();
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), REVIEW_FILES.map((file) => file.path));
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 文件筛选（R24）                                                       */
/* ------------------------------------------------------------------ */

describe("navigator file filter (R24)", () => {
	it("pathMatchesFilter: case-insensitive full-path substring; blank query passes all", () => {
		assert.equal(navModule.pathMatchesFilter("client/Viewer.mjs", "viewer"), true);
		assert.equal(navModule.pathMatchesFilter("client/Viewer.mjs", "VIEWER.MJS"), true);
		assert.equal(navModule.pathMatchesFilter("client/Viewer.mjs", "nope"), false);
		assert.equal(navModule.pathMatchesFilter("client/Viewer.mjs", ""), true);
		assert.equal(navModule.pathMatchesFilter("client/Viewer.mjs", "   "), true); // 仅空白 = 不过滤
		assert.equal(navModule.pathMatchesFilter(null, "x"), false);
		assert.equal(navModule.pathMatchesFilter(undefined, ""), true);
	});

	it("renders the filter row above the toolbar only when a list is present", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		const row = collect(view.root, "gr-filterrow")[0];
		assert.ok(row, "filter row renders for a loaded review");
		// 位置：紧跟头部之后、工具条之前
		const kids = view.root.childNodes.filter((n) => typeof n !== "string");
		assert.ok(kids[0].classList.contains("gr-head"));
		assert.equal(kids.indexOf(row), 1);
		assert.ok(kids[2].classList.contains("gr-toolbar"));
		assert.equal(view.model.els.filterInput.value, "");
		assert.equal(view.model.els.filterInput.getAttribute("placeholder"), "筛选文件…");
		assert.equal(collect(view.root, "gr-filter-clear").length, 0); // 空筛选无清除按钮
		view.destroy();

		// 空评审 → 无清单可筛 → 行不出现
		resetStore();
		const empty = await mountNavigator(
			standardRoutes({
				"/review": { ok: true, base: { ref: "main", sha: SHA_BASE, source: "marker" }, files: [], total: 0, truncated: false },
			}),
		);
		assert.equal(collect(empty.view.root, "gr-filterrow").length, 0);
		empty.view.destroy();

		// 错误态 → 无清单 → 行不出现
		resetStore();
		const failing = await mountNavigator(standardRoutes({ "/review": { ok: false, error: "boom" } }));
		assert.equal(collect(failing.view.root, "gr-filterrow").length, 0);
		failing.view.destroy();

		// 加载中 → 行不出现；装载完成后出现
		resetStore();
		let releaseReview;
		const gated = standardRoutes({
			"/review": () =>
				new Promise((resolve) => {
					releaseReview = () => resolve(standardRoutes()["/review"]);
				}),
		});
		const gatedServer = createStubServer(gated);
		const gatedView = navModule.createNavigator({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: gatedServer.fetchImpl,
			lang: "zh",
		});
		const gatedRefresh = gatedView.refresh(); // 同步渲染出加载态
		assert.equal(collect(gatedView.root, "gr-filterrow").length, 0);
		// /review 在 marker/refs/commits 的微任务之后才发出 —— 先等 gate 挂上再放行
		await assertEventually(() => typeof releaseReview === "function", "/review must be gated in flight");
		releaseReview();
		await gatedRefresh;
		assert.equal(collect(gatedView.root, "gr-filterrow").length, 1);
		gatedView.destroy();
	});

	it("hides the filter row while the base picker is open", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		assert.equal(collect(view.root, "gr-filterrow").length, 1);
		view.model.els.changeBaseBtn.click();
		assert.equal(collect(view.root, "gr-filterrow").length, 0);
		view.destroy();
	});

	it("filters the flat changed list live; matches rename oldPath too; survives re-render", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		view.model.els.filterInput.value = "DIR"; // 大小写不敏感
		view.model.els.filterInput.dispatch("input");
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), ["dir/new.txt"]);
		// 重渲染后 model.els.filterInput 是新元素，值被恢复
		assert.equal(view.model.els.filterInput.value, "DIR");

		// rename 旧路径（行上可见的 old → new 文案）也参与命中
		view.model.els.filterInput.value = "old.txt";
		view.model.els.filterInput.dispatch("input");
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), ["dir/new.txt"]);
		view.destroy();
	});

	it("shows a no-match state and restores everything via the clear button", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		view.model.els.filterInput.value = "zzz";
		view.model.els.filterInput.dispatch("input");
		assert.equal(rowsOf(view.root).length, 0);
		assert.ok(
			collect(view.root, "gr-state")[0].textContent.includes("zzz"),
			"no-match state names the query",
		);
		// 行还在筛时清除按钮可点；恢复全量后按钮消失
		const clear = view.model.els.filterClearBtn;
		assert.ok(clear, "clear button shows while a filter is active");
		clear.click();
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), REVIEW_FILES.map((file) => file.path));
		assert.equal(view.model.els.filterInput.value, "");
		assert.equal(collect(view.root, "gr-filter-clear").length, 0);
		view.destroy();
	});

	it("filters the tree layout, auto-expands collapsed dirs while filtering, restores collapse on clear", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		collect(view.root, "gr-segbtn").find((button) => button.textContent === "树").click();
		// 折叠 dir/
		collect(view.root, "gr-dirrow").find((row) => row.dataset.dir === "dir").click();
		assert.equal(rowsOf(view.root).some((row) => row.path === "dir/new.txt"), false);

		// 筛选：匹配项在折叠目录里也可见（筛选激活 = 全展开，caret 同步如实 ▾）
		view.model.els.filterInput.value = "new.txt";
		view.model.els.filterInput.dispatch("input");
		assert.ok(rowsOf(view.root).some((row) => row.path === "dir/new.txt"), "filter auto-expands collapsed dirs");
		assert.equal(rowsOf(view.root).length, 1); // 只剩匹配子树
		assert.ok(collect(view.root, "gr-dirrow").every((row) => row.dataset.dir === "dir"));

		// 清除 → 恢复折叠记忆：dir/ 重新折叠
		view.model.els.filterClearBtn.click();
		assert.equal(rowsOf(view.root).some((row) => row.path === "dir/new.txt"), false);
		assert.ok(collect(view.root, "gr-dirrow").some((row) => row.dataset.dir === "dir"));
		view.destroy();
	});

	it("filters the full tree without refetching /tree", async () => {
		resetStore();
		const { view, server } = await mountNavigator(standardRoutes(), { openFile: () => {} });
		collect(view.root, "gr-segbtn").find((button) => button.textContent === "全树").click();
		await assertEventually(() => rowsOf(view.root).some((row) => row.path === "readme.md"), "full tree must render");
		const treeCalls = server.calls.filter((call) => call.route === "/tree").length;

		view.model.els.filterInput.value = "readme";
		view.model.els.filterInput.dispatch("input");
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), ["readme.md"]);

		// 无匹配 → 空态文案
		view.model.els.filterInput.value = "zzz";
		view.model.els.filterInput.dispatch("input");
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("zzz")));

		// 筛选是纯客户端的：/tree 调用数不变
		assert.equal(server.calls.filter((call) => call.route === "/tree").length, treeCalls);
		view.destroy();
	});

	it("defers re-render during IME composition until compositionend", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		const input = view.model.els.filterInput;
		input.value = "keep";
		input.dispatch("input", { isComposing: true });
		// 组合中：不重渲染 —— 列表保持全量、输入框元素未重建
		assert.equal(rowsOf(view.root).length, REVIEW_FILES.length);
		assert.equal(view.model.els.filterInput, input);
		// 组合结束 → 统一筛
		input.dispatch("compositionend");
		assert.deepEqual(rowsOf(view.root).map((row) => row.path), ["keep.txt"]);
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 基线选择器（R5）                                                      */
/* ------------------------------------------------------------------ */

describe("navigator base picker", () => {
	it("shows the marker default and overriding by branch keeps the marker untouched", async () => {
		resetStore();
		const { view, server } = await mountNavigator(standardRoutes());
		assert.equal(view.model.els.baseBadge.textContent, "标记");
		assert.ok(view.model.els.baseRef.textContent.startsWith("main@"));

		view.model.els.changeBaseBtn.click();
		assert.ok(collect(view.root, "gr-picker").length === 1);
		const branchButtons = view.model.pickerItems.filter((item) => item.source === "branch");
		assert.deepEqual(branchButtons.map((item) => item.ref), ["feature", "main", "origin/main"]);

		branchButtons.find((item) => item.ref === "origin/main").el.click();
		await assertEventually(
			() => store.getState().baseOverride?.ref === "origin/main" && server.calls.some((call) => call.route === "/review" && call.query.base === "origin/main"),
			"override must refetch /review with base=origin/main",
		);
		assert.deepEqual(store.getState().baseOverride, { ref: "origin/main", source: "branch" });
		// 覆盖永不移动存储的 marker：无任何 POST /marker
		assert.ok(server.calls.every((call) => call.method !== "POST"));
		// 头部展示覆盖 + 还原按钮
		assert.equal(view.model.els.baseBadge.textContent, "覆盖");
		assert.ok(view.model.els.resetBaseBtn);

		view.model.els.resetBaseBtn.click();
		await assertEventually(
			() => store.getState().baseOverride === null && server.calls.some((call) => call.route === "/review" && call.query.base === undefined),
			"reset must clear the override and reload without base",
		);
		assert.equal(view.model.els.baseBadge.textContent, "标记");
		view.destroy();
	});

	it("picks a recent commit by full sha and applies a manual ref", async () => {
		resetStore();
		const { view, server } = await mountNavigator(standardRoutes());
		view.model.els.changeBaseBtn.click();
		const commitItems = view.model.pickerItems.filter((item) => item.source === "commit");
		assert.deepEqual(commitItems.map((item) => item.ref), [SHA_HEAD, SHA_BASE]); // 完整哈希作为基线参数

		commitItems[1].el.click();
		await assertEventually(
			() => server.calls.some((call) => call.route === "/review" && call.query.base === SHA_BASE),
			"commit pick must request /review with the full sha",
		);
		assert.deepEqual(store.getState().baseOverride, { ref: SHA_BASE, source: "commit" });

		// 手动输入
		view.model.els.changeBaseBtn.click();
		view.model.els.manualInput.value = "  hotfix-2026  ";
		view.model.els.manualApply.click();
		await assertEventually(
			() => server.calls.some((call) => call.route === "/review" && call.query.base === "hotfix-2026"),
			"manual apply must request /review with the trimmed ref",
		);
		assert.deepEqual(store.getState().baseOverride, { ref: "hotfix-2026", source: "manual" });
		view.destroy();
	});

	it("never pairs a freshly picked override ref with the previous base's sha in the header", async () => {
		resetStore();
		let release = null;
		let reviewCalls = 0;
		const routes = standardRoutes({
			"/review": (query) => {
				reviewCalls += 1;
				if (reviewCalls === 1) return standardRoutes()["/review"];
				// 第二次（覆盖后的重取）用 gate 挂住，观测在途窗口里的头部
				return new Promise((resolve) => {
					release = () =>
						resolve({
							ok: true,
							base: { ref: query.base ?? "main", sha: SHA_BASE, source: "marker" },
							head: { sha: SHA_HEAD },
							files: REVIEW_FILES,
							total: REVIEW_FILES.length,
							truncated: false,
						});
				});
			},
		});
		const { view, server } = await mountNavigator(routes);
		assert.equal(view.model.els.baseRef.textContent, `main@${navModule.shortSha(SHA_BASE)}`);

		view.model.els.changeBaseBtn.click();
		view.model.pickerItems.find((item) => item.ref === "origin/main").el.click();
		await assertEventually(
			() => server.calls.some((call) => call.route === "/review" && call.query.base === "origin/main"),
			"override refetch must be issued",
		);
		// /review 还被 gate 挂着：头部已经是新 ref，且不得带旧基线的哈希
		assert.equal(view.model.els.baseRef.textContent, "origin/main");
		release();
		await assertEventually(
			() => view.model.els.baseRef.textContent === `origin/main@${navModule.shortSha(SHA_BASE)}`,
			"once /review returns, ref and sha pair up again",
		);
		view.destroy();
	});

	it("shows the default badge when the server resolved the mainline suggestion (R4)", async () => {
		resetStore();
		const routes = standardRoutes({
			"/marker": { ok: true, sha: null, repoRoot: "/repo" },
			"/resolve": (query) => (query.ref === "origin/main" ? { ok: true, ref: query.ref, sha: SHA_BASE } : { ok: false, error: `unknown ref: ${query.ref}` }),
			"/review": {
				ok: true,
				base: { ref: "origin/main", sha: SHA_BASE, source: "default" },
				head: { sha: SHA_HEAD },
				files: REVIEW_FILES,
				total: REVIEW_FILES.length,
				truncated: false,
			},
		});
		const { view, server } = await mountNavigator(routes);
		assert.equal(view.model.els.baseBadge.textContent, "默认");
		assert.ok(view.model.els.baseRef.textContent.startsWith("origin/main@"));
		assert.ok(server.calls.some((call) => call.route === "/resolve" && call.query.ref === "origin/HEAD"));
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 状态机（R3/R13/R16）                                                  */
/* ------------------------------------------------------------------ */

describe("navigator states", () => {
	it("empty review renders the friendly empty state", async () => {
		resetStore();
		const routes = standardRoutes({
			"/review": { ok: true, base: { ref: "main", sha: SHA_BASE, source: "marker" }, head: { sha: SHA_HEAD }, files: [], total: 0, truncated: false },
		});
		const { view } = await mountNavigator(routes);
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("相对基线没有变更")));
		view.destroy();
	});

	it("truncation keeps total and shows the N-more notice (R16)", async () => {
		resetStore();
		const routes = standardRoutes({
			"/review": {
				ok: true,
				base: { ref: "main", sha: SHA_BASE, source: "marker" },
				head: { sha: SHA_HEAD },
				files: REVIEW_FILES.slice(0, 2),
				total: 12,
				truncated: true,
			},
		});
		const { view } = await mountNavigator(routes);
		const notice = collect(view.root, "gr-more")[0];
		assert.ok(notice, "truncation notice must render");
		assert.equal(notice.dataset.more, "10");
		assert.ok(notice.textContent.includes("还有 10 个文件未显示"));
		assert.ok(notice.textContent.includes("共 12 个"));
		assert.equal(rowsOf(view.root).length, 2); // 只渲染截断后的条数
		view.destroy();
	});

	it("non-repo workspace renders the friendly state, not an error", async () => {
		resetStore();
		const notRepo = { ok: false, error: "not a git repository" };
		const routes = standardRoutes({
			"/marker": notRepo,
			"/resolve": notRepo,
			"/review": notRepo,
		});
		const { view } = await mountNavigator(routes);
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("当前工作区不是 git 仓库")));
		view.destroy();
	});

	it("stale marker prompts for a manual base without crashing (R13)", async () => {
		resetStore();
		const routes = standardRoutes({
			"/review": { ok: false, error: `stale review marker: commit ${SHA_MARKER} no longer exists — pick a base manually` },
		});
		const { view } = await mountNavigator(routes);
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("评审基线已失效")));
		assert.ok(view.model.els.pickBaseBtn, "manual-base prompt button must exist");
		view.model.els.pickBaseBtn.click();
		assert.ok(collect(view.root, "gr-picker").length === 1);
		view.destroy();
	});

	it("no resolvable base prompts for a manual base too (R13)", async () => {
		resetStore();
		const routes = standardRoutes({
			"/marker": { ok: true, sha: null, repoRoot: "/repo" },
			"/resolve": { ok: false, error: "unknown ref" },
			"/review": { ok: false, error: "no review base: no stored marker and none of origin/HEAD, origin/main, origin/master, main, master resolves — pass ?base=" },
		});
		const { view } = await mountNavigator(routes);
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("没有可用的评审基线")));
		assert.ok(view.model.els.pickBaseBtn);
		view.destroy();
	});

	it("unknown errors show the message with a retry that reloads", async () => {
		resetStore();
		let reviewFails = true;
		const routes = standardRoutes({
			"/review": () => (reviewFails ? { ok: false, error: "git command failed" } : standardRoutes()["/review"]),
		});
		const { view, server } = await mountNavigator(routes);
		assert.ok(collect(view.root, "gr-state").some((box) => box.textContent.includes("加载失败：git command failed")));
		reviewFails = false;
		view.model.els.retryBtn.click();
		await assertEventually(() => rowsOf(view.root).length === REVIEW_FILES.length, "retry must restore the list");
		assert.ok(server.calls.filter((call) => call.route === "/review").length >= 2);
		view.destroy();
	});

	it("full-scope keeps the workspace tree browsable when the review errors (banner, not dead end)", async () => {
		resetStore();
		const routes = standardRoutes({
			"/review": { ok: false, error: "unknown base: ghost" },
		});
		const { view } = await mountNavigator(routes);
		store.setViewModes({ scope: "full" });
		await view.ensureTree();
		assert.ok(collect(view.root, "gr-banner").some((banner) => banner.textContent.includes("加载失败：unknown base: ghost")));
		assert.ok(rowsOf(view.root).some((row) => row.path === "readme.md")); // 全树照常可用
		view.destroy();
	});
});

/* ------------------------------------------------------------------ */
/* 语言（R12）与生命周期（R15）                                           */
/* ------------------------------------------------------------------ */

describe("navigator locale and lifecycle", () => {
	it("switches every label between zh and en (R12)", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes(), { lang: "zh" });
		assert.equal(view.model.els.refreshBtn.textContent, "刷新");
		assert.equal(view.model.els.baseBadge.textContent, "标记");
		view.setLang("en");
		assert.equal(view.model.els.refreshBtn.textContent, "Refresh");
		assert.equal(view.model.els.baseBadge.textContent, "marker");
		assert.ok(collect(view.root, "gr-flag").some((flag) => flag.textContent === "untracked"));
		view.setLang("zh");
		assert.equal(view.model.els.refreshBtn.textContent, "刷新");
		view.destroy();
	});

	it("follows the onLocale payload even while documentElement.lang is stale (R12)", async () => {
		resetStore();
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		const previousDocument = globalThis.document;
		try {
			// 模拟宿主时序：LanguageProvider（App 的父级）写属性的 effect 还没跑，
			// onLocale 触发瞬间 documentElement.lang 仍是旧值 —— 切语言必须靠载荷。
			globalThis.document = { documentElement: { lang: "zh-CN" } };
			globalThis.window = { __piWebUiHost: bridge.host };
			const { view } = await mountNavigator(standardRoutes());
			assert.equal(view.lang, "zh");
			assert.ok(bridge.hasLocaleSubscriber(), "navigator must subscribe via onLocale");
			assert.equal(globalThis.document.documentElement.lang, "zh-CN"); // 属性确实保持旧值

			bridge.deliverLocale("en-US");
			assert.equal(view.lang, "en");
			assert.equal(view.model.els.refreshBtn.textContent, "Refresh");
			assert.equal(view.model.els.baseBadge.textContent, "marker");

			bridge.deliverLocale("zh-CN");
			assert.equal(view.lang, "zh");
			assert.equal(view.model.els.refreshBtn.textContent, "刷新");
			assert.equal(view.model.els.baseBadge.textContent, "标记");
			view.destroy();
		} finally {
			globalThis.window = previousWindow;
			globalThis.document = previousDocument;
		}
	});

	it("detectLang reads the host html lang and watchLocale degrades without the bridge", () => {
		const previousDocument = globalThis.document;
		try {
			globalThis.document = { documentElement: { lang: "zh-CN" } };
			assert.equal(i18n.detectLang(), "zh");
			globalThis.document = { documentElement: { lang: "en-US" } };
			assert.equal(i18n.detectLang(), "en");
		} finally {
			globalThis.document = previousDocument;
		}
		const off = i18n.watchLocale(() => {});
		assert.equal(typeof off, "function");
		assert.doesNotThrow(() => off());
		assert.equal(i18n.t("zh", "nav.more", { n: 7 }), "还有 7 个文件未显示");
		assert.equal(i18n.t("en", "nav.more", { n: 7 }), "7 more files");
	});

	it("destroy detaches the root, ignores later store writes, and is idempotent", async () => {
		resetStore();
		const { view } = await mountNavigator(standardRoutes());
		const root = view.root;
		view.destroy();
		assert.equal(root.parentNode, null);
		assert.doesNotThrow(() => view.destroy());
		const writesBefore = root.childNodes.length;
		store.setState({ selectedPath: "keep.txt" }); // 订阅已注销：不再重渲染
		assert.equal(root.childNodes.length, writesBefore);
		store.setState({ selectedPath: null });
	});

	it("relays the server cwd-changed broadcast into a full reload", async () => {
		resetStore();
		let deliver = null;
		const ctx = {
			onData: (handler) => {
				deliver = handler;
				return () => {};
			},
		};
		const { view, server } = await mountNavigator(standardRoutes(), { ctx });
		const callsBefore = server.calls.filter((call) => call.route === "/review").length;
		assert.ok(deliver);
		deliver({ kind: "cwd-changed" });
		await assertEventually(
			() => server.calls.filter((call) => call.route === "/review").length > callsBefore,
			"cwd-changed must trigger a reload",
		);
		view.destroy();
		assert.doesNotThrow(() => deliver({ kind: "cwd-changed" })); // 销毁后的迟到广播不复活视图
	});
});
