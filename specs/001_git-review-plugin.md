# Spec: Diff Review Plugin for pi-web-ui

**Status:** Draft
**Created:** 2026-09-22
**Discovery:** `/home/rpaz/code/pi-web-ui-git/discovery.md`

## Problem Statement

The single pi-web-ui power user runs coding agents inside pi-web-ui and must review the commits those agents produce. The built-in SCM panel (`server/scm.ts`, `web/src/components/SCMPanel.tsx` in the host repo) only shows working-tree state vs HEAD — it cannot answer "which files changed relative to another branch or commit", which is the natural question when reviewing a branch of agent-made commits. Today the user leaves the tool: terminal `git diff` against the merge-base, reading diffs in an editor, then re-typing feedback into chat by hand. Feedback is lossy (no line anchoring), slow, and interrupts the review loop; every round-trip burns time re-describing locations, and agent output ships with weaker human oversight.

The fix is a pi-web-ui plugin ("git-review") that closes the loop in-app: a changed-files navigator in the right panel, a per-file diff in the main area, line-anchored review comments (GitHub style), and a submit action that drafts the assembled review into the chat input via the host `compose()` bridge so the agent can fix and re-commit.

## Requirements

Numbered, independently verifiable claims about the finished plugin.

- **R1.** The plugin is a self-contained pi-web-ui plugin directory (at the root of this repo) with `manifest.json` (`apiVersion: 2`, explicit `permissions`, icon, single `name` string, `description` + `descriptionEn`), a trusted server entry `index.mjs` (`export default { activate(host) }`), and a client bundle `client/entry.mjs` (`export default { mount(el, ctx) }`). **Identity invariant:** the plugin id is the **install directory name** — the host derives it from `readdir(pluginsDir)` (`server/plugins.ts:2311`) and `manifest.id` is informational only — so the installed directory MUST be exactly `git-review`: install by direct copy into `<dataDir>/plugins/git-review/` or via `pi-web-ui install <owner>/<repo> --name git-review` (without `--name` the default repo name would break every hardcoded `git-review` reference: the `/plugins-api/git-review/*` route base, `setView("plugin:git-review")`). It activates without errors and contributes: one `rightpanel.tabs` tab (the review navigator) and one plugin view surface (the diff area, `view: true` default — the synthesized top-bar item is **hidden by default**, reachable via the ⋯ overflow/plugins-menu pin list or `setView` until the user pins it). Both surfaces render placeholder content at this stage.
- **R2.** The plugin's server entry exposes the git data service over `host.route` HTTP endpoints under `/plugins-api/git-review/*`: (a) changed-files-vs-base with per-file status letters (A/M/D/R…), rename old→new, and add/delete line counts; (b) one file's diff parsed into structured hunks/lines with old and new line numbers; (c) branch list (local + remote-tracking); (d) recent commits (for commit-based base picking); (e) review-marker get and set. All git queries run read-only via `execFile("git", …)` against the live host workspace (`host.cwd`), parsed into JSON server-side; the client only renders. Every route returns a pinned field-level JSON shape (Phases 2–4 consume these across separate subagents): `/review` → `{ ok, base: {ref, sha}, head: {sha}, files: [{path, status, oldPath?, add, del, flags}] }` — `head.sha` is required for the template header (R11) and stale-marker detection (R13); `/diff` → structured hunks/lines as described in R8; `/refs` → branch list; `/commits` → recent commits; `/marker` → `{ sha } | null`; `/resolve?ref=` → ref→sha resolution (used by the base picker and the no-marker preselect).
- **R3.** The navigator (right-panel tab) lists every file changed relative to the current review base — computed as `git diff` from merge-base(base, worktree HEAD tree), i.e. committed changes plus uncommitted changes in one unified range. Untracked files (from `git status --porcelain`) are listed and visibly flagged; tracked files with staged or unstaged modifications on top of committed work are visibly flagged; renames display as `old → new`. Files show add/delete counts. Non-repo directories and empty diffs render friendly empty states, not errors.
- **R4.** The plugin persists one review marker per repository root (resolved via `git rev-parse --show-toplevel`, stored as a full commit hash under a key derived from the repo root in `host.storage`, i.e. `<pluginDir>/storage.json`, atomic KV). The review base defaults to this marker whenever it is set and valid. When no marker exists yet, the navigator preselects a best-effort mainline default (first of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` that resolves) as the suggested base; the user can change it before the first submit.
- **R5.** The user can override the review base for a single review by picking a branch (local or remote-tracking) or a recent commit from the navigator's base picker; overriding never moves the stored marker. The active base (marker or override) is always visible in the navigator header.
- **R6.** The navigator supports two independent viewing-mode toggles: (a) tree ↔ flat list; (b) changed-only ↔ full workspace file tree with change badges on changed files (tree built from `git ls-files` plus untracked paths, capped per R16). Mode choices persist across sessions (client-side storage).
- **R7.** Selecting a file in the navigator activates the plugin's main view (`window.__piWebUiHost.setView("plugin:git-review")`) and displays that file's diff. The main view, when opened with no file selected, shows an empty-state hint directing the user to the navigator.
- **R8.** The diff viewer renders the selected file's diff as a **unified** diff: per-row old and new line numbers, hunk headers, and foldable unchanged-line gaps ("⋯ N unchanged lines" expandable). It handles new files (all additions), deleted files (all deletions), renames (anchored to the new path), and binary files (a "binary file changed" placeholder with no line anchoring, file-level comment still available). Oversized diffs are truncated server-side with a visible truncation marker.
- **R9.** The user can attach an editable, removable comment to (a) a selected diff line or contiguous line range (anchored to the new side by default, selectable to the old side for deletions) and (b) any file at file level (covers binary files). Comment drafts live in the client bundle's module-level shared state so they survive tab switches (the host unmounts inactive right-panel tabs); they are not required to survive a full page reload, and no server-side annotation storage exists beyond the drafted message.
- **R10.** The navigator/viewer provides a free-text review summary field included in the assembled review message on submit.
- **R11.** Submitting the review assembles one plain-text message containing: the review range (base → HEAD, noting uncommitted changes), the general summary, and every line-anchored comment with its file path, diff side, and line number/range — and places it into the chat input as a **draft** via `window.__piWebUiHost.compose({ text })`. It never auto-sends. On a successful submit the marker advances to the current HEAD (R4). If `compose()` returns `false` (no composer mounted), the plugin shows a visible fallback (error notice plus copy-to-clipboard of the assembled message) instead of failing silently.
- **R12.** All user-facing strings ship in zh and en; the initial locale is read from `document.documentElement.lang` (the host sets it; `onLocale` is change-only and emits nothing on subscribe), and subsequent changes are followed via `window.__piWebUiHost.onLocale` (host API v8+), matching the host's two-language convention.
- **R13.** Git query robustness: every git invocation carries a timeout and output cap at parity with the host SCM panel (15 s / 16 MB, `server/scm.ts:16`), all HTTP endpoints return structured `{ ok: false, error }` replies on failure (including "not a git repository", unknown/invalid base, and missing marker commit), and the UI renders recoverable error states (e.g. stale marker after a rebase prompts for a manual base) rather than crashing a mount.
- **R14.** Git security guards: server routes accept only whitelisted read-only git subcommands (diff/log/status/ls-files/rev-parse/merge-base/for-each-ref family); every client-supplied ref or path argument is validated (non-empty, no leading `-`, no `--` argument, no control characters or newlines) before being placed into an argv array; git is never invoked through a shell.
- **R15.** Client bundle constraints: bare ESM with no npm imports and no shared React instance (own DOM, host pattern per `docs/architecture-plugins.md`); the server entry uses only Node built-ins (no npm dependencies, no `ensureDeps`); the bundle supports **two concurrent live mounts** (navigator inside the right panel via PluginPage, viewer in the main area via PluginView) by detecting its role from the host-provided container and sharing selection/draft state through module-level state; both mounts clean up correctly on unmount.
- **R16.** Performance guards: the changed-files list and full-tree view cap their rendered entries (with a visible "N more files" notice when truncated; cap ≥ 1000 files) and the per-file diff text is capped server-side (with a visible truncation marker per R8), so a large agent burst cannot freeze the UI.

## Success Criteria

- [ ] With pi-web-ui running and the plugin installed, the right panel shows a "Diff Review" tab listing files changed relative to the current review base — without leaving pi-web-ui.
- [ ] Both viewing-mode toggles work: tree ↔ flat, and changed-only ↔ full tree with change badges.
- [ ] Clicking a file switches the main area to the plugin view and renders its unified diff with old/new line numbers and foldable unchanged gaps.
- [ ] Clicking a diff line (or range) attaches an editable/removable comment; file-level comments are available for every file, including binary ones.
- [ ] Submit places the assembled review (summary + all comments with path, side, line) into the chat input as a draft; nothing is auto-sent; after submit the marker equals HEAD.
- [ ] Starting a second review session defaults the base to "everything since the last submitted review" without manual picking.
- [ ] Manually overriding the base (branch or commit) works for one review and does not move the marker.
- [ ] Uncommitted and untracked changes appear in the list, flagged, and are reviewable.
- [ ] Non-repo and empty-diff states show friendly messages; server routes return structured errors for invalid bases; parser unit tests and a mock-host smoke test pass.

## Scope & Boundaries

**In scope:**
- A new plugin in this repo (`/home/rpaz/code/pi-web-ui-git`): `manifest.json`, `index.mjs` (server), `client/entry.mjs` + helper modules (client), README, and tests.
- Read-only git data service (changed files vs base, per-file structured diff, branches, commits, marker) served over plugin HTTP routes.
- Right-panel navigator (list + modes + base picker + flags), main-area unified diff viewer, line-anchored commenting, review summary, draft submission via `compose()`, per-repo marker persistence and advance-on-submit.
- zh/en localization of all plugin strings.

**Out of scope:**
- Any change to the host application `/home/rpaz/code/pi-web-ui` — the discovery verified the needed host extension points (`rightpanel.tabs`, plugin view tab, `compose()`) exist; the plugin must work against the unmodified host (discovery decision 1 and constraint list).
- Auto-sending the review or any chat delivery beyond the draft injection (discovery decision 5).
- Persistent/structured annotation storage beyond the drafted message (discovery decision 4).
- Agent-side interpretation of the review message, fixing, or re-committing (discovery decision 8 — that is the agent's job via the normal chat loop).
- Side-by-side diff rendering (resolved to unified; see Solution Approach).
- Reviewing repositories other than the active host workspace (`host.cwd`); multi-root workspace review aggregation.
- Writing anything to the reviewed repository (the service is read-only by design, R14).

## Solution Approach

The plugin is a standard two-entry pi-web-ui plugin. The **server entry** (`index.mjs`, trusted full-Node code) owns all git access: it runs `execFile("git", …)` directly — no shell, argv arrays, `core.quotepath=false`, timeout and maxBuffer caps — mirroring the host's own SCM service (`server/scm.ts`), and exposes the parsed results over `host.route` HTTP endpoints (`/plugins-api/git-review/*`), the established plugin channel (notes, image-toolkit). This resolves the discovery's git-data lookup: `host.bash` is unsuitable (it splits the command on whitespace, so paths with spaces break, and caps output at 256 KB — too small for real diffs), and `host.scm` only exposes `status()`/`log()` (`server/plugins.ts:3195`); an upstream host API extension is unnecessary since the trusted entry can run git itself. The permission cost is minimal: `http` for routes plus `ui` for the slot contributions; no `fs`/`tools` families are needed because the git invocation lives in the plugin's own trusted server code.

The review range uses one uniform rule: base is resolved through merge-base semantics (`git merge-base <base> HEAD`, then diff that commit against the **working tree** with rename detection). Diffing against the working tree rather than HEAD folds uncommitted changes into the same range automatically (discovery decision 7), and merge-base gives the GitHub-style "everything since we branched off" view for branch bases while behaving identically to `base..HEAD` when the base is a direct ancestor (the marker case). Untracked files, which `git diff` never lists, come from a parallel `git status --porcelain` query and are merged into the file list with flags.

The **client bundle** renders its own DOM (bare ESM, no npm imports, no shared React). Its single module is mounted in two roles: the right-panel tab mounts it as the **navigator**, the top-bar view tab mounts it as the **diff viewer** (the host keeps the viewer mounted but hidden when inactive — `App.tsx:1888` — so module-level shared state carries the selected file and comment drafts between the two roles and across tab switches). Role detection uses the host's stable container classes (`.plugin-page-host` vs `.plugin-view`). Selecting a file stores it in the shared state, calls `setView("plugin:git-review")`, and the viewer renders the diff fetched from the HTTP service. Comments are plain objects in the shared state keyed by path + side + line; submit renders them through a fixed text template into `window.__piWebUiHost.compose({ text })`, whose merge semantics guarantee the user's existing draft is never overwritten.

The marker is one key per repo root in `host.storage` (`storage.json`, atomic): the server resolves the repo root with `git rev-parse --show-toplevel` at query time, so the marker follows the repository even when the workspace cwd points at a subdirectory. Submit advances it to HEAD; manual base overrides are per-session only.

## Codebase Map

All host-side paths are in `/home/rpaz/code/pi-web-ui` (read-only reference; **never modified by this work**). Plugin-side paths are in this repo (`/home/rpaz/code/pi-web-ui-git`), plugin at repo root.

### Host contracts and patterns (read-only)

| Location | Symbol | Role in this work |
|----------|--------|-------------------|
| `docs/architecture-plugins.md` | — | Plugin model contract: directory layout, manifest fields, permission families, slot framework, host bridge |
| `server/scm.ts:59` | `git(cwd, args, lang?)` | Pattern to mirror for the plugin's own git runner (execFile, `core.quotepath=false`, windowsHide) |
| `server/scm.ts:16-17` | `GIT_TIMEOUT_MS` / `MAX_GIT_OUTPUT` | Timeout (15 s) and output cap (16 MB) values to match (R13) |
| `server/scm.ts:112` | `unquotePath()` | C-style path unquoting for `-z`-less outputs with quoted filenames |
| `server/scm.ts:195` | `parseStatusFiles()` | Porcelain / name-status parsing incl. `old -> new` rename split (R3) |
| `server/scm.ts:210` | `parseBranches()` | `for-each-ref` branch parsing for the base picker (R5) |
| `server/scm.ts:261` | `parseNumStat()` | numstat → `{path: [add, del]}` parsing; binary "-" → 0 (R3) |
| `server/scm.ts:301` | `scmStatus()` | Parallel-query + merge shape to copy for the review snapshot |
| `server/scm.ts:338` | `scmFileDiff()` | Per-file diff flags (`--no-color --no-ext-diff`) |
| `server/scm.ts:390` | `capPatch()` | Server-side patch truncation with visible marker (R8, R16) |
| `server/plugins.ts:269` | `host.broadcast(payload)` | Server → all clients `plugin_data` push (only needed if server push is adopted; HTTP polling is the primary channel) |
| `server/plugins.ts:274` | `host.onMessage(handler)` | `plugin_message` uplink handler (optional; not required by the chosen design) |
| `server/plugins.ts:362` | `host.cwd` getter (+ `server/plugins.ts:2988` impl, `onCwdChange` nearby) | Live workspace the git service queries; re-query trigger on change |
| `server/plugins.ts:392` | `host.storage` (`get/set/delete/all`) | Marker persistence (`storage.json` atomic KV, R4) |
| `server/plugins.ts:491` | `host.scm` type | Proof of the status/log-only limitation that forces the own-execFile path |
| `server/plugins.ts:497` | `host.bash` type | Rejected alternative: whitespace argv split + 256 KB output cap |
| `server/plugins.ts:3195` | `scm` impl in `activate` host object | Gating wording and `{ok:false,error}` shape to match |
| `server/plugins.ts:620` | `PLUGIN_API_VERSION = 2` | Manifest `apiVersion` must equal 2 |
| `web/src/plugin-host.ts:77` | `PLUGIN_HOST_API_VERSION = 11` | Host bridge version the client bundle can feature-detect |
| `web/src/plugin-host.ts:533` | `compose(opts)` | Draft-injection bridge (R11); merge semantics never overwrite existing drafts |
| `web/src/composer-bridge.ts:17` | `ComposerPayload` | `compose()` payload shape: `{ text?, attachments? }` |
| `web/src/ui-slots.ts:1286` | `UiSlotEntry` | Exact shape of the resolved `rightpanel.tabs` entry (id/source/label/kind/order/hidden…) |
| `web/src/components/RightPanel.tsx:871-889` | `pluginTabs` loop | How a `rightpanel.tabs` entry becomes a tab: non-host, non-hidden, non-divider; resolves plugin from `entry.source` (`plugin:<id>`) |
| `web/src/components/RightPanel.tsx:921` | `<SlotTabs …>` | Right-panel tab container invocation (`uiRightPanelTabs` prop, line 110) |
| `web/src/components/SlotTabs.tsx:192` | `active.pluginPage` branch | Only the active tab mounts; switching away unmounts and runs cleanup (drives R9's module-state requirement) |
| `web/src/components/PluginPage.tsx:128` | `m.mount(el, ctx)` | Navigator mount call; container element carries class `plugin-page-host` |
| `web/src/components/PluginView.tsx:26` | `entry.module.mount(el, …)` | Viewer mount call; container element is `<div className="plugin-view">` (line 42) |
| `web/src/App.tsx:1888-1893` | `pluginViews.map` | Viewer stays mounted with `hidden` class when inactive — state survives, mount not re-run |
| `web/src/plugin-loader.ts:21` | `PluginViewContext` | `ctx` shape: `{ pluginId, send(payload), onData(cb) }` |
| `web/src/plugin-loader.ts:287` | `makePluginContext()` | How ctx is assembled per mount |
| `plugins/notes/manifest.json` | — | Manifest reference: `apiVersion: 2`, `permissions`, `iconSvg`, zh/en description, `ui` block shape |
| `plugins/notes/index.mjs:275-293` | `route()` helper | `host.route(method, path, handler)` wiring with try/catch → `{ok:false,error}` — copy this pattern |
| `plugins/notes/client/data.mjs:18-24` | `resolveApiBase()` | Deriving `/plugins-api/<id>` from `import.meta.url` (sub-path-deploy safe) — copy this pattern |
| `plugins/image-toolkit/client/i18n.mjs` | zh/en dictionaries | Reference for self-contained zh/en string tables + `t()` helper (R12) |
| `plugin-sdk/index.mjs:49,189` | `definePlugin()` / `createMockHost()` | Optional dev helper; `createMockHost` enables server-entry smoke tests without the real host |

### Plugin files to create (this repo, `/home/rpaz/code/pi-web-ui-git`)

| Location | Role |
|----------|------|
| `manifest.json` | `apiVersion: 2`, `permissions: ["ui","http"]`, icon/iconSvg, single `name` (zh host convention: "Diff 评审"), `description` + `descriptionEn`, `ui.rightpanel` entry `{ id: "navigator", label: "Diff 评审", labelEn: "Diff Review", icon, kind: "view" }` (kind `view`, not `action` — tab clicks only select, matching the host's own tab entries); `view` left default (true) so the plugin view surface exists |
| `index.mjs` | Server entry: `activate(host)` → route registration (notes `route()` pattern), git invocation + validation guards, marker via `host.storage`, `host.onCwdChange` re-push |
| `client/entry.mjs` | Client entry: role detection (`.plugin-page-host` = navigator, `.plugin-view` = viewer), module-level shared store, mounts `renderNavigator` / `renderViewer`, `cleanup` per mount |
| `client/gitcore.mjs` | Pure, shared server-side logic imported by `index.mjs`: ref/path validation (R14), name-status/numstat/unified-diff parsers (mirror `server/scm.ts` parsers), repo-root/marker key helpers — node-testable without a host |
| `client/i18n.mjs` | zh/en string tables + `t()` + host-locale subscription (image-toolkit pattern) |
| `client/navigator.mjs` | Navigator DOM: file list, tree/flat + changed-only/full toggles, base picker, flags, badges (used by `entry.mjs` navigator role) |
| `client/viewer.mjs` | Diff viewer DOM: unified rows with old/new line numbers, fold gaps, comment affordances (used by `entry.mjs` viewer role) |
| `client/store.mjs` | Module-level shared state: selection, comments, base override, view modes; persistence of view modes to `localStorage` |
| `README.md` | Install (`pi-web-ui install <owner>/<repo>` or copy), usage, message-format contract for the agent |
| `test/*.mjs` | `node:test` unit tests for `gitcore.mjs` parsers + validators; mock-host smoke test running `index.mjs` routes against a temp git repo |

### Load-bearing constraints

- Do **not** modify anything under `/home/rpaz/code/pi-web-ui` — the plugin must run against the unmodified host (discovery decision 1).
- Client bundle: bare ESM, no bare-specifier npm imports (no module resolution in the host loader); server entry: Node built-ins only.
- The right-panel tab unmounts on tab switch (`SlotTabs.tsx:192`) — anything that must survive switches (selection, comments, drafts) lives in module-level state, not mount-local DOM state.
- `compose()` never overwrites an existing draft (host guarantee, `composer-bridge.ts`) — do not attempt to clear or replace user text.

## Open Questions

**[Decision — user]** — both resolved in a post-spec decision interview (no open user decisions remain).
- [x] Plugin display name / icon → **DECIDED**: en "Diff Review", zh "Diff 评审", icon 🔀, id stays `git-review`. The manifest carries a single `name` (the host has no `nameEn`; host convention is zh, so `name: "Diff 评审"`) plus `description`/`descriptionEn`; the bilingual "Diff Review"/"Diff 评审" pair is honored where the slot framework supports it — the `rightpanel.tabs` item's `label`/`labelEn` (verified supported). The top-bar view surface renders the single `manifest.name` in both locales. (Phase 1.)
- [x] Review-message template → **DECIDED: Structured** (numbered comments with explicit side and line range; header with review range; closing instruction baked in). Phase 4 must assemble exactly this shape:

  ```text
  Code review (base <base-name>@<short-hash> → HEAD@<short-hash>,
  N files changed, +A/−D; includes uncommitted changes)
  
  General:
  <summary text>
  
  Comments:
  1. <path>:<line> (new side): <comment>
  2. <path>:<line>-<line> (old side): <comment>
  3. <path> (file-level): <comment>
  
  Please fix the raised comments and re-commit.
  ```

  Notes: the header line is omitted when there are no changes; side defaults to "new side" and may be omitted for new-side comments when unambiguous; file-level entries cover binary files; untracked files are annotated as such. The closing sentence encodes discovery decision 8 (agent fixes raised comments and re-commits).

**[Lookup — implementer]** (resolved during spec exploration; kept for history)
- ~~Git-data path~~ → **resolved**: own `execFile("git")` in trusted `index.mjs` + `host.route` HTTP; `host.bash` rejected (whitespace argv split breaks paths with spaces; 256 KB output cap), `host.scm` rejected (status/log only, `server/plugins.ts:3195`); evidence in Solution Approach.
- ~~`UiSlotEntry` shape / does the diff need a separate main view tab~~ → **resolved**: yes — navigator = `rightpanel.tabs` entry (`web/src/components/RightPanel.tsx:871-889`), diff = the plugin's own top-bar view tab (`view: true`); both mount the same bundle (`PluginPage.tsx:128`, `PluginView.tsx:26`).
- ~~Right-panel tab mounting mechanics~~ → **resolved**: SlotTabs renders `pluginPage` via PluginPage; only the active tab is mounted (`SlotTabs.tsx:192`); role detection via container classes.
- ~~Marker persistence~~ → **resolved**: `host.storage` (`server/plugins.ts:392`), key derived from `git rev-parse --show-toplevel`, value = full commit hash.
- ~~Diff rendering details~~ → **resolved**: unified view, foldable unchanged gaps, rename display, binary placeholder, server-side per-file cap (R8); side-by-side out of scope.
- ~~i18n~~ → **resolved**: zh + en following host locale via `window.__piWebUiHost.onLocale` (R12), image-toolkit-style local dictionaries.

## Risks & Mitigations

| Risk | Likelihood | Mitigation |
|------|------------|------------|
| `git-review` is the first plugin ever to use `rightpanel.tabs` — no in-repo precedent plugin | Medium | Contract verified directly in `RightPanel.tsx:871-889` / `SlotTabs.tsx:192` / `UiSlotEntry` (`ui-slots.ts:1286`); Phase 1 ships a placeholder tab immediately so slot wiring is proven before UI work |
| Marker invalidated by agent rebase/amend (hash vanishes) | Medium | Structured error path (R13) + navigator prompts for manual base; marker only stores hashes and never blocks overriding |
| Large agent bursts produce huge file lists / diffs | Medium | Server-side caps with visible truncation markers (R8, R16); numstat counts always cheap |
| Unified-diff parsing edge cases (quoted paths, mode changes, `\ No newline at end of file`) | Medium | Parser mirrors host-tested `server/scm.ts` conventions; `core.quotepath=false`; unit tests over fixture patches (Phase 1 tests) |
| Two mounts of one bundle (navigator + viewer) interfere or leak listeners | Medium | Role detection + module-store design fixed in Phase 1 skeleton; cleanup symmetry asserted in Phase 3 exit criteria |
| `compose()` unavailable (composer not mounted, e.g. mobile composer hidden) | Low | Explicit `false` handling: notice + copy-to-clipboard fallback (R11) |
| Diff of working tree includes staged+unstaged mixed and cannot separate them | Low | Accepted: review range is "vs base" by design; per-file staged/unstaged **flags** still shown from `git status --porcelain` (R3) |
| npm-free DOM UI is more laborious than a framework | Low | Follow established plugin DOM patterns (`image-toolkit`, `notes`); keep components small and stateless where possible |

## Delivery Plan

### Phase 1: Plugin Skeleton + Git Data Service

- **Goal**: Installing the plugin shows both surfaces (right-panel "Diff Review" tab placeholder + the plugin view placeholder, reachable via the ⋯ overflow/plugins menu, pinning, or `setView` — the synthesized top-bar item is hidden by default), and the HTTP service returns correct changed-files/diff/branch/commit/marker JSON for a real repository.
- **Requirements Covered**: R1, R2, R4, R13, R14
- **Scope**:
  - Create `manifest.json` (contract fields per Codebase Map; `ui.rightpanel` entry; `apiVersion: 2`; `permissions: ["ui","http"]`).
  - Create `client/gitcore.mjs`: ref/path validators (R14), repo-root + marker-key helpers, parsers mirroring `server/scm.ts:195` (`parseStatusFiles` rename split), `server/scm.ts:261` (`parseNumStat`), `server/scm.ts:210` (`parseBranches`), and a unified-diff parser (hunks → `{oldStart,oldLines,newStart,newLines,lines[]}` with old/new line numbers).
  - Create `index.mjs` using the notes `route()` pattern (`plugins/notes/index.mjs:275-293`): routes `GET /review?base=`, `GET /diff?path=&base=`, `GET /refs`, `GET /commits?limit=`, `GET /marker`, `POST /marker`; git runner with `GIT_TIMEOUT_MS`/`MAX_GIT_OUTPUT` parity (`server/scm.ts:16-17`), three-dot merge-base resolution, parallel `git status --porcelain` for untracked/flags, per-file diff cap like `server/scm.ts:390` (`capPatch`); `{ok:false,error}` on every failure path (R13).
  - Create `client/entry.mjs` with role detection and placeholder rendering for both mounts (`PluginPage.tsx:128` / `PluginView.tsx:26` container classes), plus the module-level store skeleton (`client/store.mjs`) that Phases 2–4 build on. Role detection uses the container classes (`.plugin-page-host` = navigator) with **default-else = viewer** — these classes are host-internal rather than documented plugin API, so the dependency is recorded in the README (Phase 4).
  - Create `test/gitcore.test.mjs` (parsers + validators over fixture patches) and `test/server-smoke.test.mjs` (`plugin-sdk/index.mjs:189` `createMockHost`-style host stub + temp git repo → assert route JSON).
  - Out of bounds: no list UI, no diff rendering, no comments, no `compose()` call, no host-repo edits.
- **Entry Conditions**: None (first phase).
- **Exit Criteria / Verifiable Artifacts**: Plugin directory copied into a running pi-web-ui `<dataDir>/plugins/` activates without console errors and shows both placeholder surfaces; `curl /plugins-api/git-review/review?base=<sha>` and `/diff?path=…` (with `Authorization: Bearer $PI_WEB_TOKEN` when that env var is set — the routes sit behind host auth, `server/index.ts:155-158`) against a fixture repo return structured JSON matching the route contract pinned in R2 (statuses, flags, counts, hunks with old/new line numbers, `head.sha`); invalid base / non-repo / oversized-diff cases return `{ok:false,error}`; `node --test test/` passes.
- **Parallelism**: SEQUENTIAL — first phase; everything else builds on the routes, manifest, and client skeleton it establishes.
- **Relative Effort**: M — git plumbing (5 routes, 3+ parsers, guards, marker) plus manifest and skeleton with tests is multi-day work beyond "a day or two".
- **Difficulty**: `standard` — mirrors the host's proven `server/scm.ts` patterns; no concurrency, migration, or auth surface.
- **Open Questions / Blockers**: None identified (base-default mainline rule in R4 is deterministic and needs no decision).

### Phase 2: Right-Panel Review Navigator

- **Goal**: The user sees the changed-file list for the current review base in the right panel, can flip both viewing modes, can pick a different base, and sees uncommitted/untracked flags — with no host left the app.
- **Requirements Covered**: R3, R5, R6, R12, R16
- **Scope**:
  - Create `client/navigator.mjs` (DOM per image-toolkit/notes patterns) and `client/i18n.mjs` (zh/en tables + `t()`; initial locale from `document.documentElement.lang`, changes via `window.__piWebUiHost.onLocale`).
  - Extend `client/store.mjs`: view modes with `localStorage` persistence, current base (marker vs override), file-list state.
  - Extend `client/entry.mjs` navigator role to render `navigator.mjs` against `GET /review`, `/refs`, `/commits`, `/marker`.
  - Implement: file rows (status letter, add/del counts, rename `old → new`, untracked + uncommitted flags), tree/flat toggle (tree built client-side from paths), changed-only/full-tree toggle (full tree from `GET /tree` — add this one small route to `index.mjs` built on `git ls-files` + status untracked, capped), base picker (marker default display, branch/commit override), list cap with "N more files" notice, empty/error states (R13 surfaces).
  - Implement the no-marker preselect rule (R4): with no stored marker, resolve the first resolvable of `origin/HEAD`, `origin/main`, `origin/master`, `main`, `master` via `/resolve` and preselect it as the suggested base; handle the stale-marker case (stored hash no longer resolves) via the structured error path with a prompt to pick a base manually (R13).
  - Out of bounds: no diff rendering (Phase 3), no comments/submit (Phase 4), no marker-advance logic (Phase 4), no host-repo edits.
- **Entry Conditions**: Phase 1 merged — routes `/review`, `/refs`, `/commits`, `/marker` return structured JSON and the client skeleton (role detection, store) exists.
- **Exit Criteria / Verifiable Artifacts**: On a fixture repo the tab lists exactly the files `git diff --name-status <base>` (+ untracked) reports; toggles switch representations and persist across reload; base override changes the list and leaves the stored marker untouched (verifiable via `GET /marker` before/after); zh/en strings both render under host locale switch; >1000-file fixture truncates with a visible notice; non-repo workspace shows the friendly empty state; a stale-marker fixture (marker hash pruned) shows the manual-base prompt instead of crashing.
- **Parallelism**: SEQUENTIAL after Phase 1 (consumes its routes and client skeleton). Also before Phase 3 because the viewer's demo path needs navigator selection.
- **Relative Effort**: M — tree building, two toggle dimensions, base picker over two ref kinds, i18n, and states is a week-shaped slice.
- **Difficulty**: `standard` — CRUD-grade DOM work over a stable data contract.
- **Open Questions / Blockers**: None identified.

### Phase 3: Main-Area Diff Viewer

- **Goal**: Clicking a file in the navigator switches the main area to the plugin view and shows that file's unified diff with line numbers, folds, and correct handling of new/deleted/renamed/binary/huge files.
- **Requirements Covered**: R7, R8, R15
- **Scope**:
  - Create `client/viewer.mjs`: unified rows (old/new gutter numbers, +/-/context coloring), hunk headers, fold gaps ("⋯ N unchanged lines", click to expand), new/deleted/renamed/binary special cases, truncation marker rendering (data already capped server-side).
  - Extend `client/entry.mjs` viewer role to render `viewer.mjs` from the shared store selection; extend navigator file click to set selection + call `window.__piWebUiHost.setView("plugin:git-review")` (bridge contract `web/src/plugin-host.ts:533` area; `setView` at the top of the returned API object).
  - Wire the line-hit model the viewer exposes (row identity = path + side + line, range via shift/second click) — Phase 4 consumes it for anchoring.
  - Out of bounds: no comment UI yet (only selection plumbing), no submit, no navigator changes beyond the click handler, no host-repo edits.
- **Entry Conditions**: Phase 2 merged — navigator renders and its click handler location exists; Phase 1 `/diff` route serves structured hunks.
- **Exit Criteria / Verifiable Artifacts**: Clicking each file kind (modified / new / deleted / renamed / binary / oversized) renders the correct representation; folds expand/collapse; old-side and new-side rows carry correct line numbers matching `git diff` output on the fixture; opening the view tab directly with no selection shows the empty-state hint; with both mounts alive simultaneously (tab open + view active) selection changes reflect in the viewer and neither mount leaks listeners after cleanup (switch tabs back and forth repeatedly without error).
- **Parallelism**: SEQUENTIAL after Phase 2 (demo path runs navigator → viewer through the shared store; both touch `entry.mjs`).
- **Relative Effort**: M — a hand-rolled diff renderer with five special cases and dual-mount verification is a week-shaped slice.
- **Difficulty**: `standard` — rendering + state plumbing over server-parsed data; no algorithmic risk beyond the (already-tested) parser.
- **Open Questions / Blockers**: None identified.

### Phase 4: Line Comments + Review Submit

- **Goal**: The user annotates diff lines, adds a summary, submits, and the complete review lands as a draft in the chat input — after which the next review defaults to "since the last review".
- **Requirements Covered**: R9, R10, R11
- **Scope**:
  - Extend `client/viewer.mjs`: click/range → comment editor inline; file-level comment affordance in the viewer header (works for binary); comment list rendering with edit/delete; per-file comment count badge surfaced in `client/navigator.mjs`.
  - Extend `client/store.mjs`: comment draft persistence in module state (survives right-panel tab switches per `SlotTabs.tsx:192` unmount semantics).
  - Extend `client/entry.mjs` (+ navigator header): summary field, Submit action → assemble message (fixed template: review range header incl. uncommitted note, general summary, per-comment `path · side · line(/range) · text` blocks) → `window.__piWebUiHost.compose({ text })`; on `false` → notice + copy-to-clipboard fallback; on success → `POST /marker` with current HEAD (`GET /review`-resolved) and clear drafts.
  - Extend `index.mjs`: marker route already exists (Phase 1); add HEAD-resolution helper use for the advance call if not already exposed by `/review`.
  - Write `README.md`: install instructions (including the `--name git-review` caveat from R1), usage, the agent-facing message-format contract (the structured template), and the host-internal role-detection dependency note.
  - Out of bounds: no auto-send (never call `startChat`/`prompt`), no server-side comment storage, no host-repo edits.
- **Entry Conditions**: Phase 3 merged — viewer renders diffs with the line-hit model exposed; Phase 1 marker routes live.
- **Exit Criteria / Verifiable Artifacts**: A review written on a fixture repo lands in the pi-web-ui chat input as a draft containing range, summary, and every comment with correct path/side/line (manually verifiable in the running app); pre-existing draft text is preserved (appended, never overwritten); nothing is sent automatically; after submit the marker equals HEAD and a fresh navigator defaults to the post-submit range; `compose()` rejection path shows the fallback; drafted comments survive switching to the Files tab and back.
- **Parallelism**: SEQUENTIAL after Phase 3 (comments anchor to viewer rows and submit needs the full loop).
- **Relative Effort**: M — anchoring UX, draft lifecycle, template assembly, fallbacks, and marker advance together exceed "a day or two".
- **Difficulty**: `standard` — UX assembly over existing plumbing; the only host interaction (`compose`) is a documented one-call bridge.
- **Open Questions / Blockers**: None — template wording is decided (see Open Questions section: all user decisions resolved).

### Parallelism Summary

- Phase 1 → Phase 2 → Phase 3 → Phase 4, strictly sequential: each phase consumes the previous phase's routes/contracts and shares `client/entry.mjs` + `client/store.mjs`, so no two phases can safely edit the same files concurrently. No parallel lanes exist in this delivery.

### Effort Summary

- Phase 1: M · Phase 2: M · Phase 3: M · Phase 4: M — total ≈ 4 weeks (M×4); all phases `standard`.

## Phases (JSON)

```json
{
  "phases": [
    { "phase": 1, "focus": "Plugin skeleton + git data service", "effort": "M", "difficulty": "standard" },
    { "phase": 2, "focus": "Right-panel review navigator", "effort": "M", "difficulty": "standard" },
    { "phase": 3, "focus": "Main-area diff viewer", "effort": "M", "difficulty": "standard" },
    { "phase": 4, "focus": "Line comments + review submit", "effort": "M", "difficulty": "standard" }
  ]
}
```
