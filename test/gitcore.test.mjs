/**
 * gitcore.mjs 单元测试 —— 解析器 + 校验器，全部跑在固定 fixture 文本上，
 * 不碰真实 git（真实 git 的端到端在 server-smoke.test.mjs）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import {
	DEFAULT_BASE_CANDIDATES,
	capPatch,
	markerKey,
	normalizeRootPath,
	parseBranches,
	parseNameStatus,
	parseNumStat,
	parseNumStatZ,
	parseStatusFiles,
	parseUnifiedDiff,
	unquotePath,
	validateLimit,
	validatePath,
	validateRef,
} from "../client/gitcore.mjs";

/* ------------------------------------------------------------------ */
/* R14 校验器                                                          */
/* ------------------------------------------------------------------ */

describe("validateRef", () => {
	it("accepts ordinary refs", () => {
		for (const ref of ["main", "origin/main", "HEAD", "HEAD~1", "feat/x", "1234abcd", "refs/heads/main"]) {
			assert.equal(validateRef(ref), ref);
		}
	});
	it("rejects empty / non-string", () => {
		assert.throws(() => validateRef(""));
		assert.throws(() => validateRef(undefined));
		assert.throws(() => validateRef(42));
	});
	it("rejects leading dash and bare '--' (option injection)", () => {
		assert.throws(() => validateRef("-x"));
		assert.throws(() => validateRef("--exec=evil"));
		assert.throws(() => validateRef("--"));
	});
	it("rejects control characters, newlines and whitespace", () => {
		assert.throws(() => validateRef("a\nb"));
		assert.throws(() => validateRef("a\rb"));
		assert.throws(() => validateRef("a\tb"));
		assert.throws(() => validateRef("a b"));
		assert.throws(() => validateRef("\u0001"));
		assert.throws(() => validateRef("a\u007Fb"));
	});
	it("rejects overlong values", () => {
		assert.throws(() => validateRef("a".repeat(513)));
		assert.equal(validateRef("a".repeat(512)), "a".repeat(512));
	});
});

describe("validatePath", () => {
	it("accepts ordinary repo-relative paths (spaces inside are legal filenames)", () => {
		assert.equal(validatePath("src/app.ts"), "src/app.ts");
		assert.equal(validatePath("dir with space/f.txt"), "dir with space/f.txt");
	});
	it("rejects tabs in paths (R14: control characters)", () => {
		assert.throws(() => validatePath("we\tird.txt"));
	});
	it("rejects empty / leading dash / '--'", () => {
		assert.throws(() => validatePath(""));
		assert.throws(() => validatePath("-x"));
		assert.throws(() => validatePath("--"));
	});
	it("rejects traversal, absolute paths and pathspec magic", () => {
		assert.throws(() => validatePath("../outside"));
		assert.throws(() => validatePath("a/../b"));
		assert.throws(() => validatePath("/etc/passwd"));
		assert.throws(() => validatePath(":(exclude)x"));
	});
	it("rejects control characters", () => {
		assert.throws(() => validatePath("a\nb"));
		assert.throws(() => validatePath("\u0001"));
	});
});

describe("validateLimit", () => {
	it("falls back to default when absent/blank", () => {
		assert.equal(validateLimit(undefined), 30);
		assert.equal(validateLimit(null), 30);
		assert.equal(validateLimit(""), 30);
		assert.equal(validateLimit("  "), 30);
	});
	it("accepts integers in range (string or number)", () => {
		assert.equal(validateLimit("5"), 5);
		assert.equal(validateLimit(7), 7);
		assert.equal(validateLimit("200"), 200);
	});
	it("rejects garbage and out-of-range values", () => {
		assert.throws(() => validateLimit("abc"));
		assert.throws(() => validateLimit("1.5"));
		assert.throws(() => validateLimit("0"));
		assert.throws(() => validateLimit("-1"));
		assert.throws(() => validateLimit("201"));
	});
});

/* ------------------------------------------------------------------ */
/* 宿主镜像解析器                                                      */
/* ------------------------------------------------------------------ */

describe("unquotePath", () => {
	it("passes plain paths through", () => {
		assert.equal(unquotePath("src/app.ts"), "src/app.ts");
	});
	it("undoes C-style quoting incl. escapes", () => {
		assert.equal(unquotePath('"a\\tb"'), "a\tb");
		assert.equal(unquotePath('"a\\\\b"'), "a\\b");
		assert.equal(unquotePath('"say \\"hi\\""'), 'say "hi"');
	});
});

describe("parseStatusFiles (scm.ts:195 mirror)", () => {
	const fixture = [
		"## main...origin/main [ahead 1]",
		" M modified.txt",
		"MM both.txt",
		"?? untracked.txt",
		'R  "old\\tnamed.txt" -> "new\\tnamed.txt"',
		"M  plain staged.txt",
		"",
	].join("\n");

	it("parses statuses, skips the branch header, splits renames to the new path", () => {
		assert.deepEqual(parseStatusFiles(fixture), [
			{ path: "modified.txt", x: " ", y: "M" },
			{ path: "both.txt", x: "M", y: "M" },
			{ path: "untracked.txt", x: "?", y: "?" },
			{ path: "new\tnamed.txt", x: "R", y: " " },
			{ path: "plain staged.txt", x: "M", y: " " },
		]);
	});
});

describe("parseBranches (scm.ts:210 mirror)", () => {
	const fixture = [
		"refs/heads/feature\t ",
		"refs/heads/main\t*",
		"refs/remotes/origin/HEAD\t ",
		"refs/remotes/origin/main\t ",
		"refs/remotes/upstream\t ",
		"",
	].join("\n");

	it("lists local + remote-tracking branches, skipping the origin/HEAD symlink", () => {
		assert.deepEqual(parseBranches(fixture), [
			{ name: "feature", current: false },
			{ name: "main", current: true },
			{ name: "origin/main", current: false, remote: "origin" },
			{ name: "upstream", current: false, remote: true },
		]);
	});
});

describe("parseNumStat (scm.ts:261 mirror)", () => {
	it("maps add/del, binary '-' → 0, accumulates duplicate paths, unquotes", () => {
		const fixture = [
			"12\t3\tsrc/app.ts",
			"-\t-\tbin.dat",
			"1\t2\t" + '"tab\\tname.txt"',
			"4\t0\tsrc/app.ts",
			"",
		].join("\n");
		assert.deepEqual(parseNumStat(fixture), {
			"src/app.ts": [16, 3],
			"bin.dat": [0, 0],
			"tab\tname.txt": [1, 2],
		});
	});
});

describe("parseNumStatZ (-z, unambiguous renames)", () => {
	// 与真实 git 输出逐字节对齐（见 server-smoke 的实测）：普通条目
	// `add\tdel\tpath\u0000`；rename 条目 `add\tdel\t\u0000old\u0000new\u0000`；二进制 `-`。
	const fixture = "1\t1\ta.txt\u0000-\t-\tbin.dat\u00000\t0\t\u0000old.txt\u0000new.txt\u00002\t3\twe\tird.txt\u0000";

	it("parses plain, binary, rename and tab-in-filename entries", () => {
		assert.deepEqual(parseNumStatZ(fixture), {
			"a.txt": [1, 1],
			"bin.dat": [0, 0],
			"new.txt": [0, 0],
			"we\tird.txt": [2, 3],
		});
	});
	it("accumulates duplicate paths", () => {
		assert.deepEqual(parseNumStatZ("1\t2\tx\u0000\u00003\t4\tx\u0000"), { x: [4, 6] });
	});
});

describe("parseNameStatus", () => {
	it("letterizes statuses and carries oldPath for renames/copies", () => {
		const fixture = [
			"M\tkept.txt",
			"A\tadded.txt",
			"D\tdeleted.txt",
			"T\ttyped.txt",
			"R100\told.txt\tnew.txt",
			"C75\tcsrc\tcdst",
			"",
		].join("\n");
		assert.deepEqual(parseNameStatus(fixture), [
			{ path: "kept.txt", status: "M" },
			{ path: "added.txt", status: "A" },
			{ path: "deleted.txt", status: "D" },
			{ path: "typed.txt", status: "T" },
			{ path: "new.txt", status: "R", oldPath: "old.txt" },
			{ path: "cdst", status: "C", oldPath: "csrc" },
		]);
	});
});

/* ------------------------------------------------------------------ */
/* 统一 diff 解析器                                                     */
/* ------------------------------------------------------------------ */

const MULTI_HUNK_PATCH = [
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

describe("parseUnifiedDiff — hunks & line numbers", () => {
	const { hunks } = parseUnifiedDiff(MULTI_HUNK_PATCH);

	it("produces two hunks with header counts", () => {
		assert.equal(hunks.length, 2);
		assert.deepEqual(hunks[0], {
			oldStart: 1,
			oldLines: 3,
			newStart: 1,
			newLines: 4,
			lines: [
				{ type: "ctx", old: 1, new: 1, text: "const a = 1;" },
				{ type: "del", old: 2, text: "const b = 2;" },
				{ type: "add", new: 2, text: "const b = 20;" },
				{ type: "add", new: 3, text: "" },
				{ type: "ctx", old: 3, new: 4, text: "const c = 3;" },
			],
		});
	});

	it("continues numbering across the unchanged gap; hunk header suffix is ignored", () => {
		assert.deepEqual(hunks[1], {
			oldStart: 10,
			oldLines: 3,
			newStart: 11,
			newLines: 4,
			lines: [
				{ type: "ctx", old: 10, new: 11, text: "  keep1" },
				{ type: "del", old: 11, text: "  gone" },
				{ type: "ctx", old: 12, new: 12, text: "  keep2" },
				{ type: "add", new: 13, text: "  added" },
			],
		});
	});

	it("reports no binary marker for text patches", () => {
		assert.equal(parseUnifiedDiff(MULTI_HUNK_PATCH).binary, false);
		assert.equal(parseUnifiedDiff(MULTI_HUNK_PATCH).status, "M");
		assert.equal(parseUnifiedDiff(MULTI_HUNK_PATCH).oldPath, null);
	});
});

describe("parseUnifiedDiff — special file kinds", () => {
	it("new file: /dev/null side, status A, adds only carry new numbers", () => {
		const patch = [
			"diff --git a/new.txt b/new.txt",
			"new file mode 100644",
			"index 0000000..3333333",
			"--- /dev/null",
			"+++ b/new.txt",
			"@@ -0,0 +1,2 @@",
			"+first",
			"+second",
		].join("\n");
		const r = parseUnifiedDiff(patch);
		assert.equal(r.status, "A");
		assert.deepEqual(r.hunks[0], {
			oldStart: 0,
			oldLines: 0,
			newStart: 1,
			newLines: 2,
			lines: [
				{ type: "add", new: 1, text: "first" },
				{ type: "add", new: 2, text: "second" },
			],
		});
	});

	it("deleted file: status D, deletions only carry old numbers", () => {
		const patch = [
			"diff --git a/gone.txt b/gone.txt",
			"deleted file mode 100644",
			"index 4444444..0000000",
			"--- a/gone.txt",
			"+++ /dev/null",
			"@@ -1,2 +0,0 @@",
			"-first",
			"-second",
		].join("\n");
		const r = parseUnifiedDiff(patch);
		assert.equal(r.status, "D");
		assert.deepEqual(r.hunks[0].lines, [
			{ type: "del", old: 1, text: "first" },
			{ type: "del", old: 2, text: "second" },
		]);
	});

	it("rename: status R with oldPath from 'rename from'", () => {
		const patch = [
			"diff --git a/old.txt b/new.txt",
			"similarity index 90%",
			"rename from old.txt",
			"rename to new.txt",
			"index 5555555..5555555 100644",
			"--- a/old.txt",
			"+++ b/new.txt",
			"@@ -1 +1 @@",
			"-old content",
			"+new content",
		].join("\n");
		const r = parseUnifiedDiff(patch);
		assert.equal(r.status, "R");
		assert.equal(r.oldPath, "old.txt");
		// 无计数的 hunk 头（count 省略 = 1）
		assert.deepEqual(r.hunks[0].lines, [
			{ type: "del", old: 1, text: "old content" },
			{ type: "add", new: 1, text: "new content" },
		]);
	});

	it("quoted rename path is unquoted", () => {
		const patch = [
			'diff --git "a/we\\tird" "b/we\\tird2"',
			"similarity index 95%",
			'rename from "we\\tird"',
			'rename to "we\\tird2"',
		].join("\n");
		assert.equal(parseUnifiedDiff(patch).oldPath, "we\tird");
	});

	it("binary marker sets binary with zero hunks", () => {
		const patch = [
			"diff --git a/bin.dat b/bin.dat",
			"index 6666666..7777777 100644",
			"Binary files a/bin.dat and b/bin.dat differ",
		].join("\n");
		const r = parseUnifiedDiff(patch);
		assert.equal(r.binary, true);
		assert.deepEqual(r.hunks, []);
		assert.equal(r.status, "M");
	});

	it("\\ No newline at end of file does not consume a line number", () => {
		const patch = [
			"diff --git a/nl.txt b/nl.txt",
			"index 8888888..9999999 100644",
			"--- a/nl.txt",
			"+++ b/nl.txt",
			"@@ -1,2 +1,2 @@",
			"-a",
			"+b",
			"\\ No newline at end of file",
			" c",
		].join("\n");
		const { hunks } = parseUnifiedDiff(patch);
		assert.deepEqual(hunks[0].lines, [
			{ type: "del", old: 1, text: "a" },
			{ type: "add", new: 1, text: "b" },
			{ type: "ctx", old: 2, new: 2, text: "c" },
		]);
	});

	it("empty patch → zero hunks, unknown status", () => {
		assert.deepEqual(parseUnifiedDiff(""), { hunks: [], binary: false, status: null, oldPath: null });
	});

	it("truncated patch (header declares more lines than present) parses what is there", () => {
		const truncated = MULTI_HUNK_PATCH.slice(0, MULTI_HUNK_PATCH.indexOf("-const b = 2;"));
		const { hunks } = parseUnifiedDiff(truncated);
		assert.equal(hunks.length, 1);
		assert.equal(hunks[0].lines.length, 1); // 只有完整到达的 ctx 行
	});
});

/* ------------------------------------------------------------------ */
/* 截断 / marker key / 候选顺序                                         */
/* ------------------------------------------------------------------ */

describe("capPatch (scm.ts:390 mirror)", () => {
	it("returns the text untouched under the cap", () => {
		assert.equal(capPatch("short", 100), "short");
	});
	it("slices at the cap and appends the visible marker", () => {
		const out = capPatch("x".repeat(11), 10);
		assert.equal(out, `${"x".repeat(10)}\n… (diff truncated)`);
	});
});

describe("markerKey / normalizeRootPath", () => {
	it("normalizes separators and trailing slashes", () => {
		assert.equal(normalizeRootPath("/home/u/repo/"), "/home/u/repo");
		assert.equal(normalizeRootPath("C:\\\\repo\\\\sub\\\\"), "C:/repo/sub");
		assert.equal(normalizeRootPath("/"), "/");
	});
	it("derives one stable key per repo root, distinct across roots", () => {
		assert.equal(markerKey("/home/u/repo"), "marker:/home/u/repo");
		assert.equal(markerKey("/home/u/repo/"), markerKey("/home/u/repo"));
		assert.notEqual(markerKey("/home/u/repo-a"), markerKey("/home/u/repo-b"));
	});
});

describe("DEFAULT_BASE_CANDIDATES (R4 order)", () => {
	it("prefers origin/HEAD then origin/main, origin/master, main, master", () => {
		assert.deepEqual(DEFAULT_BASE_CANDIDATES, ["origin/HEAD", "origin/main", "origin/master", "main", "master"]);
	});
});
