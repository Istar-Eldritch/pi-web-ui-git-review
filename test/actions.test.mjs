/**
 * actions.test.mjs —— R25 文件行快捷动作：纯逻辑决策表 + 流程注入桩。
 *
 * 纯函数（absPath / baseName / blobTextFromPayload / planAttach /
 * referenceAttachment）直测决策表；createRowActions 用注入的 fetch / 桥 /
 * 剪贴板测降级链（附加→引用→文本→无操作，全程不抛错）。
 * 不装 fake-env（本套件不碰 DOM/store 单例）—— store.mjs 的 copyToClipboard
 * 在无剪贴板环境返回 false，copyPath 的失败分支恰好用它。
 */
import { describe, it } from "node:test";
import assert from "node:assert/strict";

const A = await import("../client/actions.mjs");
const { absPath, baseName, blobTextFromPayload, planAttach, referenceAttachment, createRowActions, MAX_ATTACH_BYTES } = A;

/** 单行 ctx hunk 载荷构造（服务端 previewHunks/wholeFileHunks 形态）。 */
function blobPayload(lines, extra = {}) {
	return {
		ok: true,
		path: extra.path ?? "x/y.mjs",
		preview: true,
		side: "new",
		binary: false,
		truncated: false,
		hunks: [{ oldStart: 1, oldLines: lines.length, newStart: 1, newLines: lines.length, lines: lines.map((text, i) => ({ type: "ctx", old: i + 1, new: i + 1, text })) }],
		...extra,
	};
}

describe("actions: absPath / baseName", () => {
	it("join 仓库根与相对路径（根尾斜杠、路径头斜杠都归一）", () => {
		assert.equal(absPath("/repo", "a/b.mjs"), "/repo/a/b.mjs");
		assert.equal(absPath("/repo/", "a/b.mjs"), "/repo/a/b.mjs");
		assert.equal(absPath("/repo", "/a/b.mjs"), "/repo/a/b.mjs");
	});

	it("仓库根缺失 → 相对路径原样（降级语义）；空尾段 → 根本身", () => {
		assert.equal(absPath("", "a/b.mjs"), "a/b.mjs");
		assert.equal(absPath(null, "a/b.mjs"), "a/b.mjs");
		assert.equal(absPath("/repo", ""), "/repo");
	});
});

describe("actions: baseName", () => {
	it("取尾段；无分隔符原样", () => {
		assert.equal(baseName("a/b/c.mjs"), "c.mjs");
		assert.equal(baseName("c.mjs"), "c.mjs");
		assert.equal(baseName(""), "");
	});
});

describe("actions: blobTextFromPayload", () => {
	it("单 hunk ctx 行 join = 全文（空 hunks = 空文件 \"\"）", () => {
		assert.equal(blobTextFromPayload(blobPayload(["a", "b", "c"])), "a\nb\nc");
		assert.equal(blobTextFromPayload({ ok: true, hunks: [] }), "");
	});

	it("形态不对 → null（多 hunk / 非 ctx 行 = 片段，不满足附加语义）", () => {
		assert.equal(blobTextFromPayload({ ok: true, hunks: [{ lines: [{ type: "ctx", text: "a" }] }, { lines: [{ type: "ctx", text: "b" }] }] }), null);
		const mixed = blobPayload(["a"]);
		mixed.hunks[0].lines[0].type = "add";
		assert.equal(blobTextFromPayload(mixed), null);
		assert.equal(blobTextFromPayload(null), "");
	});
});

describe("actions: planAttach 决策表", () => {
	it("完整全文 → attach（text/size/name 齐）", () => {
		const plan = planAttach(blobPayload(["hello", "world"], { path: "src/app.mjs" }));
		assert.equal(plan.kind, "attach");
		assert.equal(plan.text, "hello\nworld");
		assert.equal(plan.size, new TextEncoder().encode("hello\nworld").length);
		assert.equal(plan.name, "app.mjs");
	});

	it("错误载荷 / 二进制 / 截断 → reference + reason", () => {
		assert.deepEqual(planAttach({ ok: false, error: "x" }), { kind: "reference", reason: "error" });
		assert.deepEqual(planAttach(null), { kind: "reference", reason: "error" });
		assert.equal(planAttach(blobPayload(["a"], { binary: true })).reason, "binary");
		assert.equal(planAttach(blobPayload(["a"], { truncated: true })).reason, "truncated");
	});

	it("超上限 → reference(\"too-big\")；上限内 → attach", () => {
		const big = blobPayload(["x".repeat(100)]);
		assert.equal(planAttach(big, 10).reason, "too-big");
		assert.equal(planAttach(big, 1000).kind, "attach");
		assert.ok(MAX_ATTACH_BYTES > 0);
	});
});

describe("actions: referenceAttachment", () => {
	it("绝对路径 + 尾段名 + mode reference（宿主全局搜索附着同款形态）", () => {
		assert.deepEqual(referenceAttachment("/repo", "a/b.mjs"), { path: "/repo/a/b.mjs", name: "b.mjs", mode: "reference" });
		assert.deepEqual(referenceAttachment("", "a/b.mjs"), { path: "a/b.mjs", name: "b.mjs", mode: "reference" });
	});
});

/** fetch 桩：按 URL 前缀分流 /marker 与 /blob，记录调用。 */
function fetchStub({ marker, blob, blobError = false } = {}) {
	const calls = [];
	const impl = async (url) => {
		calls.push(String(url));
		if (blobError && String(url).includes("/blob")) throw new Error("network down");
		const body = String(url).includes("/marker") ? marker : blob;
		return { text: async () => JSON.stringify(body) };
	};
	impl.calls = calls;
	return impl;
}

function bridgeStub({ composeResult = true, throwOnCompose = false } = {}) {
	const composed = [];
	const host = {
		compose(payload) {
			if (throwOnCompose) throw new Error("bridge exploded");
			composed.push(payload);
			return composeResult;
		},
	};
	return { host, composed };
}

describe("actions: createRowActions 流程（注入桩）", () => {
	it("reference：compose 收到 reference 附件（绝对路径），桥缺失安静 no-op", async () => {
		const { host, composed } = bridgeStub();
		const actions = createRowActions({ fetchImpl: fetchStub({ marker: { ok: true, repoRoot: "/repo" } }), getBridge: () => host, getRepoRoot: () => "/repo" });
		const out = await actions.reference("src/app.mjs");
		assert.equal(out.ok, true);
		assert.deepEqual(composed, [{ attachments: [{ path: "/repo/src/app.mjs", name: "app.mjs", mode: "reference" }] }]);

		const ghost = createRowActions({ getBridge: () => null, getRepoRoot: () => "" });
		assert.deepEqual(await ghost.reference("a.mjs"), { ok: false, mode: "reference" });
	});

	it("reference：桥拒收 chip → 降级为纯文本路径（一次调用两个 payload）", async () => {
		const { host, composed } = bridgeStub({ composeResult: false });
		const actions = createRowActions({ fetchImpl: fetchStub(), getBridge: () => host, getRepoRoot: () => "/repo" });
		const out = await actions.reference("src/app.mjs");
		assert.equal(out.ok, false); // 两个通道都拒收
		assert.equal(composed.length, 2);
		assert.deepEqual(composed[0], { attachments: [{ path: "/repo/src/app.mjs", name: "app.mjs", mode: "reference" }] });
		assert.deepEqual(composed[1], { text: "/repo/src/app.mjs" });
	});

	it("attach：全文载荷 → compose 收到 fileData 内联（path 为空、name/size 齐）", async () => {
		const { host, composed } = bridgeStub();
		const fetch = fetchStub({ marker: { ok: true, repoRoot: "/repo" }, blob: blobPayload(["const a = 1;"], { path: "src/app.mjs" }) });
		const actions = createRowActions({ fetchImpl: fetch, getBridge: () => host, getRepoRoot: () => "/repo" });
		const out = await actions.attach("src/app.mjs", "main");
		assert.deepEqual(out, { ok: true, mode: "inline" });
		assert.ok(fetch.calls.some((u) => u.includes("/blob?path=src%2Fapp.mjs&base=main&side=new")));
		assert.equal(composed.length, 1);
		const [payload] = composed;
		assert.equal(payload.attachments.length, 1);
		assert.equal(payload.attachments[0].path, "");
		assert.equal(payload.attachments[0].fileData, "const a = 1;");
		assert.equal(payload.attachments[0].name, "app.mjs");
		assert.equal(payload.attachments[0].size, new TextEncoder().encode("const a = 1;").length);
	});

	it("attach：截断/二进制/错误载荷 → 自动降级 reference（不内联半截文本）", async () => {
		for (const blob of [blobPayload(["a"], { truncated: true }), blobPayload([], { binary: true }), { ok: false, error: "boom" }]) {
			const { host, composed } = bridgeStub();
			const actions = createRowActions({ fetchImpl: fetchStub({ blob }), getBridge: () => host, getRepoRoot: () => "/repo" });
			const out = await actions.attach("src/app.mjs");
			assert.equal(out.mode, "reference");
			assert.equal(out.ok, true);
			assert.equal(composed.length, 1);
			assert.equal(composed[0].attachments[0].mode, "reference");
		}
	});

	it("attach：fetch 抛错 → 降级 reference；compose 拒收内联 → 降级 reference", async () => {
		const { host, composed } = bridgeStub();
		const actions = createRowActions({ fetchImpl: fetchStub({ blobError: true }), getBridge: () => host, getRepoRoot: () => "/repo" });
		assert.deepEqual(await actions.attach("a.mjs"), { ok: true, mode: "reference", reason: "error" });

		const { host: host2, composed: composed2 } = bridgeStub({ composeResult: false });
		const actions2 = createRowActions({ fetchImpl: fetchStub({ blob: blobPayload(["a"]) }), getBridge: () => host2, getRepoRoot: () => "/repo" });
		const out2 = await actions2.attach("a.mjs");
		assert.equal(out2.mode, "reference");
		assert.equal(out2.reason, "compose");
		assert.equal(composed2.length, 3); // inline 拒收 + chip 拒收 + 文本拒收
	});

	it("attach：桥抛错不穿出（安静降级 reference）", async () => {
		const { host } = bridgeStub({ throwOnCompose: true });
		const actions = createRowActions({ fetchImpl: fetchStub({ blob: blobPayload(["a"]) }), getBridge: () => host, getRepoRoot: () => "/repo" });
		const out = await actions.attach("a.mjs");
		assert.equal(out.ok, false);
		assert.equal(out.mode, "reference");
	});

	it("copyPath：仓库根拼接绝对路径进剪贴板；根缺失退相对", async () => {
		const writes = [];
		const clipboard = { writeText: async (t) => (writes.push(t), true) };
		const actions = createRowActions({ getRepoRoot: () => "/repo", clipboard });
		assert.deepEqual(await actions.copyPath("src/app.mjs"), { ok: true, mode: "copy" });
		assert.deepEqual(writes, ["/repo/src/app.mjs"]);

		const actions2 = createRowActions({ getRepoRoot: () => "", clipboard });
		await actions2.copyPath("src/app.mjs");
		assert.deepEqual(writes, ["/repo/src/app.mjs", "src/app.mjs"]);
	});

	it("copyPath：无剪贴板环境 → ok:false 不抛错（store 链的环境守卫语义）", async () => {
		const actions = createRowActions({ getRepoRoot: () => "/repo", clipboard: null });
		const out = await actions.copyPath("a.mjs");
		assert.equal(out.ok, false);
		assert.equal(out.mode, "copy");
	});
});
