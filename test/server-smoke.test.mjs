/**
 * server-smoke.test.mjs —— 用 plugin-sdk createMockHost 同风格的宿主桩 +
 * 真实临时 git 仓库，端到端跑 index.mjs 的全部路由（R2 契约 + R13 失败路径）。
 *
 * 宿主桩只实现 git-review 用到的面：route（登记 handler，测试直接调）、
 * storage（内存 KV）、活的 cwd getter + onCwdChange、broadcast/log。语义对齐
 * plugin-sdk/index.mjs 的 createMockHost（注册返回注销函数、内存实现、log 记录）。
 *
 * 路由调用约定：index.mjs 的 route 包装层返回 promise（生产宿主忽略返回值，
 * 测试用它确定性等待回包），res 桩实现 json/status/headersSent 三个触点。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import gitReview from "../index.mjs";
import { detectRole } from "../client/entry.mjs";
import { apiBaseFromUrl, getState, setState, subscribe } from "../client/store.mjs";
import { MAX_FILES, MAX_PATCH_CHARS, markerKey } from "../client/gitcore.mjs";

// 测试进程的 git 环境隔离（也影响插件 execFile 继承的 env）：指向一个空配置文件
// （不用 /dev/null —— Windows 上不可移植），不看用户/系统配置，绝不提示交互。
// 必须在任何 git 调用前生效。
const gitConfigIsolationDir = mkdtempSync(join(tmpdir(), "git-review-cfg-"));
const emptyGitConfigPath = join(gitConfigIsolationDir, "gitconfig");
writeFileSync(emptyGitConfigPath, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfigPath;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfigPath;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

/* ------------------------------------------------------------------ */
/* 宿主桩（createMockHost 风格）                                        */
/* ------------------------------------------------------------------ */

function createMockHost({ cwd, dir }) {
	const routes = new Map();
	const storageMap = new Map();
	const logs = [];
	const broadcasts = [];
	const cwdWatchers = [];
	let currentCwd = cwd;
	const host = {
		dir,
		dataDir: dir,
		get cwd() {
			return currentCwd;
		},
		route(method, path, handler) {
			routes.set(`${method} ${path}`, handler);
			return () => routes.delete(`${method} ${path}`);
		},
		storage: {
			get: (key, fallback) => (storageMap.has(key) ? storageMap.get(key) : fallback),
			set: (key, value) => storageMap.set(key, value),
			delete: (key) => storageMap.delete(key),
			all: () => Object.fromEntries(storageMap),
		},
		onCwdChange(handler) {
			cwdWatchers.push(handler);
			return () => {
				const i = cwdWatchers.indexOf(handler);
				if (i >= 0) cwdWatchers.splice(i, 1);
			};
		},
		broadcast(payload) {
			broadcasts.push(payload);
		},
		notify() {},
		log(level, ...parts) {
			logs.push({ level, text: parts.map(String).join(" ") });
		},
		// 测试挂钩（同 SDK mock 的 mock.* 约定）
		__routes: routes,
		__storage: storageMap,
		__logs: logs,
		__broadcasts: broadcasts,
		__setCwd(value) {
			currentCwd = value;
			for (const h of [...cwdWatchers]) h(value);
		},
	};
	return host;
}

function createMockRes() {
	return {
		statusCode: 200,
		headersSent: false,
		payload: undefined,
		json(payload) {
			this.headersSent = true;
			this.payload = payload;
			return this;
		},
		status(code) {
			this.statusCode = code;
			return this;
		},
	};
}

async function callRoute(host, method, path, { query, body } = {}) {
	const handler = host.__routes.get(`${method} ${path}`);
	assert.ok(handler, `route not registered: ${method} ${path}`);
	const res = createMockRes();
	await handler({ query: query ?? {}, body }, res);
	assert.ok(res.headersSent, `handler must respond: ${method} ${path}`);
	return res.payload;
}

/* ------------------------------------------------------------------ */
/* 临时仓库 fixture                                                     */
/* ------------------------------------------------------------------ */

function gitIn(cwd, args) {
	return execFileSync("git", args.flat(), { cwd, encoding: "utf8" });
}

/**
 * 仓库形状：
 *   C0 (base, main) → C1 (main only)            ← main 在此
 *        └→ feature: F1, F2                     ← HEAD 在此（F2）
 *   F1: feature.txt 新增 / keep.txt 改 / del.txt 删 / bin.dat 改（二进制）/
 *       dir/old.txt → dir/new.txt 改名+改内容
 *   工作树（未提交）：staged.txt 已暂存改、unstaged.txt 未暂存改、
 *                     untracked.txt + untracked_dir/nested.txt 未跟踪
 *   另加 refs/remotes/origin/main（不联网）、sub/deep/ 子目录（cwd 锚定测试）。
 */
function buildFixtureRepo() {
	const root = mkdtempSync(join(tmpdir(), "git-review-smoke-"));
	const g = (...args) => gitIn(root, args);
	g(["init", "-q", "-b", "main", "."]);
	g(["config", "user.email", "test@example.com"]);
	g(["config", "user.name", "Test"]);
	writeFileSync(join(root, "keep.txt"), "keep\n");
	writeFileSync(join(root, "del.txt"), "delete me\n");
	writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0x62, 0x61, 0x73, 0x65]));
	writeFileSync(join(root, "staged.txt"), "staged line v1\n");
	writeFileSync(join(root, "unstaged.txt"), "unstaged line v1\n");
	mkdirSync(join(root, "dir"));
	writeFileSync(join(root, "dir", "old.txt"), "moved content\nline two\nline three\n");
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "base"]);
	const baseSha = g(["rev-parse", "HEAD"]).trim();

	writeFileSync(join(root, "main.txt"), "main only\n");
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "c1 main only"]);
	const mainSha = g(["rev-parse", "HEAD"]).trim();

	g(["checkout", "-q", "-b", "feature", baseSha]);
	writeFileSync(join(root, "feature.txt"), "feature v1\n");
	writeFileSync(join(root, "keep.txt"), "keep\nchanged\n");
	rmSync(join(root, "del.txt"));
	writeFileSync(join(root, "bin.dat"), Buffer.from([0, 1, 2, 0x66, 0x65, 0x61, 0x74]));
	writeFileSync(join(root, "dir", "new.txt"), "moved content\nline two\nline three\nrenamed too\n");
	rmSync(join(root, "dir", "old.txt"));
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "f1 feature work"]);

	writeFileSync(join(root, "feature.txt"), "feature v1\nfeature v2\n");
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "f2 feature more"]);
	const headSha = g(["rev-parse", "HEAD"]).trim();

	writeFileSync(join(root, "staged.txt"), "staged line v2\n");
	g(["add", "staged.txt"]);
	writeFileSync(join(root, "unstaged.txt"), "unstaged line v2\n");
	writeFileSync(join(root, "untracked.txt"), "untracked\n");
	mkdirSync(join(root, "untracked_dir"));
	writeFileSync(join(root, "untracked_dir", "nested.txt"), "nested\n");
	mkdirSync(join(root, "sub", "deep"), { recursive: true });

	g(["update-ref", "refs/remotes/origin/main", mainSha]);
	return { root, baseSha, mainSha, headSha };
}

const repo = buildFixtureRepo();
const FIX = {
	base: repo.baseSha,
	main: repo.mainSha,
	head: repo.headSha,
};

after(() => {
	for (const dir of [repo.root, gitConfigIsolationDir]) {
		try {
			rmSync(dir, { recursive: true, force: true });
		} catch {
			/* 清理失败不影响测试结论 */
		}
	}
});

function freshHost({ cwd = repo.root } = {}) {
	const host = createMockHost({ cwd, dir: join(tmpdir(), "git-review-plugin-dir") });
	gitReview.activate(host);
	return host;
}

/* ------------------------------------------------------------------ */
/* 一次性小仓库（截断/超限/空仓库测试用，避免污染共享 fixture 的形状）   */
/* ------------------------------------------------------------------ */

function makeScratchRepo(prefix) {
	const root = mkdtempSync(join(tmpdir(), prefix));
	const g = (...args) => execFileSync("git", args.flat(), { cwd: root, encoding: "utf8" });
	g(["init", "-q", "-b", "main", "."]);
	g(["config", "user.email", "test@example.com"]);
	g(["config", "user.name", "Test"]);
	return { root, g };
}

function lines(tag, n) {
	const out = [];
	for (let i = 0; i < n; i++) out.push(`line ${i} ${tag}\n`);
	return out.join("");
}

/* ------------------------------------------------------------------ */
/* 路由冒烟                                                             */
/* ------------------------------------------------------------------ */

describe("GET /review", () => {
	it("returns the pinned contract: base/head shas, statuses, counts, rename, flags", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/review", { query: { base: "main" } });
		assert.equal(out.ok, true);
		assert.deepEqual(out.base, { ref: "main", sha: FIX.main, source: "param" });
		assert.deepEqual(out.head, { sha: FIX.head });
		assert.equal(out.truncated, false);
		assert.equal(out.total, out.files.length);
		assert.deepEqual(out.files, [
			{ path: "bin.dat", status: "M", add: 0, del: 0, flags: [] },
			{ path: "del.txt", status: "D", add: 0, del: 1, flags: [] },
			{ path: "dir/new.txt", status: "R", oldPath: "dir/old.txt", add: 1, del: 0, flags: [] },
			{ path: "feature.txt", status: "A", add: 2, del: 0, flags: [] },
			{ path: "keep.txt", status: "M", add: 1, del: 0, flags: [] },
			{ path: "staged.txt", status: "M", add: 1, del: 1, flags: ["staged"] },
			{ path: "unstaged.txt", status: "M", add: 1, del: 1, flags: ["unstaged"] },
			{ path: "untracked.txt", status: "A", add: 0, del: 0, flags: ["untracked"] },
			{ path: "untracked_dir/nested.txt", status: "A", add: 0, del: 0, flags: ["untracked"] },
		]);
	});

	it("uses merge-base semantics: main-only changes never leak into a feature review", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/review", { query: { base: "main" } });
		assert.ok(!out.files.some((f) => f.path === "main.txt"));
	});

	it("accepts a full sha as base", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/review", { query: { base: FIX.base } });
		assert.equal(out.base.sha, FIX.base);
		assert.equal(out.base.source, "param");
	});

	it("falls back to the stored marker when base is omitted (R4)", async () => {
		const host = freshHost();
		await callRoute(host, "POST", "/marker", { body: { sha: FIX.base } });
		const out = await callRoute(host, "GET", "/review", {});
		assert.equal(out.base.source, "marker");
		assert.equal(out.base.sha, FIX.base);
		// marker = base → 范围与 ?base=<base> 完全一致
		assert.equal(out.files.length, 9);
	});

	it("no marker → mainline default (R4); empty range when marker == HEAD", async () => {
		const host = freshHost();
		// fixture 建了 refs/remotes/origin/main —— R4 候选顺序里它排在裸 main 前面
		const out = await callRoute(host, "GET", "/review", {});
		assert.equal(out.base.source, "default");
		assert.equal(out.base.ref, "origin/main");
		// 空串 base 等同于未提供（照样走缺省规则）
		const emptyParam = await callRoute(host, "GET", "/review", { query: { base: "" } });
		assert.equal(emptyParam.base.source, "default");
		await callRoute(host, "POST", "/marker", { body: { sha: FIX.head } });
		const sinceHead = await callRoute(host, "GET", "/review", {});
		// 基线 = HEAD → 只剩未提交/未跟踪改动
		assert.deepEqual(
			sinceHead.files.map((f) => f.path),
			["staged.txt", "unstaged.txt", "untracked.txt", "untracked_dir/nested.txt"],
		);
	});

	it("unknown base → {ok:false,error} (R13)", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/review", { query: { base: "no-such-ref" } });
		assert.equal(out.ok, false);
		assert.match(out.error, /no-such-ref|unknown|resolve/i);
	});

	it("stale marker (commit gone) → structured error, not a crash (R13)", async () => {
		const host = freshHost();
		const root = (await callRoute(host, "GET", "/marker", {})).repoRoot;
		host.__storage.set(markerKey(root), "f".repeat(40));
		const out = await callRoute(host, "GET", "/review", {});
		assert.equal(out.ok, false);
		assert.match(out.error, /stale review marker/);
	});

	it("corrupt marker (stored value is not a sha) → 'corrupt' wording, same recovery path (R13)", async () => {
		const host = freshHost();
		const root = (await callRoute(host, "GET", "/marker", {})).repoRoot;
		host.__storage.set(markerKey(root), "not-a-sha");
		const out = await callRoute(host, "GET", "/review", {});
		assert.equal(out.ok, false);
		assert.match(out.error, /corrupt review marker/);
		assert.match(out.error, /not a valid commit hash/);
		assert.doesNotMatch(out.error, /no longer exists|stale review marker/);
	});

	it("rejects injected-looking bases without running them (R14)", async () => {
		const host = freshHost();
		for (const bad of ["-x", "--", "a\nb", "a b"]) {
			const out = await callRoute(host, "GET", "/review", { query: { base: bad } });
			assert.equal(out.ok, false, `base=${JSON.stringify(bad)}`);
		}
	});
});

describe("GET /diff", () => {
	it("returns structured hunks with old/new line numbers", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/diff", { query: { path: "keep.txt", base: "main" } });
		assert.equal(out.ok, true);
		assert.equal(out.status, "M");
		assert.equal(out.binary, false);
		assert.equal(out.truncated, false);
		assert.equal(out.base.sha, FIX.main);
		assert.deepEqual(out.hunks, [
			{
				oldStart: 1,
				oldLines: 1,
				newStart: 1,
				newLines: 2,
				lines: [
					{ type: "ctx", old: 1, new: 1, text: "keep" },
					{ type: "add", new: 2, text: "changed" },
				],
			},
		]);
	});

	it("rename: anchored to the new path with oldPath from the patch header", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/diff", { query: { path: "dir/new.txt", base: "main" } });
		assert.equal(out.ok, true);
		assert.equal(out.status, "R");
		assert.equal(out.oldPath, "dir/old.txt");
		assert.deepEqual(out.hunks[0].lines, [
			{ type: "ctx", old: 1, new: 1, text: "moved content" },
			{ type: "ctx", old: 2, new: 2, text: "line two" },
			{ type: "ctx", old: 3, new: 3, text: "line three" },
			{ type: "add", new: 4, text: "renamed too" },
		]);
	});

	it("new file → status A; deleted file → status D with deletions only", async () => {
		const host = freshHost();
		const added = await callRoute(host, "GET", "/diff", { query: { path: "feature.txt", base: "main" } });
		assert.equal(added.status, "A");
		assert.deepEqual(added.hunks[0].lines.map((l) => l.type), ["add", "add"]);
		const deleted = await callRoute(host, "GET", "/diff", { query: { path: "del.txt", base: "main" } });
		assert.equal(deleted.status, "D");
		assert.deepEqual(deleted.hunks[0].lines, [{ type: "del", old: 1, text: "delete me" }]);
	});

	it("binary file → binary placeholder, zero hunks", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/diff", { query: { path: "bin.dat", base: "main" } });
		assert.equal(out.ok, true);
		assert.equal(out.binary, true);
		assert.deepEqual(out.hunks, []);
	});

	it("tracked file outside the review range → ok, zero hunks, no status and no untracked flag", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/diff", { query: { path: "main.txt", base: "main" } });
		assert.equal(out.ok, true);
		assert.deepEqual(out.hunks, []);
		assert.equal(out.status, undefined);
		assert.equal(out.untracked, undefined); // 已跟踪但不在范围 ≠ 未跟踪（两种空态可辨）
	});

	it("untracked file → ok, zero hunks, untracked:true (distinguishable from out-of-range)", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/diff", { query: { path: "untracked.txt", base: "main" } });
		assert.equal(out.ok, true);
		assert.deepEqual(out.hunks, []);
		assert.equal(out.status, undefined);
		assert.equal(out.untracked, true);
	});

	it("failure paths: missing path, unsafe path, unknown base (R13/R14)", async () => {
		const host = freshHost();
		assert.equal((await callRoute(host, "GET", "/diff", { query: { base: "main" } })).ok, false);
		assert.equal((await callRoute(host, "GET", "/diff", { query: { path: "-x", base: "main" } })).ok, false);
		assert.equal((await callRoute(host, "GET", "/diff", { query: { path: "../escape", base: "main" } })).ok, false);
		assert.equal(
			(await callRoute(host, "GET", "/diff", { query: { path: "keep.txt", base: "ghost" } })).ok,
			false,
		);
	});
});

describe("truncation caps (R16 / oversized-diff two-tier semantics)", () => {
	it("/diff: patch over MAX_PATCH_CHARS → truncated:true with hunks still parsed (tier 1)", async () => {
		const { root, g } = makeScratchRepo("git-review-trunc-");
		try {
			// 4000 行整文件重写 → 原始补丁约 150KB：超 MAX_PATCH_CHARS(120KB)，远低于 16MB
			writeFileSync(join(root, "big.txt"), lines("original", 4000));
			g(["add", "-A"]);
			g(["commit", "-q", "-m", "base"]);
			writeFileSync(join(root, "big.txt"), lines("rewritten", 4000));
			// 前置自检：fixture 必须真的超限，否则本测试失去意义
			const rawLen = g([
				"diff",
				"--no-color",
				"--no-ext-diff",
				"--find-renames",
				"HEAD",
				"--",
				"big.txt",
			]).length;
			assert.ok(rawLen > MAX_PATCH_CHARS, `fixture patch must exceed the cap (got ${rawLen})`);

			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/diff", { query: { path: "big.txt", base: "main" } });
			assert.equal(out.ok, true); // 一级：仍是完整可用结果，只是截尾
			assert.equal(out.truncated, true);
			assert.equal(out.status, "M");
			assert.ok(out.hunks.length >= 1);
			assert.ok(out.hunks.some((h) => h.lines.length > 0), "parsed hunks still carry lines");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("/diff: raw output beyond the 16 MB process cap → {ok:false,error}, not a timeout (tier 2)", async () => {
		const { root, g } = makeScratchRepo("git-review-huge-");
		try {
			// 50 万行全量重写 → 原始 diff ≈ 22MB > MAX_GIT_OUTPUT(16MB)。实测生成 <1s，可负担；
			// 这是两级语义的「失败腿」（Phase 1 验收：oversized-diff → {ok:false,error}）。
			writeFileSync(join(root, "huge.txt"), lines("original", 500_000));
			g(["add", "-A"]);
			g(["commit", "-q", "-m", "base"]);
			writeFileSync(join(root, "huge.txt"), lines("rewritten", 500_000));

			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/diff", { query: { path: "huge.txt", base: "main" } });
			assert.equal(out.ok, false);
			assert.match(out.error, /output too large/);
			assert.doesNotMatch(out.error, /timed out/); // maxBuffer 超限 ≠ 超时（killed 歧义）
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("/review: file list beyond MAX_FILES → truncated:true, total preserved, slice at cap", async () => {
		const { root, g } = makeScratchRepo("git-review-many-");
		try {
			writeFileSync(join(root, "base.txt"), "base\n");
			g(["add", "-A"]);
			g(["commit", "-q", "-m", "base"]);
			const baseSha = g(["rev-parse", "HEAD"]).trim();
			for (let i = 0; i < MAX_FILES + 1; i++) {
				writeFileSync(join(root, `bulk_${String(i).padStart(4, "0")}.txt`), `content ${i}\n`);
			}
			g(["add", "-A"]);
			g(["commit", "-q", "-m", "bulk"]);

			// 基线用第一笔提交的 sha（main 的 tip 已是 bulk 提交本身，指它 diff 为空）
			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/review", { query: { base: baseSha } });
			assert.equal(out.ok, true);
			assert.equal(out.truncated, true);
			assert.equal(out.total, MAX_FILES + 1); // total 不撒谎
			assert.equal(out.files.length, MAX_FILES); // 只返回上限条数
			assert.equal(out.files[0].path, "bulk_0000.txt");
			assert.equal(out.files[MAX_FILES - 1].path, `bulk_${String(MAX_FILES - 1).padStart(4, "0")}.txt`);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("GET /refs", () => {
	it("lists local + remote-tracking branches with current flag", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/refs", {});
		assert.equal(out.ok, true);
		assert.deepEqual(out.refs, [
			{ name: "feature", current: true },
			{ name: "main", current: false },
			{ name: "origin/main", current: false, remote: "origin" },
		]);
	});
});

describe("GET /commits", () => {
	it("lists recent commits of the current branch, newest first", async () => {
		const host = freshHost();
		const out = await callRoute(host, "GET", "/commits", {});
		assert.equal(out.ok, true);
		assert.deepEqual(
			out.commits.map((c) => c.subject),
			["f2 feature more", "f1 feature work", "base"],
		);
		assert.equal(out.commits[0].sha, FIX.head);
		assert.equal(out.commits[0].shortSha.length, 7);
		assert.equal(out.commits[2].sha, FIX.base);
	});

	it("honors limit; invalid limits are structured errors", async () => {
		const host = freshHost();
		const two = await callRoute(host, "GET", "/commits", { query: { limit: "2" } });
		assert.equal(two.commits.length, 2);
		assert.equal((await callRoute(host, "GET", "/commits", { query: { limit: "0" } })).ok, false);
		assert.equal((await callRoute(host, "GET", "/commits", { query: { limit: "abc" } })).ok, false);
		assert.equal((await callRoute(host, "GET", "/commits", { query: { limit: "100000" } })).ok, false);
	});

	it("empty repository (no commits yet) → catch-all branch pins {ok:true, commits:[]}", async () => {
		const { root } = makeScratchRepo("git-review-empty-");
		try {
			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/commits", {});
			assert.deepEqual(out, { ok: true, commits: [] });
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});

describe("GET/POST /marker", () => {
	it("starts null, stores a verified full hash, reads back", async () => {
		const host = freshHost();
		const initial = await callRoute(host, "GET", "/marker", {});
		assert.equal(initial.ok, true);
		assert.equal(initial.sha, null);
		// git 返回的是真实路径（realpath）—— macOS 的 /tmp → /private/tmp 也必须相等
		assert.equal(initial.repoRoot, realpathSync(repo.root));

		const short = FIX.head.slice(0, 8);
		const set = await callRoute(host, "POST", "/marker", { body: { sha: short } });
		assert.equal(set.ok, true);
		assert.equal(set.sha, FIX.head); // 校验并展开成完整哈希

		const back = await callRoute(host, "GET", "/marker", {});
		assert.equal(back.sha, FIX.head);
	});

	it("rejects missing/garbage sha (R13)", async () => {
		const host = freshHost();
		assert.equal((await callRoute(host, "POST", "/marker", { body: {} })).ok, false);
		assert.equal((await callRoute(host, "POST", "/marker", { body: { sha: "junk!!" } })).ok, false);
		assert.equal((await callRoute(host, "POST", "/marker", { body: { sha: "-x" } })).ok, false);
		assert.equal((await callRoute(host, "POST", "/marker", { body: { sha: "9".repeat(40) } })).ok, false);
	});
});

describe("GET /resolve", () => {
	it("resolves refs and shas to the full commit hash", async () => {
		const host = freshHost();
		assert.deepEqual(await callRoute(host, "GET", "/resolve", { query: { ref: "main" } }), {
			ok: true,
			ref: "main",
			sha: FIX.main,
		});
		assert.equal((await callRoute(host, "GET", "/resolve", { query: { ref: "HEAD" } })).sha, FIX.head);
		assert.equal((await callRoute(host, "GET", "/resolve", { query: { ref: FIX.base } })).sha, FIX.base);
	});
	it("structured errors for missing/unknown ref", async () => {
		const host = freshHost();
		assert.equal((await callRoute(host, "GET", "/resolve", {})).ok, false);
		assert.equal((await callRoute(host, "GET", "/resolve", { query: { ref: "ghost" } })).ok, false);
	});
});

describe("non-repo and repo-root anchoring", () => {
	it("non-repo cwd → {ok:false,error:'not a git repository'} on every route (R13)", async () => {
		const bare = mkdtempSync(join(tmpdir(), "git-review-bare-"));
		try {
			const host = freshHost({ cwd: bare });
			for (const [method, path, opts] of [
				["GET", "/review", { query: { base: "main" } }],
				["GET", "/diff", { query: { path: "x", base: "main" } }],
				["GET", "/refs", {}],
				["GET", "/commits", {}],
				["GET", "/marker", {}],
			]) {
				const out = await callRoute(host, method, path, opts);
				assert.equal(out.ok, false, `${method} ${path}`);
				assert.match(out.error, /not a git repository/);
			}
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("host.cwd inside a subdirectory still anchors queries at the repo root", async () => {
		const host = freshHost({ cwd: join(repo.root, "sub", "deep") });
		const marker = await callRoute(host, "GET", "/marker", {});
		assert.equal(marker.repoRoot, realpathSync(repo.root)); // key follows the repository, not the cwd
		const out = await callRoute(host, "GET", "/review", { query: { base: "main" } });
		assert.equal(out.ok, true);
		assert.equal(out.files.length, 9);
		// 仓库根相对的 pathspec 在子目录 cwd 下也必须命中
		const diff = await callRoute(host, "GET", "/diff", { query: { path: "keep.txt", base: "main" } });
		assert.equal(diff.ok, true);
		assert.equal(diff.hunks.length, 1);
	});

	it("cwd change triggers onCwdChange wiring (broadcast re-push)", async () => {
		const host = freshHost();
		host.__setCwd(join(repo.root, "sub"));
		assert.equal(host.__broadcasts.length, 1);
		assert.deepEqual(host.__broadcasts[0], { kind: "cwd-changed" });
	});
});

describe("client skeleton (role detection + shared store)", () => {
	it("detectRole: .plugin-page-host (self or ancestor) = navigator, default-else = viewer", () => {
		const navigatorEl = { classList: { contains: (c) => c === "plugin-page-host" } };
		const childEl = { classList: { contains: () => false }, parentElement: navigatorEl };
		const viewerEl = { classList: { contains: () => false }, parentElement: null };
		assert.equal(detectRole(navigatorEl), "navigator");
		assert.equal(detectRole(childEl), "navigator");
		assert.equal(detectRole(viewerEl), "viewer");
		assert.equal(detectRole(undefined), "viewer");
		assert.equal(detectRole({}), "viewer");
	});

	it("store is a module-level singleton with subscribe/unsubscribe", () => {
		const before = getState().selectedPath;
		let seen = 0;
		const off = subscribe(() => {
			seen += 1;
		});
		setState({ selectedPath: "keep.txt" });
		assert.equal(getState().selectedPath, "keep.txt");
		assert.ok(seen >= 1);
		off();
		setState({ selectedPath: before });
		assert.equal(seen, 1); // 退订后不再收到通知
	});

	it("apiBaseFromUrl derives /plugins-api/git-review (sub-path-deploy safe)", () => {
		assert.equal(
			apiBaseFromUrl("http://h:1234/pi/plugins/git-review/client/entry.mjs?e=3"),
			"http://h:1234/pi/plugins-api/git-review",
		);
		assert.equal(
			apiBaseFromUrl("http://h/plugins/git-review/client/entry.mjs"),
			"http://h/plugins-api/git-review",
		);
	});
});
