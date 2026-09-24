/**
 * fake-env.mjs —— client bundle 视图套件（navigator / viewer）共享的假浏览器环境。
 *
 * 为什么必须单一来源：`node --test test/` 经 test/index.js 把所有套件动态 import
 * 进**同一个进程**，而 node:test 在全部模块装载完之后才运行各测试体。此前两个
 * 套件各自在模块顶层装一份 globalThis.localStorage（各自背后一个袋子）—— 后装
 * 载的把先装载的打掉，先装载套件的用例就跑在别人的袋子上（viewModes 持久化跨
 * 套件泄漏：「navigator toggles」单独跑全绿、全量跑必挂，反之 viewer 亦然）。
 * 这里收口成单一实现：
 *
 *   - localStorage 桩 + 全进程唯一的共享袋子。installGlobalStubs() 幂等（已是
 *     本桩则不动）；store.mjs 对 localStorage 是**每次调用时再取**，所以桩只需
 *     在被测模块装载前装好一次，两个套件用例里各自 localStorageBag.clear() 复位
 *     即可，互不可见对方残留；
 *   - 极小假 DOM（FakeElement / FakeDocument）。取两个套件用面的**超集**：
 *     dispatch(type, extra) / click(extra) 可并入事件扩展字段（如 shiftKey），
 *     不带扩展字段的调用照常工作；
 *   - collect()：按 className 收集子树的查询辅助（两套件同款）；
 *   - createBridgeSpy()：宿主桥桩 —— onLocale 处理器登记（R12 change-only 语义
 *     的测试注入点，deliverLocale 模拟宿主推载荷）+ setView spy（R7 桥契约，
 *     "plugin:<id>" 调用记录进 setViews）。
 *
 * 全局桩次序约定不变：先 installGlobalStubs() 再动态 import 被测模块；而
 * document / window 这类按用例变化的桩仍由各用例自带 save/restore（finally 归还）。
 */

/** localStorage 桩背后的唯一共享袋子（两个套件各自的用例用 clear() 复位）。 */
export const localStorageBag = new Map();

const canonicalLocalStorage = {
	getItem: (key) => (localStorageBag.has(key) ? localStorageBag.get(key) : null),
	setItem: (key, value) => localStorageBag.set(key, String(value)),
	removeItem: (key) => localStorageBag.delete(key),
};

/**
 * 幂等安装全局桩：globalThis.localStorage 永远指向这一份实现（已是则不动，
 * 绝不用第二份实现覆盖 —— 那正是跨套件污染的根源）。返回安装的桩。
 */
export function installGlobalStubs() {
	if (globalThis.localStorage !== canonicalLocalStorage) {
		globalThis.localStorage = canonicalLocalStorage;
	}
	return canonicalLocalStorage;
}

export class FakeElement {
	constructor(tag) {
		this.tagName = String(tag).toUpperCase();
		this.childNodes = [];
		this.parentNode = null;
		this._classes = new Set();
		this.dataset = {};
		this._attributes = {};
		this._listeners = new Map();
		this.style = { cssText: "" };
		this._value = "";
	}

	get classList() {
		const classes = this._classes;
		return {
			add: (...names) => names.forEach((name) => classes.add(name)),
			remove: (...names) => names.forEach((name) => classes.delete(name)),
			toggle: (name, force) => {
				const on = force === undefined ? !classes.has(name) : Boolean(force);
				if (on) classes.add(name);
				else classes.delete(name);
				return on;
			},
			contains: (name) => classes.has(name),
		};
	}

	get className() {
		return [...this._classes].join(" ");
	}

	set className(value) {
		this._classes = new Set(String(value).split(/\s+/).filter(Boolean));
	}

	get textContent() {
		return this.childNodes.map((child) => (typeof child === "string" ? child : child.textContent)).join("");
	}

	set textContent(value) {
		for (const child of this.childNodes) {
			if (typeof child !== "string") child.parentNode = null;
		}
		// 真 DOM 语义：textContent = ""（或 null/undefined）→ 无子节点；非空 → 单个文本节点。
		this.childNodes = value ? [String(value)] : [];
	}

	append(...nodes) {
		for (const node of nodes) {
			if (node === undefined || node === null || node === false) continue;
			if (typeof node === "string" || typeof node === "number") {
				this.childNodes.push(String(node));
				continue;
			}
			if (node.parentNode) node.remove();
			node.parentNode = this;
			this.childNodes.push(node);
		}
	}

	/** 标准 DOM API（entry.mjs 的宿主容器挂载用的就是它）。 */
	appendChild(node) {
		this.append(node);
		return node;
	}

	remove() {
		if (!this.parentNode) return;
		const index = this.parentNode.childNodes.indexOf(this);
		if (index >= 0) this.parentNode.childNodes.splice(index, 1);
		this.parentNode = null;
	}

	setAttribute(name, value) {
		this._attributes[name] = String(value);
	}

	getAttribute(name) {
		return this._attributes[name] ?? null;
	}

	removeAttribute(name) {
		delete this._attributes[name];
	}

	/** 最近祖先匹配（只支持 inline.mjs 用到的 `.class` 形态）。 */
	closest(selector) {
		const cls = typeof selector === "string" && selector.startsWith(".") ? selector.slice(1) : null;
		if (!cls) return null;
		for (let node = this; node; node = node.parentNode) {
			if (typeof node.classList?.contains === "function" && node.classList.contains(cls)) return node;
		}
		return null;
	}

	addEventListener(type, handler) {
		let handlers = this._listeners.get(type);
		if (!handlers) {
			handlers = new Set();
			this._listeners.set(type, handlers);
		}
		handlers.add(handler);
	}

	/** extra 并入事件对象 —— shiftKey 等（真 DOM 的 click(event) 也这样合成）。 */
	dispatch(type, extra) {
		const event = { type, target: this, preventDefault() {}, ...(extra ?? {}) };
		for (const handler of [...(this._listeners.get(type) ?? [])]) handler(event);
	}

	click(extra) {
		this.dispatch("click", extra);
	}

	get value() {
		return this._value;
	}

	set value(value) {
		this._value = String(value);
	}
}

export class FakeDocument {
	constructor() {
		this.head = new FakeElement("head");
		// 宿主文档约定（R12）：宿主会写 documentElement.lang，插件的初始语言从这读。
		// 假文档同样带上（zh）——否则 detectLang 会落到 globalThis.navigator.language
		//（Node 测试进程的机器 locale，如 en-GB）上，用例期望的 zh 文案变成环境抽奖。
		this.documentElement = { lang: "zh-CN" };
	}

	createElement(tag) {
		return new FakeElement(tag);
	}

	/** SVG 命名空间创建（navigator 行动作芯片的 Feather 图标用）；假 DOM 不区分
	 * 命名空间 —— 与 createElement 同款返回 FakeElement，测试只验结构不验渲染。 */
	createElementNS(_ns, tag) {
		return new FakeElement(tag);
	}
}

/** 按 className 收集子树节点（顺序 = 构建序）。 */
export function collect(node, className, into = []) {
	if (node?.classList?.contains?.(className)) into.push(node);
	for (const child of node?.childNodes ?? []) {
		if (typeof child !== "string") collect(child, className, into);
	}
	return into;
}

/**
 * 宿主桥桩（window.__piWebUiHost 的测试替身）：
 *   host              装进 globalThis.window = { __piWebUiHost: spy.host } 用
 *   setViews          setView 调用记录（R7：期望 ["plugin:git-review"]）
 *   deliverLocale     模拟宿主推 onLocale 载荷（R12 change-only：注册时不回放）
 *   hasLocaleSubscriber  断言「订阅确实发生了」用
 */
export function createBridgeSpy() {
	const setViews = [];
	const localeHandlers = new Set();
	let closeModals = 0;
	const host = {
		/** 桥契约 web/src/plugin-host.ts：setView(view: string) — void 返回。 */
		setView: (view) => {
			setViews.push(view);
		},
		/** 桥契约：closeModal() 关掉当前弹窗（幂等）。 */
		closeModal: () => {
			closeModals += 1;
		},
		/** change-only 订阅：登记处理器、返回注销函数，不回放当前语言。 */
		onLocale: (handler) => {
			localeHandlers.add(handler);
			return () => localeHandlers.delete(handler);
		},
	};
	return {
		host,
		setViews,
		get closeModals() {
			return closeModals;
		},
		deliverLocale(loc) {
			for (const handler of [...localeHandlers]) handler(loc);
		},
		hasLocaleSubscriber: () => localeHandlers.size > 0,
	};
}
