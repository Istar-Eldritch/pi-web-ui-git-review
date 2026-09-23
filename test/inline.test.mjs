/**
 * inline.test.mjs —— 内嵌 diff 面板（Phase 5 / R17）的裸 ESM 测试，无 npm。
 *
 * 覆盖三层：
 *   1. 纯判定 planOpen（R17 行为契约的判定表）：skip / seat / seat+switch / fallback；
 *   2. 控制器整链路（注入 locate + 极小假 DOM + 桩 fetch）：
 *      落座（属性 + 容器 + viewer 挂载 + 拉数）、关闭还原（属性/容器摘除、选中
 *      保留）、重开重拉、store 清选中自动收起、cwd-changed（setCtx 的 onData）
 *      自动收起、锚消失回落 setView 全屏、隐藏面板落座 + setView("chat")、
 *      全屏插件视图激活时照常内嵌、对话切换（换 wrap）后 sync() 重落座；
 *   3. navigator 行点击接 openFile（entry 装配契约）：注入时点击走 openFile，
 *      未注入时回落 activateMainView（既有桥语义不变）。
 *
 * 全局桩次序同 viewer/navigator 套件：先 installGlobalStubs() 再动态 import
 * 被测模块（见 fake-env.mjs 头注释 —— 同进程共享一份 localStorage 桩）。
 * 真 MutationObserver 在假环境缺席 → 控制器观察器自动跳过，重挂场景由用例
 * 直调 sync()（公开方法，等价于观察器回调入口）。
 */
import assert from "node:assert/strict";
import { describe, it } from "node:test";

/* ------------------------------------------------------------------ */
/* 全局桩（先于被测模块；与 navigator/viewer 套件共享 —— 见 fake-env.mjs）  */
/* ------------------------------------------------------------------ */

import { collect, createBridgeSpy, FakeDocument, FakeElement, installGlobalStubs, localStorageBag } from "./fake-env.mjs";
installGlobalStubs();

const store = await import("../client/store.mjs");
const inlineModule = await import("../client/inline.mjs");
const navModule = await import("../client/navigator.mjs");
const viewerModule = await import("../client/viewer.mjs");
const i18n = await import("../client/i18n.mjs");

const SHA_BASE = "a".repeat(40);
const SHA_HEAD = "c".repeat(40);

/* ------------------------------------------------------------------ */
/* 桩服务端（只需 /diff；控制器/导航不取数，取数全在 viewer）              */
/* ------------------------------------------------------------------ */

function diffPayload(path) {
	return {
		ok: true,
		path,
		base: { ref: "main", sha: SHA_BASE, source: "marker" },
		head: { sha: SHA_HEAD },
		status: "M",
		binary: false,
		truncated: false,
		hunks: [
			{
				oldStart: 1,
				oldLines: 2,
				newStart: 1,
				newLines: 2,
				lines: [
					{ type: "ctx", old: 1, new: 1, text: "const a = 1;" },
					{ type: "del", old: 2, text: "const b = 2;" },
					{ type: "add", new: 2, text: "const b = 20;" },
				],
			},
		],
	};
}

function createDiffStub() {
	const calls = [];
	const fetchImpl = async (url, init) => {
		const parsed = new URL(url, "http://stub.local");
		const all = parsed.pathname;
		const anchor = all.lastIndexOf("/plugins-api/git-review");
		const route = anchor >= 0 ? all.slice(anchor + "/plugins-api/git-review".length) : all;
		const query = Object.fromEntries(parsed.searchParams);
		calls.push({ method: init?.method ?? "GET", route, query });
		const body = route === "/diff" ? diffPayload(query.path) : { ok: false, error: `no stub route: ${route}` };
		return { ok: true, status: 200, text: async () => JSON.stringify(body) };
	};
	return { fetchImpl, calls };
}

/* ------------------------------------------------------------------ */
/* 共享状态复位 / 假宿主锚构造                                            */
/* ------------------------------------------------------------------ */

function resetStore() {
	store.setSelection(null);
	store.setState({ lastReview: null });
	store.setBaseOverride(null);
	store.clearDrafts();
	localStorageBag.clear();
}

/** 假宿主结构：view-pane > main.main > .messages-wrap（> .messages 等）。 */
function fakeHost({ hidden = false } = {}) {
	const messages = new FakeElement("div");
	messages.className = "messages";
	const scrollBottom = new FakeElement("button");
	scrollBottom.className = "scroll-bottom";
	const wrap = new FakeElement("div");
	wrap.className = "messages-wrap";
	wrap.append(messages, scrollBottom);
	const main = new FakeElement("main");
	main.className = "main";
	main.append(wrap);
	const pane = new FakeElement("div");
	pane.className = hidden ? "view-pane hidden" : "view-pane";
	pane.append(main);
	return { pane, main, wrap, messages, scrollBottom };
}

/** locate 注入：锚定给定的假宿主（静态；可变目标见对话切换用例的局部 locate）。 */
function locateTargeting(host) {
	return () => ({ main: host.main, wrap: host.wrap, hidden: host.pane.classList.contains("hidden") });
}

/** 等待 viewer 的异步 refresh 落地（seq 稳定后断言）。 */
const tick = (ms = 20) => new Promise((resolve) => setTimeout(resolve, ms));

/* ------------------------------------------------------------------ */
/* 1. 纯判定 planOpen                                                    */
/* ------------------------------------------------------------------ */

describe("planOpen (R17 decision table)", () => {
	it("visible chat main → seat; hidden chat main (terminal/git/full-screen plugin view) → seat+switch", () => {
		assert.equal(inlineModule.planOpen({ anchor: { main: {}, wrap: {}, hidden: false } }), "seat");
		assert.equal(inlineModule.planOpen({ anchor: { main: {}, wrap: {}, hidden: true } }), "seat+switch");
	});

	it("no anchor at all → fallback to the legacy full-screen setView (R7)", () => {
		assert.equal(inlineModule.planOpen({ anchor: null }), "fallback");
	});
});

/* ------------------------------------------------------------------ */
/* 2. 控制器整链路                                                        */
/* ------------------------------------------------------------------ */

describe("inline controller", () => {
	it("open() seats the viewer into the messages panel: attribute + host + mounted diff (fetch fired)", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
		});
		assert.equal(controller.active, false);

		assert.equal(controller.open(), true);
		assert.equal(controller.active, true);
		assert.equal(host.wrap.getAttribute("data-gr-inline"), "1");
		assert.ok(host.wrap.childNodes.includes(controller.host), "inline host must be a child of messages-wrap");
		assert.ok(collect(controller.host, "gr-vroot").length === 1, "viewer root mounted inside the inline host");

		await tick();
		assert.ok(collect(controller.host, "gr-vline").length > 0, "diff rows rendered (not the empty state: opened with a selection)");
		assert.ok(server.calls.some((c) => c.route === "/diff" && c.query.path === "src/app.ts"), "diff fetched for the selection");

		controller.destroy();
	});

	it("open() is idempotent: re-click / re-open while active does not refetch", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
		});
		controller.open();
		await tick();
		const afterFirst = server.calls.filter((c) => c.route === "/diff").length;
		assert.equal(afterFirst, 1);

		controller.open(); // 幂等：不重复拉数（换文件的重拉由 store 订阅负责）
		controller.open();
		await tick();
		assert.equal(server.calls.filter((c) => c.route === "/diff").length, 1);
		controller.destroy();
	});

	it("close() restores the messages panel but keeps the selection; reopen re-fetches fresh data", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
		});
		controller.open();
		await tick();

		controller.close();
		assert.equal(controller.active, false);
		assert.equal(host.wrap.getAttribute("data-gr-inline"), null, "hide-attribute removed");
		assert.ok(!host.wrap.childNodes.includes(controller.host), "inline host detached");
		assert.equal(store.getState().selectedPath, "src/app.ts", "selection survives the close");

		controller.open(); // 再点同一文件 → 原地重开并重拉（关闭期间工作区可能又变了）
		assert.equal(controller.active, true);
		assert.equal(host.wrap.getAttribute("data-gr-inline"), "1");
		assert.ok(host.wrap.childNodes.includes(controller.host));
		await tick();
		assert.ok(server.calls.filter((c) => c.route === "/diff").length >= 2, "reopened → refetched");
		controller.destroy();
	});

	it("viewer header ✕ (opts.onClose) closes the panel", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
			locate: locateTargeting(host),
		});
		controller.open();
		await tick();

		const closeBtn = collect(controller.viewer.root, "gr-vclose")[0];
		assert.ok(closeBtn, "inline viewer renders the close button");
		assert.equal(closeBtn.textContent, "关闭");
		closeBtn.click();
		assert.equal(controller.active, false, "✕ restores the messages panel");
		assert.equal(host.wrap.getAttribute("data-gr-inline"), null);
		controller.destroy();
	});

	it("clearing the shared selection closes the panel automatically (store subscription)", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
		});
		controller.open();
		assert.equal(controller.active, true);

		store.setSelection(null); // 任意挂载清选中（如全屏 viewer 的 cwd-changed 处理）
		assert.equal(controller.active, false, "panel auto-closed");
		assert.equal(host.wrap.getAttribute("data-gr-inline"), null);
		controller.destroy();
	});

	it("cwd-changed via ctx.onData clears the selection and closes the panel", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const dataCbs = [];
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
			ctx: { onData: (cb) => dataCbs.push(cb) },
		});
		controller.open();
		assert.equal(controller.active, true);

		for (const cb of dataCbs) cb({ kind: "cwd-changed" });
		assert.equal(store.getState().selectedPath, null, "selection cleared");
		assert.equal(controller.active, false, "panel closed after a workspace switch");
		controller.destroy();
	});

	it("setCtx rewires onData across navigator remounts without leaking the old subscription", async () => {
		resetStore();
		const firstCbs = [];
		const secondCbs = [];
		let firstOff = false;
		const firstCtx = {
			onData: (cb) => {
				firstCbs.push(cb);
				return () => {
					firstOff = true;
					const i = firstCbs.indexOf(cb); // 真宿主语义：注销 = 摘除处理器
					if (i >= 0) firstCbs.splice(i, 1);
				};
			},
		};
		const server = createDiffStub();
		const host = fakeHost();
		const secondCtx = {
			onData: (cb) => {
				secondCbs.push(cb);
				return () => {};
			},
		};
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
			ctx: firstCtx,
		});
		store.setSelection({ path: "src/app.ts", base: "main" });
		controller.open();
		assert.equal(controller.active, true);

		controller.setCtx(secondCtx); // 重挂载：换 ctx → 旧订阅注销、新订阅生效
		assert.equal(firstOff, true, "old onData unsubscribed");
		assert.equal(firstCbs.length, 0, "old handler deregistered");
		assert.equal(secondCbs.length, 1, "new handler registered");

		for (const cb of firstCbs) cb({ kind: "cwd-changed" }); // 旧订阅必须已死
		assert.equal(controller.active, true, "stale subscription must not close the panel");

		for (const cb of secondCbs) cb({ kind: "cwd-changed" }); // 新订阅生效
		assert.equal(controller.active, false, "live subscription closes the panel");
		controller.destroy();
	});

	it("no anchor → falls back to the legacy full-screen setView (R7), never a dead click", () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge.host };
		try {
			const controller = inlineModule.createInlineController({
				document: new FakeDocument(),
				apiBase: "/plugins-api/git-review",
				locate: () => null,
			});
			assert.equal(controller.open(), false);
			assert.deepEqual(bridge.setViews, ["plugin:git-review"], "legacy full-screen fallback fired");
			assert.equal(controller.active, false);
			controller.destroy();
		} finally {
			globalThis.window = previousWindow;
		}
	});

	it("hidden chat main (on terminal/git view) → seats there AND switches back via setView('chat')", () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge.host };
		try {
			const host = fakeHost({ hidden: true });
			const controller = inlineModule.createInlineController({
				document: new FakeDocument(),
				apiBase: "/plugins-api/git-review",
				locate: locateTargeting(host),
			});
			assert.equal(controller.open(), true);
			assert.equal(controller.active, true);
			assert.equal(host.wrap.getAttribute("data-gr-inline"), "1");
			assert.deepEqual(bridge.setViews, ["chat"], "chat pane activated");
			controller.destroy();
		} finally {
			globalThis.window = previousWindow;
		}
	});

	it("our full-screen viewer is active → file click still prefers inline (seats + setView('chat'))", () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge.host };
		try {
			const host = fakeHost({ hidden: true }); // 插件视图激活时聊天 pane 带 hidden
			const controller = inlineModule.createInlineController({
				document: new FakeDocument(),
				apiBase: "/plugins-api/git-review",
				locate: locateTargeting(host),
			});
			assert.equal(controller.open(), true);
			assert.equal(controller.active, true);
			assert.equal(host.wrap.getAttribute("data-gr-inline"), "1");
			assert.deepEqual(bridge.setViews, ["chat"], "chat pane brought back with the panel seated");
			controller.destroy();
		} finally {
			globalThis.window = previousWindow;
		}
	});

	it("sync() re-seats after a conversation switch (messages-wrap remounted)", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const first = fakeHost();
		let target = first;
		const locate = () => ({ main: target.main, wrap: target.wrap, hidden: target.pane.classList.contains("hidden") });
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate,
		});
		controller.open();
		await tick();
		assert.equal(first.wrap.getAttribute("data-gr-inline"), "1");
		assert.ok(first.wrap.childNodes.includes(controller.host));

		// 对话切换：宿主按 conversationId 重挂 .messages-wrap —— 新元素、无属性、
		// 旧 wrap 连同旧容器一起脱离文档。观察器回调入口（真 DOM）= 这里的 sync()。
		const second = fakeHost();
		target = second;
		controller.sync();
		assert.equal(controller.active, true, "stays open across the conversation switch");
		assert.equal(second.wrap.getAttribute("data-gr-inline"), "1", "hide-attribute re-applied to the fresh wrap");
		assert.ok(second.wrap.childNodes.includes(controller.host), "inline host moved into the fresh wrap");
		assert.ok(!first.wrap.childNodes.includes(controller.host), "detached from the stale wrap");
		controller.destroy();
		// destroy 后旧假宿主不再被引用（垃圾回收同真 DOM 脱离节点）。
	});

	it("sync() closes when the chat main area is gone entirely (host layout changed)", () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const host = fakeHost();
		let target = host;
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			locate: () => (target ? { main: target.main, wrap: target.wrap, hidden: false } : null),
		});
		controller.open();
		assert.equal(controller.active, true);

		target = null; // 聊天主区整个被拿掉
		controller.sync();
		assert.equal(controller.active, false, "closed instead of dangling");
		controller.destroy();
	});

	it("closeHostModalIfIn closes the host modal only when the navigator lives inside it", () => {
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge.host };
		try {
			// 模态形态：plugin-page 挂在 .plugin-modal-body 里（宿主 nm 的模态分支）。
			const modalBody = new FakeElement("div");
			modalBody.className = "modal-body plugin-modal-body";
			const pageHost = new FakeElement("div");
			pageHost.className = "plugin-page-host";
			modalBody.append(pageHost);
			assert.equal(inlineModule.closeHostModalIfIn(pageHost), true, "inside the modal → closed");
			assert.equal(bridge.closeModals, 1, "bridge closeModal fired");
			assert.deepEqual(bridge.setViews, []);

			const plain = new FakeElement("div");
			plain.className = "plugin-page-host"; // 右栏 tab 形态：不在模态里
			assert.equal(inlineModule.closeHostModalIfIn(plain), false, "not in the modal → no-op");
			assert.equal(inlineModule.closeHostModalIfIn(null), false, "null root → no-op");
			assert.equal(bridge.closeModals, 1, "no extra closeModal");
			assert.deepEqual(bridge.setViews, []);
		} finally {
			globalThis.window = previousWindow;
		}
	});

	it("destroy() is idempotent and detaches everything", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const host = fakeHost();
		const controller = inlineModule.createInlineController({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			locate: locateTargeting(host),
		});
		controller.open();
		await tick();
		controller.destroy();
		assert.doesNotThrow(() => controller.destroy()); // 幂等
		assert.equal(controller.active, false);
		assert.equal(host.wrap.getAttribute("data-gr-inline"), null);
		assert.ok(!host.wrap.childNodes.includes(controller.host));
		// 销毁后的 open/close/sync 全部安静无操作。
		assert.equal(controller.open(), false);
	});
});

/* ------------------------------------------------------------------ */
/* 3. navigator 行点击接 openFile（entry 装配契约）                        */
/* ------------------------------------------------------------------ */

describe("navigator file click → openFile (R17 wiring)", () => {
	/** 最小 /review 载荷（一行文件即可驱动行点击）。 */
	function navFetch(url) {
		const parsed = new URL(url, "http://stub.local");
		const route = parsed.pathname.slice(parsed.pathname.lastIndexOf("/plugins-api/git-review") + "/plugins-api/git-review".length);
		let body = { ok: false, error: `no stub route: ${route}` };
		if (route === "/review") {
			body = {
				ok: true,
				base: { ref: "main", sha: SHA_BASE, source: "marker" },
				head: { sha: SHA_HEAD },
				files: [{ path: "src/app.ts", status: "M", add: 1, del: 1, flags: [] }],
				total: 1,
				truncated: false,
			};
		} else if (route === "/marker") {
			body = { ok: true, sha: SHA_BASE, repoRoot: "/repo" };
		} else if (route === "/refs" || route === "/commits") {
			body = { ok: true, refs: [], commits: [] };
		}
		return Promise.resolve({ ok: true, status: 200, text: async () => JSON.stringify(body) });
	}

	async function mountNavigator(extraOpts = {}) {
		const view = navModule.createNavigator({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: navFetch,
			lang: "zh",
			...extraOpts,
		});
		await view.refresh();
		return view;
	}

	it("with openFile injected, the row click routes through it (inline-first)", async () => {
		resetStore();
		const opened = [];
		const view = await mountNavigator({ openFile: () => opened.push(store.getState().selectedPath) });
		const row = collect(view.root, "gr-row").find((el) => el.dataset.path === "src/app.ts");
		row.click();
		assert.deepEqual(opened, ["src/app.ts"], "openFile called after the selection landed in the store");
		view.destroy();
	});

	it("without openFile, the row click keeps the legacy setView bridge contract (R7)", async () => {
		resetStore();
		const bridge = createBridgeSpy();
		const previousWindow = globalThis.window;
		globalThis.window = { __piWebUiHost: bridge.host };
		try {
			const view = await mountNavigator();
			const row = collect(view.root, "gr-row").find((el) => el.dataset.path === "src/app.ts");
			row.click();
			assert.deepEqual(bridge.setViews, ["plugin:git-review"]);
			assert.equal(store.getState().selectedPath, "src/app.ts");
			view.destroy();
		} finally {
			globalThis.window = previousWindow;
		}
	});
});

/* ------------------------------------------------------------------ */
/* 4. 全屏 viewer 不受影响（无 onClose 就没有关闭按钮；i18n 键在）           */
/* ------------------------------------------------------------------ */

describe("full-screen viewer stays unchanged (R17 compatibility)", () => {
	it("createViewer without onClose renders no close button", () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
		});
		assert.equal(collect(view.root, "gr-vclose").length, 0, "no close button in the full-screen form");
		view.destroy();
	});

	it("createViewer with onClose renders the close button in the header", async () => {
		resetStore();
		store.setSelection({ path: "src/app.ts", base: "main" });
		const server = createDiffStub();
		const closes = [];
		const view = viewerModule.createViewer({
			document: new FakeDocument(),
			apiBase: "/plugins-api/git-review",
			fetchImpl: server.fetchImpl,
			lang: "zh",
			onClose: () => closes.push(1),
		});
		const btn = collect(view.root, "gr-vclose")[0];
		assert.ok(btn, "close button rendered when onClose is provided");
		assert.equal(i18n.t("zh", "viewer.close"), "关闭");
		assert.equal(i18n.t("en", "viewer.close"), "Close");
		btn.click();
		assert.deepEqual(closes, [1]);
		view.destroy();
	});
});
