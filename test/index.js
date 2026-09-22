/**
 * 测试目录入口 —— 让 `node --test test/` 在把目录当单个测试入口spawn 的 Node
 * 构建上（实测 v22.23：`node …/test` 作为子进程入口，按 CJS 目录解析找 index.js）
 * 也能跑全部用例。其余 Node 上 --test 会自己发现 *.test.mjs，本文件只是多一层。
 *
 * CJS（无 package.json 时 .js 即 CJS）+ 动态 import —— ESM 测试文件原样加载，
 * node:test 的注册与退出码语义不变。
 */
(async () => {
	await import("./gitcore.test.mjs");
	await import("./server-smoke.test.mjs");
	await import("./tree-route.test.mjs");
	await import("./navigator.test.mjs");
})().catch((err) => {
	console.error(err);
	process.exitCode = 1;
});
