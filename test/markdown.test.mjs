/**
 * markdown.test.mjs —— R23 零依赖 Markdown 渲染器的纯逻辑覆盖。
 *
 * markdownToTree 输出中间节点树（{tag, attrs?, children}，字符串子节点 = 安全
 * 文本），不碰 DOM —— 直接断言树结构。安全断言是重点：原始 HTML/实体永不变成
 * 可执行的标签节点（落地端走 textContent，树里它们只是字符串）；javascript:/
 * data: 的链接与图片必须降级为纯文本。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";
import { isMarkdownPath, markdownToTree, safeUrl } from "../client/markdown.mjs";

/** 树里找第一个匹配 tag 的节点（递归）。 */
function findNode(nodes, tag) {
	for (const n of nodes) {
		if (typeof n === "string") continue;
		if (n.tag === tag) return n;
		const hit = findNode(n.children ?? [], tag);
		if (hit) return hit;
	}
	return null;
}

/** 节点的纯文本展开（结构断言用）。 */
function textOf(node) {
	if (typeof node === "string") return node;
	return (node.children ?? []).map(textOf).join("");
}

describe("isMarkdownPath (R23)", () => {
	it("accepts the markdown family, case-insensitive, basename only", () => {
		for (const p of ["README.md", "notes.MD", "docs/x.markdown", "a/b/c.mdx", "x.mdown", "x.mkd"]) {
			assert.equal(isMarkdownPath(p), true, p);
		}
	});
	it("rejects everything else", () => {
		for (const p of ["src/app.ts", "plain.txt", "noext", "md", "a/.md", "x.mdcard", ""]) {
			// a/.md：basename 就是 ".md" 的隐藏文件不算 markdown（扩展名前须有名字）
			assert.equal(isMarkdownPath(p), false, p);
		}
	});
});

describe("safeUrl (R23)", () => {
	it("allows http/https/mailto/relative/anchor", () => {
		for (const u of ["https://x.dev/a", "http://x.dev", "mailto:a@b.c", "docs/x.md", "#anchor", "/abs/path"]) {
			assert.equal(safeUrl(u), u, u);
		}
	});
	it("blocks dangerous schemes, including whitespace/control-char smuggling", () => {
		assert.equal(safeUrl("javascript:alert(1)"), null);
		assert.equal(safeUrl("JaVaScRiPt:alert(1)"), null);
		assert.equal(safeUrl("java\tscript:alert(1)"), null, "tab inside the scheme is still javascript:");
		assert.equal(safeUrl("vbscript:x"), null);
		assert.equal(safeUrl("data:text/html,<script>alert(1)</script>"), null);
	});
});

describe("markdownToTree blocks (R23)", () => {
	it("headings #..######, trailing #s stripped", () => {
		const tree = markdownToTree("# Title\n## Sub ##\n###### Deep\n####### seven is a paragraph");
		assert.equal(tree[0].tag, "h1");
		assert.equal(textOf(tree[0]), "Title");
		assert.equal(tree[1].tag, "h2");
		assert.equal(tree[2].tag, "h6");
		assert.equal(tree[3].tag, "p", "7+ hashes is not a heading");
	});

	it("paragraph: single newlines become hard breaks (GitHub-style)", () => {
		const p = markdownToTree("line one\nline two")[0];
		assert.equal(p.tag, "p");
		assert.deepEqual(p.children, ["line one", { tag: "br" }, "line two"]);
	});

	it("fenced code: raw content, never parsed, language kept in data-lang", () => {
		const pre = markdownToTree("```ts\nconst a = \"<script>x</script>\";\n# not a heading\n```")[0];
		assert.equal(pre.tag, "pre");
		const code = pre.children[0];
		assert.equal(code.tag, "code");
		assert.equal(code.attrs["data-lang"], "ts");
		assert.equal(code.children[0], "const a = \"<script>x</script>\";\n# not a heading");
	});

	it("unclosed fence consumes to the end", () => {
		const pre = markdownToTree("```\nline1\nline2")[0];
		assert.equal(pre.tag, "pre");
		assert.equal(pre.children[0].children[0], "line1\nline2");
	});

	it("blockquote nests by recursion", () => {
		const bq = markdownToTree("> outer\n> > inner\n> back")[0];
		assert.equal(bq.tag, "blockquote");
		const inner = findNode(bq.children, "blockquote");
		assert.ok(inner, "nested blockquote present");
		assert.equal(textOf(inner), "inner");
	});

	it("hr variants", () => {
		for (const src of ["---", "***", "___", "- - -"]) {
			assert.equal(markdownToTree(src)[0].tag, "hr", src);
		}
	});

	it("unordered/ordered lists with indent nesting", () => {
		const tree = markdownToTree("- a\n- b\n  - b1\n1. first\n2. second");
		const ul = tree[0];
		assert.equal(ul.tag, "ul");
		assert.equal(ul.children.length, 2, "ordered items at the same indent split into a sibling list");
		const nested = findNode(ul.children, "ul");
		assert.ok(nested, "nested ul under item b");
		assert.equal(tree[1].tag, "ol");
		assert.equal(tree[1].children.length, 2);
	});

	it("task list items render checkbox markers", () => {
		const li = markdownToTree("- [x] done\n- [ ] todo")[0].children;
		assert.equal(li[0].children[0].attrs.class, "gr-md-task");
		assert.equal(li[0].children[0].children[0], "☑");
		assert.equal(li[1].children[0].children[0], "☐");
		assert.equal(textOf(li[0]).includes("done"), true);
	});

	it("GFM table: header, body rows, alignment styles", () => {
		const table = markdownToTree("| l | c | r |\n| :- | :-: | -: |\n| a | b | c |")[0];
		assert.equal(table.tag, "table");
		const ths = table.children[0].children[0].children;
		assert.equal(ths[0].attrs.style, "text-align:left");
		assert.equal(ths[1].attrs.style, "text-align:center");
		assert.equal(ths[2].attrs.style, "text-align:right");
		const tds = table.children[1].children[0].children;
		assert.equal(tds.length, 3);
		assert.equal(tds[1].children[0], "b");
	});

	it("a pipe inside a paragraph is NOT a table (no separator row)", () => {
		const tree = markdownToTree("a | b");
		assert.equal(tree[0].tag, "p");
	});
});

describe("markdownToTree inline (R23)", () => {
	it("inline code span: content inert (no further parsing)", () => {
		const p = markdownToTree("`**not bold**`")[0];
		const code = findNode(p.children, "code");
		assert.equal(code.children[0], "**not bold**");
	});

	it("strong / em / strike, including nesting", () => {
		const p = markdownToTree("**bold *inner* tail** and ~~gone~~")[0];
		const strong = findNode(p.children, "strong");
		assert.ok(strong);
		const em = findNode(strong.children, "em");
		assert.ok(em, "em nested inside strong");
		assert.ok(findNode(p.children, "del"));
	});

	it("underscore emphasis respects word boundaries (snake_case stays text)", () => {
		const p = markdownToTree("snake_case_name stays, but _real em_ works")[0];
		assert.ok(!findNode(p.children, "em") || textOf(findNode(p.children, "em")) === "real em");
		assert.equal(textOf(p).includes("snake_case_name stays"), true);
	});

	it("links: safe href + target/rel; label parsed inline", () => {
		const a = findNode(markdownToTree("[see **docs**](https://x.dev/a)")[0].children, "a");
		assert.equal(a.attrs.href, "https://x.dev/a");
		assert.equal(a.attrs.rel, "noopener noreferrer");
		assert.ok(findNode(a.children, "strong"));
	});

	it("javascript: links degrade to plain text (no <a>, no href)", () => {
		// URL 里不带括号（简单 URL 匹配器在首个未配对 ) 截停 —— 文档化限制）。
		const p = markdownToTree("[click](javascript:alert)")[0];
		assert.equal(findNode(p.children, "a"), null);
		assert.equal(textOf(p), "click");
	});

	it("angle autolinks become links", () => {
		const a = findNode(markdownToTree("<https://x.dev>")[0].children, "a");
		assert.equal(a.attrs.href, "https://x.dev");
	});

	it("images render <img>; unsafe src degrades to alt text only", () => {
		const img = findNode(markdownToTree("![logo](https://x.dev/a.png)")[0].children, "img");
		assert.equal(img.attrs.src, "https://x.dev/a.png");
		assert.equal(img.attrs.alt, "logo");
		const bad = markdownToTree("![x](data:image/png;base64,AAAA)")[0];
		assert.equal(findNode(bad.children, "img"), null, "data: images must not request");
	});

	it("raw HTML and entities stay literal text (the whole security story)", () => {
		const p = markdownToTree("<script>alert(1)</script> &amp; <img src=x onerror=alert(1)>")[0];
		assert.equal(findNode(p.children, "script"), null);
		assert.equal(findNode(p.children, "img"), null);
		assert.equal(textOf(p), "<script>alert(1)</script> &amp; <img src=x onerror=alert(1)>");
	});

	it("empty input → empty tree (no crash)", () => {
		assert.deepEqual(markdownToTree(""), []);
		assert.deepEqual(markdownToTree(null), []);
	});
});
