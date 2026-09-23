/**
 * git-review —— diff 内容列的极简语法高亮（client/syntax.mjs，R21）。
 *
 * 约束形态：裸 ESM、无 npm、无构建 —— 不引 highlight.js/Prism，自己写一个按
 * 扩展名分家的**单行正则分词器**：每个家族一条组合正则（命名备选 = 令牌类）
 * + 关键词表，粘性（y）扫描。分词严格分剖原文 —— 令牌文本拼接恒等原文，不丢
 * 不改任何字符；内容列本就 white-space:pre，空白语义全由 CSS 与原文本身保证。
 *
 * 正确形态（评审辅助的着色，不是编译器）：扫描顺序消耗、令牌总从**当前位置**
 * 起配 —— 字符串里的 // 或 # 永远先被字符串整体吞掉（"http://x" 不会误判成
 * 注释），注释里的引号亦然；备选有序（kw 先于 fn，关键字调用如 if( 不会误着
 * 成函数色）。跨行结构（跨行的块注释/三引号串/多行标签）不在能力内：diff 内
 * 容逐行而来、无跨行状态，行内尽力、行外自然留 plain。正则字面量与除号无法
 * 无状态区分 → 不着正则字面量（除号留 plain，永不误吞后半行）。
 *
 * 家族形态（扩展名 → 家族）：js/ts(.mjs/.cjs/.ts/.tsx…)、json(.jsonc/.json5)、
 * css(.scss/.less)、markup(.html/.xml/.svg)、md、c 家族(.c/.cpp/.java/.go/.rs/
 * .cs/.swift/.kt/.dart/.php…)、hash 家族（# 注释：.py/.rb/.sh/.yaml/.toml/
 * .ini/.pl/.r…）、sql；无扩展名（点首）/未知 → plain（只保字符串/注释/数字的
 * 通用子集）。makefile/dockerfile 按基本名特判。
 *
 * 性能形态：按 (家族, 行文本) 模块级记忆化（封顶清空）—— 展开/收拢重拉的同
 * 文本行不重复分词；令牌数据不可变（渲染只读），复用安全。DOM 渲染住
 * viewer.mjs：cls=="" → 纯文本节点，其余 → .gr-tok-<cls> span（One Dark 色
 * 板，类与色板见 viewer.mjs VIEWER_CSS）。
 *
 * 纯逻辑导出 langForPath / tokenizeLine —— node --test 无 DOM 直接驱动。
 */

/* ------------------------------------------------------------------ */
/* 可复用片段（String.raw：反斜杠原样进正则；模板内 \` 原样保留为正则转义） */
/* ------------------------------------------------------------------ */

const BT = "\`"; // 正则里的字面反引号（正则源里裸反引号即字面反引号，无需转义）
/** 双引号字符串（行内；允许到行尾未闭合 —— diff 行常因截断/拆行只剩开头） */
const STR_DQ = String.raw`"(?:\\[\s\S]|[^"\\\n])*"?`;
/** 单引号字符串（同上） */
const STR_SQ = String.raw`'(?:\\[\s\S]|[^'\\\n])*'?`;
/** 反引号模板串 */
const STR_BT = `${BT}(?:\\[\\s\\S]|[^\\\\${BT}])*${BT}?`;
/** 常规数字（十进制/浮点/指数 + c 家族的 u/l/f 后缀） */
const NUM = String.raw`\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*\b`;
/** 行注释（双斜杠行尾）与块注释（斜杠星 … 星斜杠，或到行尾 —— diff 拆行时块注释开头行着到尾） */
const COM_SLASH = String.raw`//[^\n]*`;
const COM_BLOCK = String.raw`/\*[\s\S]*?(?:\*/|$)`;
/** 函数调用名（后随 (；备选序在 kw 之后 —— 关键字调用不误着函数色） */
const FN = String.raw`\b[A-Za-z_$][\w$]*(?=\s*\()`;
/** 函数调用名（无 $ —— 非 js 家族） */
const FN_WORD = String.raw`\b[A-Za-z_]\w*(?=\s*\()`;

/* ------------------------------------------------------------------ */
/* 家族正则（命名备选名 = 令牌类；一类一条）                            */
/* ------------------------------------------------------------------ */

/** js/ts 家族关键词（ modest 并集：控制流 + 声明 + 字面量 + TS 修饰） */
const JS_KW = [
	"abstract", "any", "as", "async", "await", "boolean", "break", "case", "catch", "class", "const",
	"constructor", "continue", "debugger", "declare", "default", "delete", "do", "else", "enum",
	"export", "extends", "false", "finally", "for", "from", "function", "get", "if", "implements",
	"import", "in", "infer", "instanceof", "interface", "is", "keyof", "let", "namespace", "never",
	"new", "null", "number", "of", "override", "private", "protected", "public", "readonly", "return",
	"satisfies", "set", "static", "string", "super", "switch", "symbol", "this", "throw", "true",
	"try", "type", "typeof", "undefined", "unique", "unknown", "var", "void", "while", "with", "yield",
].join("|");

const JS_SRC = String.raw`(?<com>${COM_SLASH}|${COM_BLOCK})|(?<str>${STR_BT}|${STR_DQ}|${STR_SQ})|(?<num>\b(?:0[xX][0-9a-fA-F]+|0[bB][01]+|0[oO][0-7]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)\b)|(?<kw>\b(?:${JS_KW})\b)|(?<fn>${FN})`;

/** json（.jsonc 注释备选；闭合字符串后随 : → key 色，否则字符串色） */
const KEY_DQ = String.raw`"(?:\\[\s\S]|[^"\\\n])*"(?=\s*:)`;
const JSON_SRC = String.raw`(?<com>${COM_SLASH}|${COM_BLOCK})|(?<key>${KEY_DQ})|(?<str>${STR_DQ}|${STR_SQ})|(?<num>\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?\b)|(?<kw>\b(?:true|false|null|True|False|None)\b)`;

/** css（无状态妥协：选择器留 plain；着注释/字符串/@规则/!important/数字与十六进制/函数名） */
const CSS_SRC = String.raw`(?<com>${COM_BLOCK})|(?<str>"[^"\n]*"?|'[^'\n]*'?)|(?<at>@[a-zA-Z-]+)|(?<kw>![a-zA-Z-]+)|(?<num>\b\d+(?:\.\d+)?(?:px|em|rem|ex|ch|vh|vw|vmin|vmax|%|s|ms|deg|fr|pt|cm|mm|in)?\b|#[0-9a-fA-F]{3,8}\b)|(?<fn>[-\w]+(?=\s*\())`;

/** markup（html/xml/svg：注释、标签名（行内尽力）、属性名（后随 =）、引号串） */
const MARKUP_SRC = String.raw`(?<com><!--[\s\S]*?(?:-->|$))|(?<tag>(?<=</?)[a-zA-Z][\w:.-]*)|(?<attr>[a-zA-Z_][\w:.-]*(?=\s*=))|(?<str>"[^"\n]*"?|'[^'\n]*'?)`;

/** md（行首标题与强调 → kw 色；围栏行 → 注释色；行内代码 → 字符串色） */
const MD_SRC = String.raw`(?<kw>^#{1,6}[^\n]*|\*\*[^*\n]+\*\*|__[^_\n]+__)|(?<com>${BT}${BT}${BT}[^\n]*)|(?<str>${BT}[^${BT}\n]*${BT}?)`;

/** c 家族（c/cpp/java/go/rs/cs/swift/kt/dart/php… 的 modest 并集）+ 预处理 #dir */
const C_KW = [
	"abstract", "as", "async", "await", "bool", "boolean", "break", "byte", "case", "catch", "chan",
	"char", "class", "const", "continue", "crate", "cs", "default", "defer", "do", "double", "dyn",
	"else", "enum", "explicit", "extern", "false", "final", "finally", "float", "for", "fn", "func",
	"function", "goto", "go", "if", "impl", "implements", "import", "in", "inline", "instanceof",
	"int", "interface", "internal", "is", "let", "long", "map", "move", "mutable", "mut", "namespace",
	"new", "nil", "nullptr", "null", "operator", "out", "override", "package", "params", "private",
	"protected", "pub", "public", "range", "readonly", "ref", "return", "sealed", "select", "self",
	"Self", "short", "signed", "size_t", "static", "struct", "super", "switch", "this", "throw",
	"throws", "trait", "true", "try", "typealias", "typeof", "union", "unsafe", "unsigned", "use",
	"using", "usize", "isize", "u8", "u16", "u32", "u64", "i8", "i16", "i32", "i64", "f32", "f64",
	"var", "virtual", "void", "volatile", "where", "while", "yield", "echo", "string", "auto",
].join("|").split("|").filter((word, index, list) => list.indexOf(word) === index).join("|");

const C_SRC = String.raw`(?<com>${COM_SLASH}|${COM_BLOCK})|(?<str>${STR_DQ}|${STR_SQ})|(?<at>#\s*[A-Za-z_]\w*)|(?<num>\b(?:0[xX][0-9a-fA-F]+|\d+(?:\.\d+)?(?:[eE][+-]?\d+)?[uUlLfF]*)\b)|(?<kw>\b(?:${C_KW})\b)|(?<fn>${FN})`;

/** hash 家族（# 注释：py/rb/sh/yaml/toml/ini/pl/r…；大小写不敏感 + rb 符号 + py 装饰器/三引号） */
const HASH_KW = [
	"alias", "and", "as", "assert", "async", "await", "begin", "break", "case", "class", "continue",
	"declare", "def", "do", "done", "echo", "elif", "else", "elsif", "end", "ensure", "eval", "exec",
	"exit", "export", "false", "fi", "finally", "for", "function", "global", "goto", "if", "import",
	"in", "is", "lambda", "local", "match", "module", "next", "nil", "nonlocal", "none", "not", "null",
	"off", "on", "or", "pass", "printf", "raise", "read", "readonly", "redo", "return", "select",
	"self", "set", "shift", "source", "super", "test", "then", "time", "trap", "true", "try", "undef",
	"unless", "until", "unset", "when", "while", "with", "yield", "yes", "no", "global", "none",
].join("|");

const HASH_SRC = String.raw`(?<com>#[^\n]*)|(?<str>"""[\s\S]*?(?:"""|$)|'''[\s\S]*?(?:'''|$)|${STR_DQ}|${STR_SQ})|(?<key>:[A-Za-z_]\w*)|(?<at>@\s*[A-Za-z_]\w*)|(?<num>\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<kw>\b(?:${HASH_KW})\b)|(?<fn>${FN_WORD})`;

/** sql（大小写不敏感；'…''…' 转义；-- 与块注释） */
const SQL_KW = [
	"add", "all", "alter", "and", "as", "begin", "between", "by", "case", "check", "commit", "constraint",
	"create", "cursor", "declare", "default", "delete", "distinct", "drop", "else", "end", "exec",
	"exists", "foreign", "for", "from", "function", "grant", "group", "having", "having", "if", "in",
	"index", "inner", "insert", "into", "is", "join", "key", "left", "like", "limit", "not", "null",
	"offset", "on", "or", "order", "outer", "procedure", "references", "right", "rollback", "schema",
	"select", "set", "table", "then", "trigger", "truncate", "union", "unique", "update", "values",
	"view", "when", "where", "while", "with",
].join("|");

const SQL_SRC = String.raw`(?<com>--[^\n]*|${COM_BLOCK})|(?<str>'(?:''|[^'])*'?)|(?<num>\b\d+(?:\.\d+)?(?:[eE][+-]?\d+)?)|(?<kw>\b(?:${SQL_KW})\b)|(?<fn>${FN_WORD})`;

/** plain（未知/无扩展名：只保注释/字符串/数字的通用子集；// # /* 三种注释） */
const PLAIN_SRC = String.raw`(?<com>${COM_SLASH}|#[^\n]*|${COM_BLOCK})|(?<str>${STR_DQ}|${STR_SQ})|(?<num>${NUM})`;

/* ------------------------------------------------------------------ */
/* 扩展名/基本名 → 家族映射                                             */
/* ------------------------------------------------------------------ */

const EXT_LANG = new Map(Object.entries({
	// js/ts
	js: "js", mjs: "js", cjs: "js", jsx: "js", ts: "js", mts: "js", cts: "js", tsx: "js", mtsx: "js",
	// json
	json: "json", jsonc: "json", json5: "json",
	// css
	css: "css", scss: "css", sass: "css", less: "css",
	// markup
	html: "markup", xhtml: "markup", xml: "markup", svg: "markup", vue: "markup",
	// md
	md: "md", markdown: "md",
	// c 家族
	c: "c", h: "c", cpp: "c", hpp: "c", cc: "c", hh: "c", cxx: "c", hxx: "c", java: "c", cs: "c",
	go: "c", rs: "c", swift: "c", kt: "c", kts: "c", dart: "c", php: "c", scala: "c", groovy: "c",
	vala: "c", zig: "c",
	// hash 家族
	py: "hash", pyi: "hash", pyw: "hash", rb: "hash", rake: "hash", gemspec: "hash", sh: "hash",
	bash: "hash", zsh: "hash", ksh: "hash", yaml: "hash", yml: "hash", toml: "hash", ini: "hash",
	cfg: "hash", conf: "hash", pl: "hash", pm: "hash", r: "hash",
	// sql
	sql: "sql",
}));

/** 无扩展名的基本名特判（.gitignore 等点首仍留 plain） */
const BASE_LANG = new Map(Object.entries({
	makefile: "hash",
	dockerfile: "hash",
}));

/** 扩展名/基本名 → 家族。未知与点首 → plain。 */
export function langForPath(path) {
	if (typeof path !== "string" || path === "") return "plain";
	const base = path.split("/").pop() ?? path;
	const direct = BASE_LANG.get(base.toLowerCase());
	if (direct) return direct;
	const dot = base.lastIndexOf(".");
	if (dot <= 0) return "plain";
	return EXT_LANG.get(base.slice(dot + 1).toLowerCase()) ?? "plain";
}

/* ------------------------------------------------------------------ */
/* 扫描（粘性 + 命名备选 = 类；分剖恒等原文）                            */
/* ------------------------------------------------------------------ */

/** 备选名序（= 类名；与正则里的命名组一一对应） */
const CLASSES = ["com", "str", "num", "kw", "fn", "tag", "attr", "key", "at"];

const FAMILY_RE = new Map();

/** 惰性编译家族正则（粘性；hash/sql 大小写不敏感） */
function reFor(lang) {
	const hit = FAMILY_RE.get(lang);
	if (hit !== undefined) return hit;
	let re = null;
	const src = {
		js: JS_SRC, json: JSON_SRC, css: CSS_SRC, markup: MARKUP_SRC, md: MD_SRC,
		c: C_SRC, hash: HASH_SRC, sql: SQL_SRC, plain: PLAIN_SRC,
	}[lang];
	if (src) re = new RegExp(src, lang === "hash" || lang === "sql" ? "yi" : "y");
	FAMILY_RE.set(lang, re);
	return re;
}

function scan(text, re) {
	const tokens = [];
	let last = 0;
	let pos = 0;
	while (pos < text.length) {
		re.lastIndex = pos; // 失败的 exec 会把 lastIndex 清零（含粘性），位置自己管
		const m = re.exec(text);
		if (m === null || m[0].length === 0) {
			// 粘性失败：令牌必须从当前位置起配，都失败 → 前进 1 字符再试（顺序消耗，
			// 字符串/注释整体吞掉中间的双斜杠/井号）。
			pos += 1;
			continue;
		}
		if (m.index > last) tokens.push({ cls: "", text: text.slice(last, m.index) });
		let cls = "";
		for (const name of CLASSES) {
			if (m.groups[name] !== undefined) {
				cls = name;
				break;
			}
		}
		tokens.push({ cls, text: m[0] });
		pos = re.lastIndex;
		last = pos;
	}
	if (last < text.length) tokens.push({ cls: "", text: text.slice(last) });
	return tokens;
}

/* ------------------------------------------------------------------ */
/* 记忆化入口                                                           */
/* ------------------------------------------------------------------ */

const MEMO_CAP = 4096;
const memo = new Map();

/**
 * 单行分词：[{cls, text}]，cls=="" 表纯文本；拼接恒等原文。按 (家族, 行文本)
 * 记忆化（同一数组复用，数据不可变）。
 */
export function tokenizeLine(text, lang) {
	const source = typeof text === "string" ? text : String(text ?? "");
	const key = `${lang}\u0000${source}`;
	const hit = memo.get(key);
	if (hit) return hit;
	const re = reFor(lang);
	const tokens = re ? scan(source, re) : [{ cls: "", text: source }];
	if (memo.size >= MEMO_CAP) memo.clear();
	memo.set(key, tokens);
	return tokens;
}
