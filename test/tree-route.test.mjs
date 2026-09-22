/**
 * tree-route.test.mjs —— GET /tree 路由（Phase 2 新增，R6/R16）的契约测试。
 *
 * 自带宿主桩 + 真实临时 git 仓库（与 server-smoke.test.mjs 同一套模式，刻意自含：
 * 不共享 fixture，避免两个套件互相污染仓库形状）。断言：
 *   - 形态：{ ok, files:[仓库根相对路径…], total, truncated }，排序稳定；
 *   - untracked（含子目录内）经 status -uall 并入；
 *   - 工作树删除但未提交的文件仍在（git ls-files 的索引语义，spec R6 指定数据源）；
 *   - host.cwd 在子目录时路径仍是仓库根相对；
 *   - 非 git 仓库 → { ok:false, error:/not a git repository/ }（R13 失败阶梯）；
 *   - 超 MAX_FILES → truncated:true、total 保全、files 截到上限（R16）。
 */
import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { mkdtempSync, mkdirSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import gitReview from "../index.mjs";
import { MAX_FILES } from "../client/gitcore.mjs";

// 测试进程的 git 环境隔离（server-smoke 同款）：空配置、不交互。必须在任何 git 调用前生效。
const gitConfigIsolationDir = mkdtempSync(join(tmpdir(), "git-review-tree-cfg-"));
const emptyGitConfigPath = join(gitConfigIsolationDir, "gitconfig");
writeFileSync(emptyGitConfigPath, "");
process.env.GIT_CONFIG_GLOBAL = emptyGitConfigPath;
process.env.GIT_CONFIG_SYSTEM = emptyGitConfigPath;
process.env.GIT_CONFIG_NOSYSTEM = "1";
process.env.GIT_TERMINAL_PROMPT = "0";

/* ------------------------------------------------------------------ */
/* 宿主桩（server-smoke 同款 createMockHost 最小面）                     */
/* ------------------------------------------------------------------ */

function createMockHost({ cwd }) {
	const routes = new Map();
	const storageMap = new Map();
	let currentCwd = cwd;
	return {
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
		onCwdChange() {
			return () => {};
		},
		broadcast() {},
		notify() {},
		log() {},
		__routes: routes,
		__setCwd(value) {
			currentCwd = value;
		},
	};
}

async function callRoute(host, method, path, { query } = {}) {
	const handler = host.__routes.get(`${method} ${path}`);
	assert.ok(handler, `route not registered: ${method} ${path}`);
	const res = {
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
	await handler({ query: query ?? {} }, res);
	assert.ok(res.headersSent, `handler must respond: ${method} ${path}`);
	return res.payload;
}

function freshHost({ cwd }) {
	const host = createMockHost({ cwd });
	gitReview.activate(host);
	return host;
}

function gitIn(cwd, args) {
	return execFileSync("git", args.flat(), { cwd, encoding: "utf8" });
}

/**
 * 小仓库：已跟踪三个文件（其中一个嵌套目录）。withWorktreeChanges 为 true 时
 * 追加未提交删除（索引里还在）+ 未跟踪两个（根与子目录各一）。
 */
function buildSmallRepo({ withWorktreeChanges = true } = {}) {
	const root = mkdtempSync(join(tmpdir(), "git-review-tree-"));
	const g = (...args) => gitIn(root, args);
	g(["init", "-q", "-b", "main", "."]);
	g(["config", "user.email", "test@example.com"]);
	g(["config", "user.name", "Test"]);
	writeFileSync(join(root, "a.txt"), "a\n");
	writeFileSync(join(root, "b.txt"), "b\n");
	mkdirSync(join(root, "dir"));
	writeFileSync(join(root, "dir", "nested.txt"), "nested\n");
	g(["add", "-A"]);
	g(["commit", "-q", "-m", "base"]);
	if (withWorktreeChanges) {
		rmSync(join(root, "b.txt"));
		writeFileSync(join(root, "untracked.txt"), "u\n");
		mkdirSync(join(root, "untracked_dir"));
		writeFileSync(join(root, "untracked_dir", "deep.txt"), "d\n");
	}
	return { root, g };
}

after(() => {
	try {
		rmSync(gitConfigIsolationDir, { recursive: true, force: true });
	} catch {
		/* 清理失败不影响结论 */
	}
});

describe("GET /tree", () => {
	it("lists tracked files root-relative and sorted, with total/truncated contract", async () => {
		const { root } = buildSmallRepo({ withWorktreeChanges: false });
		try {
			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.equal(out.ok, true);
			assert.equal(out.truncated, false);
			assert.equal(out.total, out.files.length);
			assert.deepEqual(out.files, ["a.txt", "b.txt", "dir/nested.txt"]);
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("merges untracked files (including nested dirs) from status -uall", async () => {
		const { root } = buildSmallRepo();
		try {
			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.ok(out.files.includes("untracked.txt"));
			assert.ok(out.files.includes("untracked_dir/deep.txt"));
			assert.deepEqual(out.files, [...out.files].sort()); // 并入后仍有序
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("keeps worktree-deleted but not-yet-committed files (git ls-files index semantics, R6 source)", async () => {
		const { root } = buildSmallRepo();
		try {
			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.ok(out.files.includes("b.txt"), "deleted-from-worktree tracked file stays listed");
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("paths stay repo-root-relative when host.cwd points into a subdirectory", async () => {
		const { root } = buildSmallRepo();
		try {
			const host = freshHost({ cwd: join(root, "dir") });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.ok(out.files.includes("a.txt"));
			assert.ok(!out.files.some((p) => p.startsWith("dir/dir/")));
			const marker = await callRoute(host, "GET", "/marker", {});
			assert.equal(marker.repoRoot, realpathSync(root)); // 查询仍锚定仓库根
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});

	it("non-repo workspace → { ok:false, error:'not a git repository' } (R13)", async () => {
		const bare = mkdtempSync(join(tmpdir(), "git-review-tree-bare-"));
		try {
			const host = freshHost({ cwd: bare });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.equal(out.ok, false);
			assert.match(out.error, /not a git repository/);
		} finally {
			rmSync(bare, { recursive: true, force: true });
		}
	});

	it("cap: over MAX_FILES → truncated:true, total preserved, slice at cap (R16)", async () => {
		const root = mkdtempSync(join(tmpdir(), "git-review-tree-cap-"));
		try {
			const g = (...args) => gitIn(root, args);
			g(["init", "-q", "-b", "main", "."]);
			g(["config", "user.email", "test@example.com"]);
			g(["config", "user.name", "Test"]);
			for (let i = 0; i < MAX_FILES; i++) {
				writeFileSync(join(root, `bulk_${String(i).padStart(4, "0")}.txt`), `content ${i}\n`);
			}
			g(["add", "-A"]);
			g(["commit", "-q", "-m", "bulk"]);
			// 两个 untracked 顶破上限：total = MAX_FILES + 2
			writeFileSync(join(root, "extra_a.txt"), "a\n");
			writeFileSync(join(root, "extra_b.txt"), "b\n");

			const host = freshHost({ cwd: root });
			const out = await callRoute(host, "GET", "/tree", {});
			assert.equal(out.ok, true);
			assert.equal(out.truncated, true);
			assert.equal(out.total, MAX_FILES + 2); // total 不撒谎
			assert.equal(out.files.length, MAX_FILES); // 截到与 /review 同一上限
			assert.equal(out.files[0].path ?? out.files[0], "bulk_0000.txt");
			assert.ok(!out.files.some((p) => p.startsWith("extra_"))); // 排序靠后被截掉
		} finally {
			rmSync(root, { recursive: true, force: true });
		}
	});
});
