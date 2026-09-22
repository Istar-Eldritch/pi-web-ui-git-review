/**
 * git-review —— 纯逻辑层（client/gitcore.mjs）。
 *
 * 无 Node 依赖、无 npm 依赖的纯 ESM：服务端入口 index.mjs 与客户端 bundle 共用，
 * node --test 可直接测（不需要宿主）。包含三类东西：
 *
 *   1. 安全护栏（R14）：ref/path 参数校验 —— 非空、无前导 `-`、无 `--`、
 *      无控制字符/换行；path 另加禁 `..` 段、禁绝对路径、禁 pathspec 魔法前缀。
 *   2. 解析器（镜像宿主 server/scm.ts 的语义）：
 *      parseStatusFiles（scm.ts:195 porcelain + rename「old -> new」拆分）、
 *      parseBranches（scm.ts:210 for-each-ref）、parseNumStat（scm.ts:261，
 *      二进制「-」→ 0、同路径累加）、parseNumStatZ（-z 变体，rename 无歧义）、
 *      parseNameStatus（--name-status 文本）、parseUnifiedDiff（统一 diff →
 *      hunks[{oldStart,oldLines,newStart,newLines,lines[]}]，行带 old/new 行号）。
 *   3. 常量与小工具：15s/16MB 超时与输出上限（scm.ts:16-17 同值）、
 *      capPatch（scm.ts:390 镜像）、仓库根 → storage key、默认基线候选。
 *
 * 为什么路由用 -z 的 numstat 而不是文本版：`--find-renames` 的文本 numstat 把
 * rename 显示为 `old => new`，而 git 对**文件名本身含「 => 」**的情况不加引号
 * （实测确认），文本形式无法无歧义拆分；-z 形式 rename 输出为
 * `add\tdel\u0000old\u0000new\u0000`，完全无歧义。文本版 parseNumStat 仍按宿主原样镜像提供。
 */

/* ------------------------------------------------------------------ */
/* 常量（与宿主 server/scm.ts:16-17 同值；R13 parity）                  */
/* ------------------------------------------------------------------ */

/** 单条 git 命令超时 —— 卡死的仓库不能挂住面板。 */
export const GIT_TIMEOUT_MS = 15_000;
/** 单条 git 命令输出上限。 */
export const MAX_GIT_OUTPUT = 16 * 1024 * 1024;

/** /diff 单文件补丁文本上限（capPatch 镜像 scs.ts:390 的结构；给查看器的
 *  预算是提交信息场景的 10 倍，仍远低于 16MB 进程输出上限）。 */
export const MAX_PATCH_CHARS = 120_000;
/** /review 文件清单条数上限（R16：cap ≥ 1000）。 */
export const MAX_FILES = 2_000;
/** /commits 缺省与上限条数。 */
export const DEFAULT_COMMIT_LIMIT = 30;
export const MAX_COMMIT_LIMIT = 200;

/** 无 marker 时的主线候选顺序（R4，客户端 /resolve 预选同一条规则）。 */
export const DEFAULT_BASE_CANDIDATES = ["origin/HEAD", "origin/main", "origin/master", "main", "master"];

/* ------------------------------------------------------------------ */
/* 安全护栏（R14）                                                      */
/* ------------------------------------------------------------------ */

const CONTROL_CHARS = /[\u0000-\u001F\u007F]/;
const REF_MAX = 512;
const PATH_MAX = 1024;

/**
 * 校验客户端提供的 ref（分支名/哈希/HEAD 表达式），合法原样返回，非法抛错。
 * 规则（R14）：非空、无前导 `-`（挡 `--exec` 这类选项注入）、无 `--`、
 * 无控制字符或换行、无任何空白（git 引用名本就禁止空白）、长度 ≤ 512。
 */
export function validateRef(value) {
	if (typeof value !== "string" || value.length === 0) throw new Error("invalid ref: empty");
	if (value.length > REF_MAX) throw new Error("invalid ref: too long");
	if (value.startsWith("-")) throw new Error("invalid ref: must not start with '-'");
	if (CONTROL_CHARS.test(value) || /\s/.test(value)) throw new Error("invalid ref: control characters or whitespace");
	return value;
}

/**
 * 校验客户端提供的路径（pathspec），合法原样返回，非法抛错。
 * 在 R14 基本规则之上追加（防御纵深，均不影响合法文件名）：
 * 禁 `..` 路径段（git 本身也会拒绝仓库外路径，这里提前拦）、
 * 禁前导 `/`（路径一律仓库根相对）、禁前导 `:`（pathspec 魔法语法）。
 */
export function validatePath(value) {
	if (typeof value !== "string" || value.length === 0) throw new Error("invalid path: empty");
	if (value.length > PATH_MAX) throw new Error("invalid path: too long");
	if (value.startsWith("-")) throw new Error("invalid path: must not start with '-'");
	if (value === "--") throw new Error("invalid path: must not be '--'");
	if (CONTROL_CHARS.test(value)) throw new Error("invalid path: control characters");
	if (value.startsWith("/") || value.startsWith(":")) throw new Error("invalid path: must be repo-relative");
	if (value.split("/").includes("..")) throw new Error("invalid path: must not contain '..'");
	return value;
}

/** 校验 /commits 的 limit：缺省回默认值；给出但非法/越界则抛错（严格口径）。 */
export function validateLimit(value, { fallback = DEFAULT_COMMIT_LIMIT, max = MAX_COMMIT_LIMIT } = {}) {
	if (value === undefined || value === null || String(value).trim() === "") return fallback;
	const n = Number(value);
	if (!Number.isInteger(n) || n < 1 || n > max) throw new Error(`invalid limit: ${JSON.stringify(value)}`);
	return n;
}

/* ------------------------------------------------------------------ */
/* 解析器（镜像宿主 server/scm.ts）                                     */
/* ------------------------------------------------------------------ */

/** 撤销 git 的 C 风格路径引号（"a\tb" → a<TAB>b）。
 *  core.quotepath=false 已兜住非 ASCII；这里兜控制字符。scm.ts:112 镜像。 */
export function unquotePath(s) {
	if (!s.startsWith('"')) return s;
	const inner = s.endsWith('"') ? s.slice(1, -1) : s.slice(1);
	return inner.replace(/\\(.)/g, (_m, c) => {
		switch (c) {
			case "n":
				return "\n";
			case "t":
				return "\t";
			case "r":
				return "\r";
			case "b":
				return "\b";
			case "a":
				return "\a";
			case "f":
				return "\f";
			case "v":
				return "\v";
			case "\\":
				return "\\";
			case '"':
				return '"';
			default:
				return c;
		}
	});
}

/** 解析 `git status --porcelain` 文本：`XY path`（rename 为 `XY old -> new`，
 *  取新路径）。scm.ts:195 parseStatusFiles 镜像。 */
export function parseStatusFiles(text) {
	const out = [];
	for (const rawLine of String(text).split("\n")) {
		const line = rawLine.trimEnd();
		if (!line || line.startsWith("## ")) continue;
		if (line.length >= 3) {
			let path = line.slice(3);
			const arrow = path.indexOf(" -> "); // rename: "R  old -> new"
			if (arrow >= 0) path = path.slice(arrow + 4);
			out.push({ path: unquotePath(path), x: line[0], y: line[1] });
		}
	}
	return out;
}

/** 解析 `git for-each-ref --format=%(refname)%09%(HEAD)`：本地分支 + 远程跟踪。
 *  scm.ts:210 parseBranches 镜像（含 origin/HEAD 符号链接跳过）。 */
export function parseBranches(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		const parts = line.split("\t");
		if (parts.length < 2) continue;
		const ref = parts[0];
		const isHead = parts[1] === "*";
		if (ref.startsWith("refs/heads/")) {
			out.push({ name: ref.slice("refs/heads/".length), current: isHead });
		} else if (ref.startsWith("refs/remotes/")) {
			const short = ref.slice("refs/remotes/".length);
			// 跳过 "origin/HEAD -> origin/main" 符号链接。
			if (short.endsWith("/HEAD")) continue;
			const slash = short.indexOf("/");
			out.push({
				name: short,
				current: false,
				remote: slash > 0 ? short.slice(0, slash) : true,
			});
		}
	}
	return out;
}

/** 解析 `git diff --numstat` 文本："12\t3\tpath" → { path: [add, del] }；
 *  二进制 "-" → 0；同路径累加。scm.ts:261 parseNumStat 镜像。 */
export function parseNumStat(text) {
	const stats = {};
	for (const line of String(text).split("\n")) {
		if (!line.trim()) continue;
		const tab1 = line.indexOf("\t");
		const tab2 = tab1 < 0 ? -1 : line.indexOf("\t", tab1 + 1);
		if (tab2 < 0) continue;
		let add = Number(line.slice(0, tab1));
		let del = Number(line.slice(tab1 + 1, tab2));
		if (!Number.isFinite(add)) add = 0; // 二进制文件 → "-"
		if (!Number.isFinite(del)) del = 0;
		const path = unquotePath(line.slice(tab2 + 1).trim());
		const prev = stats[path];
		stats[path] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
	}
	return stats;
}

/**
 * 解析 `git diff --numstat -z`：与 parseNumStat 同样的输出语义
 * （{ path: [add, del] }，二进制 "-" → 0），但 rename 条目无歧义：
 * 普通条目 `add\tdel\tpath\u0000`；rename 条目 `add\tdel\t\u0000old\u0000new\u0000`
 * （path 字段为空，后跟 old/new 两个 NUL 字段，实测确认）。
 * add/del 是数字或 "-"，所以 token 内前两个制表符定位安全，路径可含制表符。
 */
export function parseNumStatZ(text) {
	const stats = {};
	const tokens = String(text).split("\u0000");
	if (tokens.length && tokens[tokens.length - 1] === "") tokens.pop(); // 尾部 NUL
	for (let i = 0; i < tokens.length; ) {
		const tok = tokens[i];
		const tab1 = tok.indexOf("\t");
		const tab2 = tab1 < 0 ? -1 : tok.indexOf("\t", tab1 + 1);
		if (tab1 < 0 || tab2 < 0) {
			i += 1;
			continue; // 畸形片段：跳过（容忍截断）
		}
		let add = Number(tok.slice(0, tab1));
		let del = Number(tok.slice(tab1 + 1, tab2));
		if (!Number.isFinite(add)) add = 0; // 二进制 → "-"
		if (!Number.isFinite(del)) del = 0;
		const pathField = tok.slice(tab2 + 1);
		if (pathField === "") {
			// rename：接下来两个 token 是 old、new
			const oldPath = tokens[i + 1];
			const newPath = tokens[i + 2];
			if (typeof newPath === "string" && newPath !== "") {
				const prev = stats[newPath];
				stats[newPath] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
			}
			i += 3;
		} else {
			const prev = stats[pathField];
			stats[pathField] = [(prev?.[0] ?? 0) + add, (prev?.[1] ?? 0) + del];
			i += 1;
		}
	}
	return stats;
}

/**
 * 解析 `git diff --name-status` 文本（TAB 分隔）：`M\tpath`、
 * `R100\told\tnew`。状态字母化（R100 → R），rename/copy 带 oldPath。
 * 路径含制表符时 git 会 C 引号化（控制字符永远转义），按制表符拆分无歧义。
 */
export function parseNameStatus(text) {
	const out = [];
	for (const line of String(text).split("\n")) {
		if (!line) continue;
		const fields = line.split("\t");
		const code = fields[0];
		if (!code) continue;
		const status = code[0];
		if ((status === "R" || status === "C") && fields.length >= 3) {
			out.push({ path: unquotePath(fields[2]), status, oldPath: unquotePath(fields[1]) });
		} else if (fields.length >= 2) {
			out.push({ path: unquotePath(fields[1]), status });
		}
	}
	return out;
}

const HUNK_HEADER_RE = /^@@ -(\d+)(?:,(\d+))? \+(\d+)(?:,(\d+))? @@/;
const BINARY_LINE_RE = /^Binary files .* differ$/m;

/**
 * 解析统一 diff 补丁 → 结构化 hunks。
 *
 * 返回 `{ hunks, binary, status, oldPath }`：
 *   hunks: [{ oldStart, oldLines, newStart, newLines, lines }]
 *   lines: [{ type: "ctx"|"add"|"del", old?, new?, text }] —— ctx 双侧行号、
 *   add 只带 new、del 只带 old；`\ No newline at end of file` 跳过、不占行号。
 *   binary: 出现 "Binary files … differ" 行。
 *   status/oldPath: 从文件头推导（"new file mode"→A、"deleted file mode"→D、
 *   "rename from"→R+oldPath、"copy from"→C+oldPath，否则 M）；空补丁 → null。
 *
 * 设计为宽容解析：截断的补丁（capPatch 之后）按已完整出现的行解析，不抛错。
 * 目标输入是单文件补丁（/diff 路由契约）；多文件补丁会累出所有 hunk，
 * status/oldPath 反映最后一个文件头。
 */
export function parseUnifiedDiff(text) {
	const lines = String(text).split("\n");
	if (lines.length && lines[lines.length - 1] === "") lines.pop(); // 尾随换行
	const hunks = [];
	const meta = { status: null, oldPath: null, sawFileHeader: false };
	let hunk = null;
	let nextOld = 0;
	let nextNew = 0;
	for (const line of lines) {
		if (line.startsWith("diff --git ")) {
			hunk = null; // 新文件开始
			meta.sawFileHeader = true;
			continue;
		}
		if (hunk === null) {
			if (line.startsWith("new file mode")) meta.status = "A";
			else if (line.startsWith("deleted file mode")) meta.status = "D";
			else if (line.startsWith("rename from ")) {
				meta.status = "R";
				meta.oldPath = unquotePath(line.slice("rename from ".length));
			} else if (line.startsWith("copy from ")) {
				meta.status = "C";
				meta.oldPath = unquotePath(line.slice("copy from ".length));
			} else if (BINARY_LINE_RE.test(line)) {
				// 二进制文件补丁没有 hunk；若之前没定性（新/删二进制各自带 mode 行）保持
				if (meta.status === null) meta.status = "M";
			} else if (HUNK_HEADER_RE.test(line)) {
				const m = line.match(HUNK_HEADER_RE);
				hunk = {
					oldStart: Number(m[1]),
					oldLines: m[2] === undefined ? 1 : Number(m[2]),
					newStart: Number(m[3]),
					newLines: m[4] === undefined ? 1 : Number(m[4]),
					lines: [],
				};
				hunks.push(hunk);
				nextOld = hunk.oldStart;
				nextNew = hunk.newStart;
			}
			// 其余文件头行（index/---/+++/similarity/mode…）忽略
			continue;
		}
		// hunk 内部
		if (line.startsWith("@@")) {
			// 上一个 hunk 声明的行数未满（截断补丁）——按新 hunk 继续
			const m = line.match(HUNK_HEADER_RE);
			if (m) {
				hunk = {
					oldStart: Number(m[1]),
					oldLines: m[2] === undefined ? 1 : Number(m[2]),
					newStart: Number(m[3]),
					newLines: m[4] === undefined ? 1 : Number(m[4]),
					lines: [],
				};
				hunks.push(hunk);
				nextOld = hunk.oldStart;
				nextNew = hunk.newStart;
			}
			continue;
		}
		if (line.startsWith("\\")) continue; // "\ No newline at end of file"
		if (line.startsWith("+")) {
			hunk.lines.push({ type: "add", new: nextNew++, text: line.slice(1) });
		} else if (line.startsWith("-")) {
			hunk.lines.push({ type: "del", old: nextOld++, text: line.slice(1) });
		} else if (line.startsWith(" ") || line === "") {
			hunk.lines.push({ type: "ctx", old: nextOld++, new: nextNew++, text: line.slice(1) });
		}
		// 其它行（补丁被截断进来的杂项）忽略
	}
	// 普通修改（只改内容）没有任何特殊文件头 —— 见到文件头就默认 M。
	const status = meta.sawFileHeader ? (meta.status ?? "M") : null;
	return { hunks, binary: BINARY_LINE_RE.test(String(text)), status, oldPath: meta.oldPath };
}

/**
 * 解析 `git ls-files -z`：NUL 分隔的仓库根相对路径数组（-z 下 git 不做 C 引号化，
 * 路径原样字节输出）。空段丢弃 —— 尾随 NUL 会切出末尾空串。
 * /tree 路由用（R6 全树视图）；不用文本形式是因为文件名可含换行。
 */
export function parseLsFilesZ(text) {
	return String(text)
		.split("\u0000")
		.filter(Boolean);
}

/**
 * 把一段补丁文本截到 maxChars，保头去尾并追加可见截断标记。
 * scm.ts:390 capPatch 镜像（数值由调用方传入）。
 */
export function capPatch(text, maxChars) {
	if (text.length <= maxChars) return text;
	return `${text.slice(0, maxChars)}\n… (diff truncated)`;
}

/* ------------------------------------------------------------------ */
/* 仓库根 / marker key（R4）                                            */
/* ------------------------------------------------------------------ */

/** 规范化仓库根路径：反斜杠 → 斜杠（连续折叠）、去掉尾随斜杠（Windows 下键也稳定）。 */
export function normalizeRootPath(rootPath) {
	let p = String(rootPath ?? "").replace(/\\+/g, "/").replace(/\/{2,}/g, "/");
	while (p.length > 1 && p.endsWith("/")) p = p.slice(0, -1);
	return p;
}

/**
 * 每仓库一个 review marker 的 host.storage 键：`marker:<规范化仓库根绝对路径>`。
 * 纯字符串推导（不用 node:crypto —— 本文件要能被浏览器 bundle import），
 * 确定性、可直接在 storage.json 里人读。
 */
export function markerKey(repoRoot) {
	return `marker:${normalizeRootPath(repoRoot)}`;
}
