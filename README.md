# git-review —— pi-web-ui Diff 评审插件

在 pi-web-ui 里闭环评审 agent 产出的提交：右栏列出「相对评审基线的全部变更」，主区渲染统一 diff，
行级锚定评审评论，提交时把完整评审**作为草稿**放进聊天输入框（绝不自动发送），agent 据此修复并重新提交。

## 安装

**身份不变量（R1）**：插件 id = **安装目录名** —— 宿主从 `readdir(pluginsDir)` 推导（`server/plugins.ts:2311`），
`manifest.id` 只是展示。所以安装目录必须恰好是 `git-review`，否则所有硬编码 `git-review` 引用全断：
`/plugins-api/git-review/*` 路由基、`setView("plugin:git-review")` 主区切换。

- **直接拷贝**：`cp -r` 本目录到 `<dataDir>/plugins/git-review/`（推荐；无歧义）。
- **CLI 安装**：`pi-web-ui install <owner>/<repo> --name git-review`。
  **不带 `--name` 时默认用仓库名**，那会让路由基和 setView 视图 id 全部指向错误 id —— 必须带 `--name git-review`。

激活后贡献两个面（R1）：右栏一个「Diff 评审」tab（导航器）+ 主区插件视图（diff 查看器，合成顶栏项默认隐藏，
可从 ⋯ 溢出菜单 / 插件菜单钉选列表进入）。导航器的文件点击默认走**内嵌面板**（R17，见下）；
全屏插件视图仍是钉选入口 + 内嵌锚找不到时的兑底。

## 使用

1. **看变更**：右栏「Diff 评审」tab 列出相对评审基线（存储的 marker，缺省主线预选）的全部变更 —— 含已提交 +
   未提交 + 未跟踪（各有可见标记），改名显示 `old → new`，可切树形/平铺、仅变更/全树。**全树里未变更的文件也
   可以点击**（R18，降调样式）：打开它的**全文预览**（基线内容，行号与 HEAD 一致），行级/文件级评论照常可写 ——
   给还没改的文件提前留评审意见（如「这个文件拆一下」）。
2. **选基线**：头部「更改」打开基线选择器（本地/远程分支、最近提交、手动输入）；覆盖只影响本次评审，**永不移动存储的 marker**。
3. **读 diff**：点文件 → diff 面板（旧/新双行号、可展开的未变更折叠、新文件/删除/改名/二进制/截断各态）。
   展示形态（R17，内嵌优先）：diff **替换聊天主区的消息列表面板**（`main.main > .messages-wrap` 的内容），
   聊天头部与输入框留在原地 —— 评审时随时能打字；头部「关闭」还原消息面板（选中保留，再点同一文件 =
   原地重开并重拉）。找不到消息面板（宿主结构变了）→ 自动回落旧的 `setView` 全屏切换；全屏插件视图正
   正在展示时点击文件照常内嵌（聊天 pane 切回来，全屏 pane 转隐藏但可从钉选再进）。当前在终端/Git 视图时
   点击文件 → 同样落座到聊天面板并 `setView("chat")` 切回去；工作区切换广播（cwd-changed）会清选中并自动
   收起还原。
4. **写评论**（R9）：
   - 点行（或点第一行再点第二行）选中单行/连续区间 → 行内编辑器；旧行号锚 old 侧（删除行），其余缺省锚 new 侧；
     shift 点击无条件延伸区间。保存 = 草稿入 store；再点同一点 = 收起/取消选中。
   - 头部「评论整个文件」= 文件级评论 —— 对**二进制文件**也可用（二进制没有行锚定，这是唯一的评论方式）。
   - 评论草稿列表（编辑/删除）在 diff 上方；有草稿的行在 gutter 带 ● 标记列。
   - 草稿是插件 bundle 的**模块级状态**：右栏 tab 切走（宿主卸载非活动 tab）后回来原样还在；
     不要求活过整页刷新；服务端不存任何评论（唯一产物就是提交的那条消息）。
5. **写摘要 + 提交**（R10/R11）：导航头部「评审摘要」填整体说明（可选），「提交评审」把范围 + 摘要 + 全部评论
   组装成一条固定模板消息投进聊天输入框草稿。
   - `compose()` 返回 `false`（无输入框挂载）→ 可见错误通知 + 自动复制组装文本到剪贴板（剪贴板也不可用则给
     「手动复制」提示，文本随通知展示）；草稿保留，可稍后重试。
   - 成功 → marker 推进到 HEAD（用 `GET /review` 已解析的 `head.sha` `POST /marker`），草稿清空，基线行随之
     显示推进后的 marker —— 下次评审缺省就是「上次评审之后」的范围。
   - **绝不自动发送**：插件只调用 `window.__piWebUiHost.compose({ text })`（草稿注入），从不碰 `startChat`/`prompt`；
     宿主契约保证草稿**并入**输入框（`composer-bridge.ts` / `composer-draft.ts mergeRecalledDraft`：既有草稿非空时
     = `${既有草稿}\n${新文本}`），用户此前打在输入框里的字一个都不会被覆盖。

## Agent 消息格式契约（R11 固定模板）

提交的消息是**固定英文结构**（agent 契约，不随 UI 语言切换；评论正文是用户原文）。逐字形态：

```text
Code review (base <base-name>@<short-hash> → HEAD@<short-hash>, N files changed, +A/−D; includes uncommitted changes)

General:
<summary text>

Comments:
1. <path>:<line> (new side): <comment>
2. <path>:<line>-<line> (old side): <comment>
3. <path> (file-level): <comment>

Please fix the raised comments and re-commit.
```

省略与注记规则：

- **范围头**在无变更时整个省略；`; includes uncommitted changes` 只在文件带 staged / unstaged / untracked 标记时带上
  （未跟踪也是未提交的工作树差异）；`N/+A/−D` 按载荷 files 求和（载荷截断时是已列文件的和）。
  同理，「includes uncommitted changes」注记也按已列文件的标记判定 —— 极端情形下
  （未提交文件全部排在截断线之后）注记可能省略。
- **General 节**空摘要时省略；**Comments 节**无评论时省略；全空提交被守卫拦下（可见通知，不产生空消息）。
- **评论编号顺序** = 路径字典序 → 文件级在前 → 行号升 → old 在 new 前；与评论列表/提交编号同源，看到的顺序 = 提交后的编号。
- **侧注记**：old 侧一律带 `(old side)`；本构建对 new 侧也一律带 `(new side)`（契约允许「无歧义的新侧省略」，本构建不行使该省略）。
- **未跟踪注记**：未跟踪文件的评论锚为 `<path> [untracked] …`。
- 单条完整示例（两 hunk 修改 + 未跟踪文件，基线 `main`）：

  ```text
  Code review (base main@b123456 → HEAD@c123456, 3 files changed, +4/−2; includes uncommitted changes)

  General:
  Timer logic needs a fix; naming follows repo convention.

  Comments:
  1. src/app.ts (file-level): the module needs a rename
  2. src/app.ts:4 (new side): fix this
  3. src/app.ts:4-11 (new side): explain the range
  4. src/app.ts:11 (old side): this deletion drops the check
  5. untracked.txt [untracked] (file-level): please track this file

  Please fix the raised comments and re-commit.
  ```

Agent 收到后按行号/侧注记定位，修复被指出的评论并重新提交；重新提交后，下次评审缺省从新 HEAD 之后开始。

## 宿主内部依赖注记（非文档化 API）

- **角色检测**：同一 bundle 挂两个角色 —— 宿主容器带 `plugin-page-host` 类（`PluginPage.tsx:128`）= 导航器，
  否则（`plugin-view`，`PluginView.tsx:42`）= 查看器（默认-else）。这两个类是宿主**内部实现细节**而非文档化插件 API
  （spec §193 记录的 Phase 1 决策）；判定收口在 `client/entry.mjs` 的 `detectRole()` —— 宿主改类名时只改这一处。
- **内嵌面板（R17）**：宿主没有「替换主区局部」的插件 API，内嵌形态是客户端 DOM 集成，依赖三处宿主内部细节：
  聊天主区结构类名 `main.main` + `.messages-wrap`（宿主 ChatMain）、面板可见性开关 `view-pane` 的 `hidden` 类、
  聊天视图 id `"chat"`（`setView` 目标）、模态容器类 `plugin-modal-body`（模态形态点文件先关弹窗）。
  全部收口在 `client/inline.mjs`（`defaultLocate` / `INLINE_CSS` / `HOST_MODAL_BODY_CLASS` 三处）——
  宿主改结构时只改这三个地方。集成方式：给 `.messages-wrap`
  挂 `data-gr-inline` 属性（配套样式隐藏其直接子元素，消息列表/回到底部/排队栏让位）并追加 `.gr-inline-host`
  容器装 viewer；只动 React 不管理的属性/追加子节点，对话切换（`.messages-wrap` 按 conversationId 重挂）由
  MutationObserver 驱动 `sync()` 重新落座。内嵌锚定位失败时自动回落 `setView` 全屏（文件点击永不死路）。
- **草稿并入语义**：`compose({text})` 只投文本、绝不读改既有草稿（宿主 `composer-bridge.ts` 全有或全无拒收；
  `composer-draft.ts mergeRecalledDraft` 并入）。
- 其余桥触点都是文档化宿主 API：`setView`（R7）、`onLocale`（R12，change-only）、`onData` 广播（cwd 变化重拉）。
- **插件 reload 的 ESM 缓存边界（实测踩过）**：宿主的 `plugins_reload` 以 `index.mjs?e=<epoch>` 重新 import ——
  查询串只击穿**入口文件本身**的缓存；它的静态相对 import（`./client/gitcore.mjs`）解析回同一无查询 URL，
  永远命中宿主进程首次激活缓存的旧实例。因此：新增 gitcore 导出再让 index.mjs import 它们 → reload 后
  activate 直接失败（缺导出）、全部路由 404。对策（已实施）：只被服务端消费的逻辑放 `index.mjs`（如 R18 的
  `looksBinary` / `previewHunks`），gitcore 只保留客户端也消费的解析器/常量 —— 这样 index.mjs 的 import 面对旧
  缓存实例永远成立，reload 即可生效。若确需改 gitcore 里共享的既有函数，需要**整体重启宿主进程**。

## 开发

无 npm 依赖、无构建步骤：服务端 `index.mjs` 只用 Node 内建（只读 git 经 `execFile`，超时/输出上限与宿主 SCM
面板对齐），客户端是裸 ESM（`client/*.mjs`，`textContent`-only DOM，无 npm import、无共享 React）。

```sh
node --test test/     # 全部套件（gitcore 解析器 / server-smoke 真仓库路由含 /blob 与 index.mjs 纯函数 / tree-route / navigator / viewer / inline / comments）
node --check <file>   # 逐文件语法
```

测试不依赖宿主：`test/fake-env.mjs` 提供极小假 DOM + localStorage 桩 + 宿主桥 spy；`test/server-smoke.test.mjs`
用 mock 宿主 + 真实临时 git 仓库端到端跑全部路由。
