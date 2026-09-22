/**
 * git-review —— 服务端入口（受信任的全 Node 代码，`export default { activate(host) }`）。
 *
 * 职责（spec 001 Phase 1 / R2、R4、R13、R14）：把宿主工作区（host.cwd，活的 getter）
 * 的 git 查询包成只读 HTTP 服务，挂在 host.route 下（实际暴露为
 * `/plugins-api/git-review/*`）。所有 git 访问都在这里：`execFile("git", …)`
 * 直接跑 —— 不过 shell、argv 数组、`core.quotepath=false`、15s/16MB 上限，
 * 镜像宿主 SCM 面板自己的做法（server/scm.ts）。客户端只渲染。
 *
 * 路由一览（字段级契约，Phase 2–4 消费）：
 *   GET  /review?base=   → { ok, base:{ref,sha,source}, head:{sha},
 *                            files:[{path,status,oldPath?,add,del,flags}], total, truncated }
 *                          —— base 缺省依次取：?base= → 存储 marker（stale 则结构化报错）
 *                             → 主线候选（origin/HEAD, origin/main, origin/master, main, master）。
 *                             评审范围 = merge-base(base, HEAD) → 工作树 的 diff
 *                            （把未提交改动自动并入同一范围），untracked 来自并行
 *                             `git status --porcelain -uall`。
 *   GET  /diff?path=&base=&context= → { ok, path, base:{ref,sha}, status, oldPath?, binary,
 *                              truncated, hunks:[{oldStart,oldLines,newStart,newLines,
 *                              lines:[{type:"ctx"|"add"|"del",old?,new?,text}]}] }
 *                          —— 状态/oldPath 从补丁自身文件头推导（rename from/to、
 *                             new/deleted file mode）；不用 pathspec 查 name-status，
 *                             因为 pathspec 会拆散 rename 检测（实测确认）。
 *                             context 是 Phase 3 折叠空隙「点击展开」的可选参数：
 *                             缺省（无参数）不加 -U（git 缺省 3 行，与 Phase 1 一致），
 *                             给出则转成 -U<width> 重取更宽上下文（空隙变成 ctx 行，
 *                             空隙收拢/两 hunk 合并），0..MAX_CONTEXT 外结构化报错。
 *   GET  /refs           → { ok, refs:[{name,current,remote?}] }（本地 + 远程跟踪）
 *   GET  /commits?limit= → { ok, commits:[{sha,shortSha,author,date,subject}] }
 *   GET  /marker         → { ok, sha: string|null, repoRoot }（每仓库根一个 key）
 *   POST /marker {sha}   → { ok, sha }（先 rev-parse 校验成完整哈希再存）
 *   GET  /resolve?ref=   → { ok, ref, sha }（ref → 完整提交哈希；基线选择器用）
 *   GET  /tree           → { ok, files:[path…], total, truncated }（全工作区文件树，R6：
 *                          `git ls-files` + status untracked 并入，仓库根相对，截断同 /review）
 *
 * 每条失败路径都是结构化 `{ ok:false, error }`（R13）：不是 git 仓库、未知/非法
 * base、stale marker、非法参数……一律可恢复错误，绝不抛穿。HTTP 状态保持 200，
 * 由客户端看 ok 字段（与宿主 notes 插件同口径）。
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";
import {
	DEFAULT_BASE_CANDIDATES,
	GIT_TIMEOUT_MS,
	MAX_FILES,
	MAX_GIT_OUTPUT,
	MAX_PATCH_CHARS,
	capPatch,
	markerKey,
	parseBranches,
	parseNameStatus,
	parseNumStatZ,
	parseStatusFiles,
	parseUnifiedDiff,
	parseLsFilesZ,
	validateContext,
	validateLimit,
	validatePath,
	validateRef,
} from "./client/gitcore.mjs";

const execGitRaw = promisify(execFile);

/** R14：只放行白名单内的只读 git 子命令（diff/log/status/ls-files/rev-parse/
 *  merge-base/for-each-ref 族）。git 永远不经 shell。 */
const ALLOWED_SUBCOMMANDS = new Set([
	"diff",
	"log",
	"status",
	"ls-files",
	"rev-parse",
	"merge-base",
	"for-each-ref",
]);

/** 跑一条 git 命令并映射错误（server/scm.ts:59 git() 镜像，英文文案——
 *  服务端错误是技术性消息，用户可见的 zh/en 文案在客户端做）。 */
async function git(cwd, args) {
	if (!ALLOWED_SUBCOMMANDS.has(args[0])) {
		throw new Error(`git subcommand not allowed: ${String(args[0])}`);
	}
	try {
		const { stdout } = await execGitRaw("git", ["-c", "core.quotepath=false", ...args], {
			cwd,
			timeout: GIT_TIMEOUT_MS,
			maxBuffer: MAX_GIT_OUTPUT,
			windowsHide: true,
		});
		return stdout;
	} catch (err) {
		const e = err ?? {};
		if (e.code === "ENOENT") throw new Error("git command not found — make sure Git is installed and on PATH");
		// 输出超 maxBuffer：新 Node（v21+）报 ERR_CHILD_PROCESS_STDIO_MAXBUFFER（不置
		// killed），旧 Node 报 ENOBUFS（且 killed 同样被置位）——必须先于 killed 判断，
		// 否则超大 diff 会被误报成超时（两级截断语义的「失败腿」，见 diffPayload 注释）。
		if (e.code === "ENOBUFS" || e.code === "ERR_CHILD_PROCESS_STDIO_MAXBUFFER") {
			throw new Error("git output too large (exceeds the 16 MB output cap)");
		}
		if (e.killed) throw new Error("git command timed out");
		const detail = String(e.stderr ?? e.message ?? "").trim().split("\n")[0];
		throw new Error(detail || "git command failed");
	}
}

function isNotRepoError(err) {
	return /not a git repository/i.test(err instanceof Error ? err.message : String(err));
}

function notRepoError() {
	const e = new Error("not a git repository");
	e.notRepo = true;
	return e;
}

/** 宿主工作区所在的仓库根（`git rev-parse --show-toplevel`）；后续所有查询都
 *  锚定在根上跑，这样客户端给的 pathspec 恒为仓库根相对（host.cwd 可能是子目录）。 */
async function repoRootOf(host) {
	try {
		const out = await git(host.cwd, ["rev-parse", "--show-toplevel"]);
		const root = out.trim();
		if (root) return root;
	} catch (err) {
		if (isNotRepoError(err)) throw notRepoError();
		throw err;
	}
	throw notRepoError();
}

/** ref → 完整提交哈希（`rev-parse --verify <ref>^{commit}`；tag 会剥到提交）。 */
async function revParseCommit(root, ref) {
	const out = await git(root, ["rev-parse", "--verify", `${ref}^{commit}`]);
	const sha = out.trim();
	if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error(`cannot resolve ref: ${ref}`);
	return sha;
}

async function mergeBaseWithHead(root, baseSha) {
	const out = await git(root, ["merge-base", baseSha, "HEAD"]);
	const sha = out.trim();
	if (!/^[0-9a-f]{40,64}$/.test(sha)) throw new Error("merge-base failed");
	return sha;
}

/**
 * 解析评审基线：?base= 优先；否则存储的 marker（stale → 结构化报错，R13：
 * rebase 后提示手动选基线而不是悄悄换语义）；否则主线候选（R4）。
 */
async function resolveBase(host, root, rawBase) {
	const given = typeof rawBase === "string" ? rawBase : "";
	if (given.trim() !== "") {
		const ref = validateRef(given);
		let sha;
		try {
			sha = await revParseCommit(root, ref);
		} catch {
			throw new Error(`unknown base: ${ref}`);
		}
		return { ref, sha, source: "param" };
	}
	const stored = host.storage.get(markerKey(root));
	if (typeof stored === "string" && stored !== "") {
			try {
				const sha = await revParseCommit(root, validateRef(stored));
				return { ref: stored, sha, source: "marker" };
			} catch {
				// 同一条恢复路径（提示手动选基线），但区分两种病因的文案：存储值根本不是
				// 哈希（storage.json 被手改/损坏）≠ 曾是有效提交但已不存在（rebase/amend）。
				// POST /marker 只会存完整哈希，所以非完整哈希一律按「损坏」报告。
				if (/^[0-9a-f]{40,64}$/i.test(stored)) {
					throw new Error(`stale review marker: commit ${stored} no longer exists — pick a base manually`);
				}
				throw new Error(
					`corrupt review marker: ${JSON.stringify(stored)} is not a valid commit hash — pick a base manually`,
				);
			}
	}
	for (const candidate of DEFAULT_BASE_CANDIDATES) {
		try {
			const sha = await revParseCommit(root, candidate);
			return { ref: candidate, sha, source: "default" };
		} catch {
			/* 候选不存在 → 试下一个 */
		}
	}
	throw new Error("no review base: no stored marker and none of origin/HEAD, origin/main, origin/master, main, master resolves — pass ?base=");
}

/** 从 porcelain 状态推导每文件 flags（R3）：staged/unstaged/untracked。 */
function flagsFor(statusEntry) {
	const flags = [];
	if (!statusEntry) return flags;
	if (statusEntry.x === "?" && statusEntry.y === "?") {
		flags.push("untracked");
		return flags;
	}
	if (statusEntry.x !== " " && statusEntry.x !== "?") flags.push("staged");
	if (statusEntry.y !== " " && statusEntry.y !== "?") flags.push("unstaged");
	return flags;
}

/** /review：merge-base(base, HEAD) → 工作树 的变更清单 + untracked 并入。 */
async function reviewPayload(host, root, rawBase) {
	const base = await resolveBase(host, root, rawBase);
	const mb = await mergeBaseWithHead(root, base.sha);
	const headSha = await revParseCommit(root, "HEAD");
	const [nameStatusText, numstatText, statusText] = await Promise.all([
		git(root, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--name-status", mb]),
		git(root, ["diff", "--no-color", "--no-ext-diff", "--find-renames", "--numstat", "-z", mb]),
		git(root, ["status", "--porcelain=v1", "--find-renames", "--untracked-files=all"]),
	]);
	const counts = parseNumStatZ(numstatText);
	const statusMap = new Map(parseStatusFiles(statusText).map((f) => [f.path, f]));

	const files = [];
	const seen = new Set();
	for (const entry of parseNameStatus(nameStatusText)) {
		if (seen.has(entry.path)) continue;
		seen.add(entry.path);
		const [add, del] = counts[entry.path] ?? [0, 0];
		files.push({
			path: entry.path,
			status: entry.status,
			...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
			add,
			del,
			flags: flagsFor(statusMap.get(entry.path)),
		});
	}
	// untracked 文件 git diff 永远不列 —— 从并行 status 并入（R3），标记 untracked。
	for (const f of parseStatusFiles(statusText)) {
		if (f.x !== "?" || f.y !== "?" || seen.has(f.path)) continue;
		seen.add(f.path);
		files.push({ path: f.path, status: "A", add: 0, del: 0, flags: ["untracked"] });
	}
	files.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
	const total = files.length;
	// 一级截断（R16）：清单条数超 MAX_FILES → 照常返回，截到上限并置 truncated:true
	// （Phase 2 渲染「N more files」提示）。输出超过 16MB 进程上限的另一级语义见
	// diffPayload 的两级注释 —— /review 的 name-status/numstat 输出很小，实际到不了那一级。
	const truncated = total > MAX_FILES;
	return {
		ok: true,
		base,
		head: { sha: headSha },
		files: truncated ? files.slice(0, MAX_FILES) : files,
		total,
		truncated,
	};
}

/** /tree：全工作区文件树（R6）= `git ls-files`（已跟踪）+ status untracked 并入。
 *  与 /review 同一个条数上限（MAX_FILES）与截断语义（total 保全、truncated:true），
 *  树结构由客户端从平铺路径自建 —— 服务端只给排序后的去重路径数组。 */
async function treePayload(root) {
	const [lsOut, statusText] = await Promise.all([
		git(root, ["ls-files", "-z"]),
		git(root, ["status", "--porcelain=v1", "--untracked-files=all"]),
	]);
	const seen = new Set();
	const files = [];
	for (const p of parseLsFilesZ(lsOut)) {
		if (seen.has(p)) continue;
		seen.add(p);
		files.push(p);
	}
	// untracked 与 ls-files 不相交，但 status 一次查询还兼着「将来加别的来源」的口子，
	// 照 /review 的并入写法保持一致。
	for (const f of parseStatusFiles(statusText)) {
		if (f.x !== "?" || f.y !== "?" || seen.has(f.path)) continue;
		seen.add(f.path);
		files.push(f.path);
	}
	files.sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
	const total = files.length;
	const truncated = total > MAX_FILES; // 与 /review 同一上限、同一截断语义（R16）
	return { ok: true, files: truncated ? files.slice(0, MAX_FILES) : files, total, truncated };
}

/** /diff：单文件 merge-base(base) → 工作树 补丁 → 结构化 hunks（R8/R16）。
 *
 * rename 的坑：pathspec 会拆散 rename 检测（`-- 新路径` 把 rename 显示成全量新增，
 * 实测确认）。所以先用**无 pathspec** 的 name-status 找到该文件的条目拿
 * status/oldPath，再把 old+new 两个路径一起放进 pathspec 重取补丁，让 rename 对
 * 成形、补丁锚定在新路径上。路径不在范围内 → ok + 零 hunk（客户端渲染空态）。 */
async function diffPayload(host, root, rawBase, rawPath, rawContext) {
	const base = await resolveBase(host, root, rawBase);
	const path = validatePath(String(rawPath ?? ""));
	// Phase 3 折叠展开：宽度缺省 undefined = argv 不加 -U（与 Phase 1 逐字节一致）；
	// 非法宽度在 validateContext 抛错 → withRepo 落 {ok:false,error}。
	const context = validateContext(rawContext);
	const headSha = await revParseCommit(root, "HEAD");
	const mb = await mergeBaseWithHead(root, base.sha);
	const nameStatusText = await git(root, [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--find-renames",
		"--name-status",
		mb,
	]);
	const entry = parseNameStatus(nameStatusText).find((e) => e.path === path);
	if (!entry) {
		// 不在 diff 范围内的 path 有两种：未跟踪文件（git diff 永远不列）和
		// 范围外已跟踪文件（如另一分支上改的）。用一次并行 porcelain 查询区分：
		// porcelain 里 x=y="?" 且 name-status 没有 → untracked:true；其余不置该字段，
		// status 保持 undefined —— 客户端三种空态各自可辨（范围外 / 未跟踪 / 报错）。
		const statusText = await git(root, ["status", "--porcelain=v1", "--untracked-files=all"]);
		const untracked = parseStatusFiles(statusText).some((f) => f.path === path && f.x === "?" && f.y === "?");
		return {
			ok: true,
			path,
			base,
			head: { sha: headSha },
			binary: false,
			truncated: false,
			hunks: [],
			...(untracked ? { untracked: true } : {}),
		};
	}
	const pathspecs = entry.oldPath !== undefined ? [entry.oldPath, path] : [path];
	const raw = await git(root, [
		"diff",
		"--no-color",
		"--no-ext-diff",
		"--find-renames",
		...(context === undefined ? [] : [`-U${context}`]),
		mb,
		"--",
		...pathspecs,
	]);
	// 超大 diff 的两级语义（R8/R16 × Phase 1 验收「oversized-diff → {ok:false,error}」）：
	//   一级（本行）：原始补丁 ≤ 16MB 进程输出上限 → 正常返回，但超 MAX_PATCH_CHARS 时
	//        capPatch 截尾并置 truncated:true —— 客户端渲染可见截断标记（R8），仍是完整可用结果。
	//   二级（git()）：原始输出 > 16MB maxBuffer → git 抛「git output too large」→
	//        本路由落成 {ok:false,error}（结构化失败，不做部分结果）。两级的分界由
	//        MAX_GIT_OUTPUT 与 MAX_PATCH_CHARS 的差值决定（16MB ≫ 120KB），不会抖动。
	const capped = capPatch(raw, MAX_PATCH_CHARS);
	const parsed = parseUnifiedDiff(capped);
	return {
		ok: true,
		path,
		base,
		head: { sha: headSha },
		status: entry.status,
		...(entry.oldPath !== undefined ? { oldPath: entry.oldPath } : {}),
		binary: parsed.binary,
		truncated: raw.length > MAX_PATCH_CHARS,
		hunks: parsed.hunks,
	};
}

export default {
	activate(host) {
		const offs = [];
		/** notes 插件的 route() 模式（plugins/notes/index.mjs:275-293）：handler
		 *  抛错由包装层转成结构化回包；async handler 的 rejection 也兜住。 */
		const route = (method, path, handler) => {
			offs.push(
				host.route(method, path, (req, res) => {
					return Promise.resolve()
						.then(() => handler(req, res))
						.catch((err) => {
							try {
								host.log("error", `git-review ${method} ${path} failed:`, err instanceof Error ? err.message : String(err));
							} catch {
								/* 日志失败不影响回包 */
							}
							if (res && !res.headersSent && typeof res.json === "function") {
								res.status(500).json({ ok: false, error: err instanceof Error ? err.message : String(err) });
							}
						});
				}),
			);
		};

		/** 通用骨架：解析仓库根 → 业务 → 任何异常都落成 {ok:false,error}（R13）。 */
		const withRepo = (fn) => async (req, res) => {
			try {
				const root = await repoRootOf(host);
				await fn(root, req, res);
			} catch (err) {
				res.json({ ok: false, error: err instanceof Error ? err.message : String(err) });
			}
		};

		route("GET", "/review", withRepo(async (root, req, res) => {
			res.json(await reviewPayload(host, root, req?.query?.base));
		}));

		route("GET", "/diff", withRepo(async (root, req, res) => {
			res.json(await diffPayload(host, root, req?.query?.base, req?.query?.path, req?.query?.context));
		}));

		route("GET", "/refs", withRepo(async (root, _req, res) => {
			const text = await git(root, [
				"for-each-ref",
				"refs/heads",
				"refs/remotes",
				"--format=%(refname)%09%(HEAD)",
			]);
			res.json({ ok: true, refs: parseBranches(text) });
		}));

		route("GET", "/commits", withRepo(async (root, req, res) => {
			const limit = validateLimit(req?.query?.limit);
			let text = "";
			try {
				// 空仓库（还没有任何提交）git log 会失败 —— 这是有用的「没有提交可选」
				// 答案，不是错误（与宿主 scmCommitContext 同口径）。
				// 注意：目前是 HEAD-only（只列当前分支）。Phase 2 的提交选择器若要跨分支
				// 选基线，可能需要加 --all —— 届时再扩，本阶段刻意不加（保持同口径）。
				text = await git(root, [
					"log",
					"-n",
					String(limit),
					"--date=short",
					"--pretty=format:%H%x09%h%x09%an%x09%ad%x09%s",
				]);
			} catch {
				res.json({ ok: true, commits: [] });
				return;
			}
			const commits = [];
			for (const line of text.split("\n")) {
				if (!line) continue;
				const fields = line.split("\t");
				if (fields.length < 5) continue;
				commits.push({
					sha: fields[0],
					shortSha: fields[1],
					author: fields[2],
					date: fields[3],
					// 提交说明本身可能含制表符 —— 说明是最后一个字段，重新拼回。
					subject: fields.slice(4).join("\t"),
				});
			}
			res.json({ ok: true, commits });
		}));

		route("GET", "/marker", withRepo(async (root, _req, res) => {
			const stored = host.storage.get(markerKey(root));
			res.json({ ok: true, sha: typeof stored === "string" && stored ? stored : null, repoRoot: root });
		}));

		route("POST", "/marker", withRepo(async (root, req, res) => {
			const raw = req?.body?.sha;
			if (typeof raw !== "string" || raw.trim() === "") {
				res.json({ ok: false, error: "missing sha" });
				return;
			}
			const ref = validateRef(raw);
			const sha = await revParseCommit(root, ref);
			host.storage.set(markerKey(root), sha);
			res.json({ ok: true, sha });
		}));

		route("GET", "/tree", withRepo(async (root, _req, res) => {
			res.json(await treePayload(root));
		}));

		route("GET", "/resolve", withRepo(async (root, req, res) => {
			const raw = req?.query?.ref;
			if (typeof raw !== "string" || raw.trim() === "") {
				res.json({ ok: false, error: "missing ref" });
				return;
			}
			const ref = validateRef(raw);
			let sha;
			try {
				sha = await revParseCommit(root, ref);
			} catch {
				res.json({ ok: false, error: `unknown ref: ${ref}` });
				return;
			}
			res.json({ ok: true, ref, sha });
		}));

		// 工作区切换后通知所有客户端重拉（host.cwd 是活的 getter，服务端不缓存）。
		offs.push(
			host.onCwdChange?.(() => {
				try {
					host.broadcast({ kind: "cwd-changed" });
				} catch {
					/* 广播失败无需处理 */
				}
			}) ?? (() => {}),
		);

		try {
			host.log("info", "[git-review] routes registered: /review /diff /refs /commits /marker /resolve /tree");
		} catch {
			/* 日志不可用也不影响激活 */
		}

		return () => {
			for (const off of offs.splice(0)) {
				try {
					off?.();
				} catch {
					/* 注销失败忽略 */
				}
			}
		};
	},
};
