/**
 * client/markdown.mjs —— R23 零依赖 Markdown 渲染器（无 npm、无构建、无 DOM）。
 *
 * 动机：R18/R22 的全文预览把 .md 文件按普通文本（R21 还给上了代码高亮）展示，
 * 对 README/笔记类文件是倒退 —— 用户想要「渲染后的视图」。本模块给 viewer 的
 * 头部开关提供内容端：纯函数解析 Markdown → 中间节点树，viewer.mjs 用自己的
 * makeEl 工厂转 DOM（makeEl 是各视图模块的局部工厂，这里保持无 DOM，node --test
 * 可以直接断言树结构，与 parseUnifiedDiff 同一条「纯逻辑导出」路线）。
 *
 * 安全模型（评审工具，内容来自任意仓库的任意文件，按不可信输入对待）：
 *   - 不存在「原样 HTML 通道」—— 没有 innerHTML，输出是节点树，viewer 用
 *     textContent 落地，`<script>`、`<img onerror>`、实体引用一律变字面文本；
 *   - 链接/图片的 URL 过 safeUrl：scheme 黑名单（javascript:/vbscript:/data:，
 *     判定前剔除空白与控制字符防写绕过），其余（http/https/mailto/相对路径/#锚）
 *     放行；不安全的 URL 降级为纯文本（不渲染成可点的 <a>/<img>）。
 *   - 文本里出现的原始 HTML/实体永远按字面渲染 —— 评审视角下「文件里写了什么」
 *     比「复刻 GitHub 的宽松度」重要。
 *
 * 覆盖面（GFM 常用子集，README 与笔记够用）：
 *   块级：ATX 标题（#..######）、段落（单个换行 = <br>，GitHub 同款硬换行）、
 *         围栏代码块（``` / ~~~ + 语言标签存 data-lang）、引用（可嵌套，递归解析）、
 *         无序/有序列表（缩进嵌套 + GFM 任务清单 [ ]/[x]）、GFM 表格（对齐）、
 *         水平线（三个以上的 - / 星号 / 下划线，允许内部空格）。
 *   行内：`code`、**粗体**、__粗体__、*斜体*、_斜体_（下划线形态带词边界防
 *         snake_case 误伤）、~~删除线~~、[链接](url)、![图片](src)、<autolink>。
 * 明确不做（评审场景收益低 / 复杂度不成比例，缺了都安全降级为文本）：
 *   setext 标题（=== / --- 下划线式 —— --- 归水平线）、缩进代码块（4 空格那段
 *   会按段落文本渲染）、脚注、定义列表、数学公式、mermaid、裸 URL 自动成链
 *   （<https://…> 角括号式支持）、表格单元格内的 \| 转义、反斜杠转义。
 */

/** 路径 → 是否 Markdown 系扩展名（basename 判断，大小写不敏感；扩展名前至少要
 *  有一个非斜杠字符 —— 纯隐藏文件 ".md" 不算）。 */
export function isMarkdownPath(path) {
	const base = String(path ?? "").split("/").pop() ?? "";
	return /[^/]\.(?:md|markdown|mdx|mdown|mkd)$/i.test(base);
}

/**
 * 文本 → 节点树（无 DOM）。节点 = { tag, attrs?, children }，children 项是
 * 字符串（安全文本，落地走 textContent）或子节点。顶层返回块级节点数组。
 */
export function markdownToTree(md) {
	const lines = String(md ?? "").replace(/\r\n?/g, "\n").split("\n");
	return parseBlocks(lines);
}

/* ------------------------------------------------------------------ */
/* 块级解析                                                              */
/* ------------------------------------------------------------------ */

const FENCE_RE = /^ {0,3}(`{3,}|~{3,})\s*(\S*)\s*$/;
const HR_RE = /^ {0,3}(?:(?:-\s*){3,}|(?:\*\s*){3,}|(?:_\s*){3,})$/;
const HEADING_RE = /^ {0,3}(#{1,6})\s+(.*?)\s*#*\s*$/;
const QUOTE_RE = /^ {0,3}>/;
const LIST_RE = /^(\s*)([-*+]|\d{1,9}[.)])(?:\s+(.*))?$/;
/** GFM 表格分隔行：| --- | :--: | …（每格 = 冒号? + 至少一个连线 + 冒号?；
 *  GFM 只要一个连字符就算分隔格，--- 是习惯写法不是下限）。 */
const TABLE_SEP_RE = /^\s*\|?(?:\s*:?-+:?\s*\|)*\s*:?-+:?\s*\|?\s*$/;
const TAB_WIDTH = 4;

/** 该行是否是「段落必须在此打断」的块级起点（GFM 打断规则的不完整子集）。 */
function interruptsParagraph(line) {
	return (
		/^\s*$/.test(line) ||
		FENCE_RE.test(line) ||
		HR_RE.test(line) ||
		HEADING_RE.test(line) ||
		QUOTE_RE.test(line) ||
		LIST_RE.test(line)
	);
}

function parseBlocks(lines) {
	const out = [];
	let i = 0;
	while (i < lines.length) {
		const line = lines[i];
		if (/^\s*$/.test(line)) {
			i++;
			continue;
		}
		// 围栏代码块：开栅栏（反引号/波浪线 + 可选语言标签）到同级闭栅栏；未闭合
		// 就吃到结尾（与 CommonMark 一致，比「当作段落」安全 —— 代码内容不解析）。
		const fence = FENCE_RE.exec(line);
		if (fence) {
			const marker = fence[1];
			const body = [];
			i++;
			while (i < lines.length && !new RegExp(`^ {0,3}${marker[0]}{${marker.length},}\\s*$`).test(lines[i])) {
				body.push(lines[i]);
				i++;
			}
			if (i < lines.length) i++; // 吃掉闭栅栏
			out.push({
				tag: "pre",
				children: [{ tag: "code", attrs: { ...(fence[2] ? { "data-lang": fence[2] } : {}) }, children: [body.join("\n")] }],
			});
			continue;
		}
		if (HR_RE.test(line)) {
			out.push({ tag: "hr" });
			i++;
			continue;
		}
		const heading = HEADING_RE.exec(line);
		if (heading) {
			out.push({ tag: `h${heading[1].length}`, children: parseInline(heading[2]) });
			i++;
			continue;
		}
		// 引用：连续 > 行剥掉一层「> 」后递归（嵌套引用 = 递归自然处理）。
		if (QUOTE_RE.test(line)) {
			const stripped = [];
			while (i < lines.length && QUOTE_RE.test(lines[i])) {
				stripped.push(lines[i].replace(/^ {0,3}>\s?/, ""));
				i++;
			}
			out.push({ tag: "blockquote", children: parseBlocks(stripped) });
			continue;
		}
		// 表格：当前行含 | 且下一行是分隔行（表头必须有分隔行才成立 —— 段落里
		// 出现竖线不误判成表格）。
		if (line.includes("|") && i + 1 < lines.length && TABLE_SEP_RE.test(lines[i + 1])) {
			const aligns = splitRow(lines[i + 1]).map((cell) =>
				/^:-+:$/.test(cell) ? "center" : /^:-+/.test(cell) ? "left" : /-+:$/.test(cell) ? "right" : null,
			);
			const headCells = splitRow(line);
			const headRow = {
				tag: "tr",
				children: headCells.map((cell, c) => ({ tag: "th", attrs: thStyle(aligns[c]), children: parseInline(cell) })),
			};
			i += 2;
			const bodyRows = [];
			while (i < lines.length && lines[i].includes("|") && !interruptsParagraph(lines[i])) {
				const cells = splitRow(lines[i]);
				bodyRows.push({
					tag: "tr",
					children: headCells.map((_, c) => ({ tag: "td", attrs: thStyle(aligns[c]), children: parseInline(cells[c] ?? "") })),
				});
				i++;
			}
			out.push({
				tag: "table",
				children: [{ tag: "thead", children: [headRow] }, { tag: "tbody", children: bodyRows }],
			});
			continue;
		}
		// 列表：连续的列表项行 + 缩进延续行。嵌套按缩进深度（tab 记 4 列）。
		const listItem = LIST_RE.exec(line);
		if (listItem) {
			const collected = [];
			const baseIndent = indentWidth(listItem[1]);
			while (i < lines.length) {
				const cur = lines[i];
				if (/^\s*$/.test(cur)) {
					// 项间空行：下一行还是列表项 → 吃掉空行继续（松散列表）；否则列表结束。
					let k = i + 1;
					while (k < lines.length && /^\s*$/.test(lines[k])) k++;
					if (k < lines.length && LIST_RE.test(lines[k])) {
						i = k;
						continue;
					}
					break;
				}
				const m = LIST_RE.exec(cur);
				if (m) {
					collected.push({ indent: indentWidth(m[1]), ordered: /\d/.test(m[2]), text: m[3] ?? "" });
					i++;
					continue;
				}
				const curIndent = indentWidth(cur);
				if (curIndent >= baseIndent + 2 && collected.length) {
					// 缩进延续行归给最近一项（懒段落：不做段中嵌套结构，按 <br> 拼接）。
					collected[collected.length - 1].text += `\n${cur.trim()}`;
					i++;
					continue;
				}
				break;
			}
			out.push(...buildAllLists(collected, 0, collected[0]?.indent ?? 0));
			continue;
		}
		// 段落：吃到空行或下一个块级起点；行间单个 \n 由行内层落成 <br>。
		const para = [];
		while (i < lines.length && !interruptsParagraph(lines[i])) {
			para.push(lines[i].trim());
			i++;
		}
		out.push({ tag: "p", children: parseInline(para.join("\n")) });
	}
	return out;
}

/** 表头/分隔行的单元格拆分：去掉两端管道带来的空首尾格，其余按 | 切。 */
function splitRow(line) {
	let s = line.trim();
	if (s.startsWith("|")) s = s.slice(1);
	if (s.endsWith("|")) s = s.slice(0, -1);
	return s.split("|").map((c) => c.trim());
}

function thStyle(align) {
	return align ? { style: `text-align:${align}` } : {};
}

function indentWidth(s) {
	let w = 0;
	for (const ch of s) w += ch === "\t" ? TAB_WIDTH - (w % TAB_WIDTH) : 1;
	return w;
}

/** 同缩进层的连续列表（marker 类型 -/1. 翻转处切开成兄弟列表）。 */
function buildAllLists(items, start, indent) {
	const out = [];
	let k = start;
	while (k < items.length && items[k].indent >= indent) {
		const { node, next } = buildList(items, k, indent);
		out.push(node);
		k = next;
	}
	return out;
}

/** 从 items[start] 建一个同 marker 类型的列表；更深缩进的整段递归成子列表挂进
 *  上一个 li（子段内允许 ul/ol 混排 → buildAllLists 切开）。返回 { node, next }。 */
function buildList(items, start, indent) {
	const ordered = items[start].ordered;
	const children = [];
	let k = start;
	while (k < items.length && items[k].indent >= indent) {
		if (items[k].indent >= indent + 2 && children.length) {
			// 深缩进段：聚齐整段同层（≥ indent+2）递归成子列表，挂进上一个 li。
			let m = k;
			while (m < items.length && items[m].indent >= indent + 2) m++;
			children[children.length - 1].children.push(...buildAllLists(items, k, items[k].indent));
			k = m;
			continue;
		}
		if (items[k].ordered !== ordered) break; // 同层 marker 翻转 → 本列表到此为止
		children.push(listItemNode(items[k]));
		k++;
	}
	return { node: { tag: ordered ? "ol" : "ul", children }, next: k };
}

/** 单个 li：任务清单前缀（[ ] / [x]）落成 ☐/☑ 标记，余下内容行内解析。 */
function listItemNode(item) {
	const children = [];
	const task = /^\[( |x|X)\]\s+/.exec(item.text);
	if (task) children.push({ tag: "span", attrs: { class: "gr-md-task" }, children: [task[1] === " " ? "☐" : "☑"] });
	children.push(...parseInline(item.text.slice(task ? task[0].length : 0)));
	return { tag: "li", children };
}

/* ------------------------------------------------------------------ */
/* 行内解析                                                              */
/* ------------------------------------------------------------------ */

/* 优先级即正则顺序：代码 span 最先（内部永不解析），然后图片/链接/自动链接，
 * 再双星/双下划线粗体、删除线，最后单星/单下划线斜体（下划线形态要求词边界，
 * 防 snake_case 误伤）。sticky 正则从 pos 起锚定匹配；命中即消费，未命中前进
 * 一个字符当普通文本。 */
const RE_CODE = /(`+)([\s\S]*?)\1/y;
const RE_IMAGE = /!\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/y;
const RE_LINK = /\[([^\]]*)\]\(\s*([^)\s]+)(?:\s+"[^"]*")?\s*\)/y;
const RE_AUTO = /<(https?:\/\/[^>\s]+|mailto:[^>\s]+)>/y;
const RE_STRONG = /\*\*(?=\S)([\s\S]*?\S)\*\*|__(?=\S)([\s\S]*?\S)__/y;
const RE_EM = /\*(?=\S)([^*]*?\S)\*/y;
const RE_EM_UND = /(?<=^|[^_\w])_(?=\S)([^_]*?\S)_(?![\w_])/y;
const RE_STRIKE = /~~(?=\S)([\s\S]*?\S)~~/y;
const RE_BREAK = /\n/y;

function parseInline(text) {
	const out = [];
	let plain = "";
	let pos = 0;
	const flush = () => {
		if (plain) {
			out.push(plain);
			plain = "";
		}
	};
	while (pos < text.length) {
		let m;
		RE_CODE.lastIndex = pos;
		if ((m = RE_CODE.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "code", children: [m[2]] });
			pos = end;
			continue;
		}
		RE_IMAGE.lastIndex = pos;
		if ((m = RE_IMAGE.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			const src = safeUrl(m[2]);
			// 不安全的图片 URL 不渲染 <img>（不发起请求）—— alt 文本兜底。
			out.push(src ? { tag: "img", attrs: { src, alt: m[1], loading: "lazy" } } : m[1]);
			pos = end;
			continue;
		}
		RE_LINK.lastIndex = pos;
		if ((m = RE_LINK.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push(...linkNode(m[1], m[2]));
			pos = end;
			continue;
		}
		RE_AUTO.lastIndex = pos;
		if ((m = RE_AUTO.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push(...linkNode(m[1], m[1]));
			pos = end;
			continue;
		}
		RE_STRONG.lastIndex = pos;
		if ((m = RE_STRONG.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "strong", children: parseInline(m[1] ?? m[2]) });
			pos = end;
			continue;
		}
		RE_STRIKE.lastIndex = pos;
		if ((m = RE_STRIKE.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "del", children: parseInline(m[1]) });
			pos = end;
			continue;
		}
		RE_EM.lastIndex = pos;
		if ((m = RE_EM.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "em", children: parseInline(m[1]) });
			pos = end;
			continue;
		}
		RE_EM_UND.lastIndex = pos;
		if ((m = RE_EM_UND.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "em", children: parseInline(m[1]) });
			pos = end;
			continue;
		}
		RE_BREAK.lastIndex = pos;
		if ((m = RE_BREAK.exec(text))) {
			// end 先于任何递归取好：parseInline/linkNode 的递归会重置这些共享 sticky
			// regex 的 lastIndex（exec 失败归 0），递归返回后再读就是外层死循环。
			const end = pos + m[0].length;
			flush();
			out.push({ tag: "br" });
			pos = end;
			continue;
		}
		plain += text[pos];
		pos++;
	}
	flush();
	return out;
}

/** [label](url) → [<a>]；URL 不安全 → 降级为纯文本标签节点数组（不可点、不发起
 *  跳转）。恒返数组 —— 调用方 out.push(...linkNode(...)) 两态同构。 */
function linkNode(label, url) {
	const href = safeUrl(url);
	const kids = parseInline(label);
	return href ? [{ tag: "a", attrs: { href, target: "_blank", rel: "noopener noreferrer" }, children: kids }] : kids;
}

/**
 * URL 白名单闸门：scheme 黑名单 javascript:/vbscript:/data:（判定前剔除空白与
 * 控制字符，防 "java\tscript:" 之类写法绕过）；其余放行 —— http/https/mailto、
 * 相对路径、#锚。返回 null 表示不可信，调用方降级为纯文本。
 */
export function safeUrl(raw) {
	let u = String(raw ?? "").trim();
	if (u.startsWith("<") && u.endsWith(">")) u = u.slice(1, -1);
	const probe = u.replace(/[\s\x00-\x1f\x7f]/g, "");
	if (/^(?:javascript|vbscript|data):/i.test(probe)) return null;
	return u;
}
