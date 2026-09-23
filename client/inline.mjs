/**
 * git-review —— 内嵌 diff 面板（client/inline.mjs，Phase 5 / R17）。
 *
 * 需求（R17）：导航里点文件时，diff 查看器**替换聊天主区的消息列表面板**
 * （main.main > .messages-wrap 的内容），不再全屏切到插件视图 —— 聊天头部、
 * 目标条与输入框（composer）都留在原地，评审时随时能打字。
 *
 * 宿主没有「替换主区局部」的插件 API（桥只有 setView/openModal/closeModal/
 * onUiAction），所以这是一次**客户端 DOM 集成**：找到聊天主区的 .messages-wrap，
 * 给它挂 data-gr-inline 属性（配套样式把该容器的**直接子元素**全部隐藏 ——
 * 消息列表、回到底部按钮、排队栏一起让位），再把 viewer 实例装进追加的
 * .gr-inline-host 容器。React 归 React：我们只动 React 不管理的属性与追加
 * 子节点（inline style/attribute 都不在它的 props 里，重渲染不会回写）；
 * 对话切换会按 conversationId **重挂** .messages-wrap，由 MutationObserver
 * 驱动 sync() 把容器挪进新 wrap 并补回属性。
 *
 * ⚠ 宿主内部依赖（与 plugin-page-host 同级的取舍，README 一并记录）：
 *   - `main.main` / `.messages-wrap`（宿主聊天主区的结构类名）
 *   - `view-pane` 的 `hidden` 类（面板可见性开关）
 *   - view id "chat"（setView 目标；桥契约本身只要求任意字符串）
 * 判定/落座/样式全部收口在本文件；宿主改结构时只动 defaultLocate / INLINE_CSS
 * 两处。
 *
 * 行为契约（R17）：
 *   - open() 幂等：已打开只保证落座；换文件由 store 订阅驱动 viewer 重拉。
 *   - 打开态依附「共享选中」：cwd-changed 清选中 → 自动收起还原消息面板。
 *   - ✕（viewer 头部，opts.onClose）只还原面板不清选中 —— 再点同一文件 =
 *     原地重开并重拉一次（关闭期间工作区可能又变了）。
 *   - 全屏插件视图正在展示 → 照常内嵌：view-pane 互斥，此时聊天 pane 本就带
 *     hidden，落座后 setView("chat") 切回去（全屏 pane 转隐藏但仍挂载，可从
 *     钉选/溢出菜单再进）。文件点击永远优先内嵌，全屏只经顶栏入口到达。
 *   - 锚找不到（宿主结构变了/占位环境）→ 回落旧的 setView 全屏切换（R7），
 *     文件点击永不死路。
 *   - 控制器是模块级单例（getInlineController）：右栏 tab 切走（宿主卸载非
 *     活动 tab）后内嵌面板照常活着 —— 与草稿的模块级状态同一策略。
 *
 * 测试：纯判定 planOpen 导出直测；控制器用注入的 locate + 极小假 DOM 驱动
 * （fake-env）；真实 MutationObserver 在假环境缺席 → 观察器自动跳过，重挂场景
 * 由用例直接调 sync()（公开方法，等价于观察器回调入口）。
 */
import { activateMainView } from "./navigator.mjs";
import { createViewer } from "./viewer.mjs";
import * as store from "./store.mjs";

/* ------------------------------------------------------------------ */
/* 纯逻辑（无 DOM，node --test 直接覆盖）                                */
/* ------------------------------------------------------------------ */

/**
 * open() 的判定表（R17 行为契约的单一事实源）：
 *   anchor  defaultLocate 的产物 { main, wrap, hidden } | null
 * 返回：
 *   "seat"         聊天面板可见 → 直接落座
 *   "seat+switch"  聊天面板隐藏（在 terminal/git/全屏插件视图）→ 落座 + setView("chat")
 *   "fallback"     锚找不到 → 旧的 setView 全屏切换（R7 兜底）
 */
export function planOpen({ anchor = null } = {}) {
	if (anchor && anchor.wrap) return anchor.hidden ? "seat+switch" : "seat";
	return "fallback";
}

/**
 * 缺省锚定位（真 DOM）：聊天主区 = `main.main` 且内部有 `.messages-wrap`。
 * 可见面板优先（view-pane 不带 hidden）；全都隐藏（当前在其它视图）→ 取
 * 第一个 —— chat 的 view-pane 永远在 DOM 里（host 只切换 hidden 类），
 * 落座后由 open() 补一次 setView("chat") 让它现出来。
 */
export function defaultLocate(doc) {
	try {
		if (!doc || typeof doc.querySelectorAll !== "function") return null;
		let visible = null;
		let any = null;
		for (const main of doc.querySelectorAll("main.main")) {
			const wrap = main.querySelector?.(".messages-wrap");
			if (!wrap) continue;
			const pane = typeof main.closest === "function" ? main.closest(".view-pane") : null;
			const hidden = pane ? pane.classList?.contains?.("hidden") === true : false;
			const entry = { main, wrap, hidden };
			if (!visible && !hidden) visible = entry;
			if (!any) any = entry;
		}
		return visible ?? any;
	} catch {
		return null;
	}
}

/* ------------------------------------------------------------------ */
/* 样式（navigator/viewer 同款：一次注入 <head>，gr- 前缀防撞宿主）       */
/* ------------------------------------------------------------------ */

export const INLINE_CSS = `
/* 内嵌宿主：占满 .messages-wrap 里消息列表让出的空间（flex 子项）。 */
.gr-inline-host { display: flex; flex-direction: column; flex: 1 1 auto; min-height: 0; }
.gr-inline-host > .gr-vroot { flex: 1 1 auto; min-height: 0; height: auto; }
/* 打开态：wrap 的直接子元素（消息列表 / 回到底部 / 排队栏 / 搜索浮层）全部让位。
   用属性选择器而非 inline style —— 对话切换重挂的新 wrap 由 sync() 补属性即生效。 */
[data-gr-inline] > :not(.gr-inline-host) { display: none !important; }
`;

const styledDocs = new WeakSet();

/** 把内嵌样式注入文档 <head>（每个文档一次；失败不影响功能）。 */
export function ensureInlineStyles(doc) {
	try {
		if (!doc || styledDocs.has(doc)) return;
		const head = doc.head ?? doc.documentElement;
		if (!head || typeof head.append !== "function") return;
		const style = doc.createElement("style");
		style.textContent = INLINE_CSS;
		head.append(style);
		styledDocs.add(doc);
	} catch {
		/* 样式是锦上添花，注入失败不拦功能 */
	}
}

/* ------------------------------------------------------------------ */
/* 控制器                                                               */
/* ------------------------------------------------------------------ */

/**
 * 创建内嵌面板控制器。
 *
 * @param {object} opts
 *   apiBase            服务端 API 前缀（缺省由 import.meta.url 推导）
 *   document           DOM 文档（缺省全局 document；测试注入 FakeDocument）
 *   fetchImpl          fetch 注入（透传给 viewer；测试桩）
 *   locate(doc)        锚定位注入（缺省 defaultLocate；测试用假 DOM 树）
 *   lang               初始语言（透传 viewer；缺省 detectLang()，测试固定用）
 *   ctx                宿主 mount 上下文（只消费 onData：cwd-changed → 清选中 → 收起）
 *
 * viewer 实例与 .gr-inline-host 容器在控制器创建时就地建好，开/关只搬位置、
 * 不重建（重开不重挂载，草稿/选中/滚动状态都在）。
 * @returns {{ open, close, sync, setCtx, destroy, host, viewer, get active }}
 */
export function createInlineController(opts = {}) {
	const doc = opts.document ?? globalThis.document;
	ensureInlineStyles(doc);

	const locate = opts.locate ?? defaultLocate;

	/* viewer 一次性建好：✕ 关闭按钮经 onClose 回到这里（只还原面板）。ctx 不透传
	   —— cwd-changed 的清选中由控制器自己的 onData 订阅负责（setCtx 随重挂换接）。 */
	const viewer = createViewer({
		apiBase: opts.apiBase ?? apiBaseDefault(),
		document: doc,
		fetchImpl: opts.fetchImpl,
		lang: opts.lang,
		onClose: () => close(),
	});
	const host = doc.createElement("div");
	host.className = "gr-inline-host";
	host.append(viewer.root);

	let destroyed = false;
	let active = false;
	let wrapRef = null; // 当前落座的 .messages-wrap（close/sync 的还原目标）
	let offStore = null;
	let offData = null;
	let observer = null; // MutationObserver（真 DOM 才有；假环境自动跳过）
	let syncQueued = false;

	function seat(anchor) {
		const wrap = anchor?.wrap ?? null;
		if (!wrap) return false;
		wrapRef = wrap;
		if (wrap.getAttribute?.("data-gr-inline") !== "1") wrap.setAttribute?.("data-gr-inline", "1");
		if (host.parentNode !== wrap) wrap.append(host); // append 对已挂载节点 = 移动（对话切换后的重落座）
		active = true;
		startObserver();
		return true;
	}

	/** 打开（幂等）：见 planOpen 的判定表。返回是否以「内嵌」形态打开。 */
	function open() {
		if (destroyed) return false;
		if (active) {
			sync(); // 已打开：只保证落座（换文件的拉数由 store 订阅驱动）
			return active; // sync 可能因锚消失收起 —— 如实回报当前形态
		}
		const anchor = locate(doc);
		const plan = planOpen({ anchor });
		if (plan === "fallback") {
			activateMainView(); // 旧的全屏切换（R7）；返回值仍按「非内嵌形态」报 false
			return false;
		}
		seat(anchor);
		if (plan === "seat+switch") activateMainView("chat"); // 聊天面板当前不可见 → 切回去
		void viewer.refresh(); // 每次（重）开都重拉 —— 关闭期间工作区可能又变了
		return true;
	}

	/** 关闭：还原消息面板（摘属性 + 摘容器）；viewer 实例保留待重开。 */
	function close() {
		if (!active) return;
		active = false;
		stopObserver();
		const wrap = wrapRef;
		wrapRef = null;
		if (wrap) {
			if (wrap.getAttribute?.("data-gr-inline") === "1") wrap.removeAttribute?.("data-gr-inline");
			if (host.parentNode === wrap) host.remove();
		}
	}

	/**
	 * 重落座（MutationObserver 回调入口 / 公开方法）：对话切换把 .messages-wrap
	 * 按 conversationId 重挂 —— 挪容器进新 wrap、补属性；聊天主区整个消失 →
	 * 收起（下次文件点击重来）。这里**不**补 setView("chat")：sync 也由后台
	 * 流式变更触发，不能把用户从别的视图拽回来。
	 */
	function sync() {
		if (!active || destroyed) return;
		const anchor = locate(doc);
		if (!anchor || !anchor.wrap) {
			close();
			return;
		}
		seat(anchor);
	}

	/* ---- React 重排跟随（真 DOM only；假环境用例直调 sync()） ---- */

	function startObserver() {
		if (observer || destroyed || !active) return;
		const Obs = globalThis.MutationObserver;
		if (typeof Obs !== "function") return;
		const target = doc.documentElement ?? doc.body ?? doc;
		// 假文档的 documentElement 是 {lang} 裸对象 —— 没有 nodeName 就不是元素，跳过。
		if (!target || typeof target.nodeName !== "string") return;
		observer = new Obs(() => scheduleSync());
		observer.observe(target, { childList: true, subtree: true });
	}

	function stopObserver() {
		try {
			observer?.disconnect();
		} catch {
			/* ignore */
		}
		observer = null;
	}

	function scheduleSync() {
		if (syncQueued || destroyed || !active) return;
		syncQueued = true;
		const flush = () => {
			syncQueued = false;
			if (!destroyed && active) sync();
		};
		if (typeof globalThis.requestAnimationFrame === "function") globalThis.requestAnimationFrame(flush);
		else setTimeout(flush, 0);
	}

	/* ---- 外部联动 ---- */

	// store 变化：打开态下共享选中被清（cwd-changed / 其它挂载清除）→ 自动收起还原。
	offStore = store.subscribe(() => {
		if (destroyed) return;
		if (active && !store.getState().selectedPath) close();
	});

	/** 重挂宿主上下文（navigator 每次 mount 调用；换 ctx 先注销旧 onData）。 */
	function setCtx(ctx) {
		try {
			offData?.();
		} catch {
			/* ignore */
		}
		offData = null;
		if (typeof ctx?.onData === "function") {
			offData = ctx.onData((payload) => {
				if (payload && payload.kind === "cwd-changed" && !destroyed) store.setSelection(null);
			});
		}
	}

	setCtx(opts.ctx);

	function destroy() {
		if (destroyed) return;
		destroyed = true;
		close();
		try {
			offStore?.();
		} catch {
			/* ignore */
		}
		try {
			offData?.();
		} catch {
			/* ignore */
		}
		try {
			viewer.destroy();
		} catch {
			/* ignore */
		}
	}

	return {
		open,
		close,
		sync,
		setCtx,
		destroy,
		host,
		viewer,
		get active() {
			return active;
		},
	};
}

/* ------------------------------------------------------------------ */
/* 宿主模态（右栏 tab 的弹窗打开形态）                                    */
/* ------------------------------------------------------------------ */

/** 宿主插件模态的容器类（plugin-modal-body）—— 又一处宿主内部细节，收口在这里。 */
export const HOST_MODAL_BODY_CLASS = "plugin-modal-body";

/**
 * 若 root 在宿主插件模态里 → 关掉模态（best-effort）：模态形态下点文件，内嵌
 * 面板落在主区（弹窗之下），不关弹窗用户什么也看不见。桥缺失 / 不在模态 /
 * closest 不可用（假 DOM）→ 安静 no-op。
 */
export function closeHostModalIfIn(root) {
	try {
		if (typeof root?.closest !== "function" || !root.closest(`.${HOST_MODAL_BODY_CLASS}`)) return false;
		const bridge = globalThis.window?.__piWebUiHost;
		if (bridge && typeof bridge.closeModal === "function") {
			bridge.closeModal();
			return true;
		}
	} catch {
		/* ignore */
	}
	return false;
}

/* ------------------------------------------------------------------ */
/* 模块级单例（entry 装配点；右栏 tab 卸载后内嵌面板照常活着）             */
/* ------------------------------------------------------------------ */

let singleton = null;

/**
 * 取控制器单例（entry.mjs navigator 角色用）：首次创建按 opts 装配；重挂载
 * 只换 ctx（onData 重接）。测试不走这里（用 createInlineController 起新实例）。
 */
export function getInlineController(opts = {}) {
	if (!singleton) singleton = createInlineController(opts);
	else if (opts.ctx) singleton.setCtx(opts.ctx);
	return singleton;
}

/* ------------------------------------------------------------------ */
/* 小工具                                                               */
/* ------------------------------------------------------------------ */

/** notes/navigator 同款：从 bundle URL 推 /plugins-api/git-review 前缀。 */
function apiBaseDefault() {
	try {
		if (typeof import.meta?.url === "string") return apiBaseFromUrl(import.meta.url);
	} catch {
		/* fall through */
	}
	return "/plugins-api/git-review";
}
