# Discovery — pi-web-ui Git Review Plugin

> Output of a problem-discovery interview (interviewer skill, pi-spec-pipeline).
> Everything below reflects statements and decisions made by the product owner
> during the interview; codebase facts were verified against `~/code/pi-web-ui`.

## Problem statement

The user runs coding agents inside pi-web-ui and must review the work those
agents commit. Today that review happens blind: pi-web-ui's built-in SCM panel
(`server/scm.ts`, `web/src/components/SCMPanel.tsx`) only shows working-tree
state vs HEAD (staged/unstaged diffs, status, history graph). It has no way to
ask "which files changed relative to another branch or commit" — the natural
question when reviewing a branch of agent-made commits — and no way to see what
changed in those files in a review-oriented view.

The user's workaround today is leaving the tool: terminal `git diff` against
the merge-base, reading diffs in an editor, then re-typing feedback into the
chat by hand. Feedback is lossy (no line anchoring), slow, and interrupts the
review loop. Cost of inaction: agent output keeps shipping with weaker human
oversight, and every review round-trip burns time re-describing locations.

## Who hits it, when

The single pi-web-ui power user, every time an agent finishes a burst of
committed work (roughly per work session). The trigger is always "the agent
says it's done — now I check what it actually did."

## Desired review loop (end to end)

1. See the **list of files changed** relative to a base — usually "everything
   since we branched off main", or "the commits the agent made since the
   previous review".
2. Select a file and see **what changed in it** (the diff).
3. The cherry on top: write **line-anchored comments** directly on the diff,
   plus a **general review message**, GitHub-review style.
4. **Submit** the review as a chat message the agent interprets; the agent is
   expected to **fix the raised comments and re-commit**.

## Decisions recorded during the interview

1. **Changed-files list location** — the right panel's file area (annotated
   `.panel-body` in `RightPanel.tsx`), shown like a code editor's
   source-control view. Verified: the right panel's tab bar accepts
   plugin-contributed tabs via the `rightpanel.tabs` slot, so this needs no
   host changes.
2. **Viewing modes for the list** — two toggles:
   - tree ↔ flat list;
   - changed-only ↔ full tree with change badges on changed files.
3. **Diff surface** — selecting a file opens its diff in the **main area**
   (VS Code style: right panel = navigator, main area = the diff). Verified:
   the plugin's own view tab owns the main area when active; the built-in SCM
   panel renders diffs as plain `<pre>` text and is not the target surface.
4. **Comments** — per-line, anchored to diff lines (GitHub style), plus a
   general summary on submit; assembled into a single chat message the agent
   interprets. No structured annotation storage beyond the drafted message.
5. **Submit flow** — the assembled review is placed into the chat input as a
   **draft** (host `compose()` bridge, verified to exist in
   `web/src/plugin-host.ts`); the user eyeballs/edits it and sends it
   themselves. Not auto-sent.
6. **Review base** — an **automatic marker per repo**: after a review is
   submitted, the marker advances to HEAD, so the next review defaults to
   "everything since the last review". The user can always **override** the
   base manually (pick a branch or commit) for a particular review.
7. **Uncommitted changes** — included in the review range (marker…HEAD plus
   working-tree changes, flagged in the file list). Nothing the agent did
   escapes review.
8. **Expected agent behavior after submit** — fix the raised comments and
   re-commit (that is the agent's job via the normal chat loop; the plugin
   only delivers the message).

## Success criteria

Without leaving pi-web-ui, the user can: see the changed-file list for the
current review base, switch list viewing modes, open a per-file diff, annotate
diff lines, add a review summary, and submit — landing as a draft in the chat
input. A second review session defaults to "changes since the last submitted
review" without manual picking.

## Prior attempts

None inside pi-web-ui; the workaround is manual terminal/editor review (see
problem statement). The built-in SCM panel was checked and does not cover this.

## Constraints and verified platform facts (for the implementer)

- Plugin model: `<dataDir>/plugins/<id>/` with `manifest.json`, optional
  trusted server `index.mjs` (`activate(host)`), optional client
  `client/entry.mjs` (`mount(el, ctx)`). Docs: `docs/architecture-plugins.md`.
- Client bundles are bare ESM: **no npm imports, no shared React instance**
  with the host — the diff UI renders its own DOM.
- Capability families gate host APIs (`fs`, `ui`, `tools`, `http`, …); strict
  mode = declared `permissions` or `apiVersion >= 2`.
- `host.scm` exposes only `status()` and `log()` — insufficient for
  diff-vs-arbitrary-base; the plugin needs another path to git data
  (implementer lookup: `host.bash` vs server-side `execFile` in the trusted
  `index.mjs`, or an upstream host API extension).
- `window.__piWebUiHost.compose({ text })` drafts into the chat input
  (verified; merge semantics never overwrite existing drafts).
- Repo facts: built-in SCM data lives in `server/scm.ts` (parsers for
  porcelain/numstat, 15s timeout, 16MB cap); `RightPanel.tsx` hosts the
  `rightpanel.tabs` slot; plugin distribution is `pi-web-ui install
  <owner>/<repo>/<subdir>` or direct copy into `<dataDir>/plugins/`.

## Open questions

### Lookups for the implementer (NOT user decisions)

- Resolve the git-data path (see constraint above) and its permission family.
- Exact `UiSlotEntry` shape for a `rightpanel.tabs` entry and whether the
  plugin needs a visible main view tab for the diff area to mount
  (`web/src/ui-slots.ts`, `RightPanel.tsx`, an existing plugin as reference).
- How a right-panel tab mounts plugin client UI vs the plugin's own view
  (`PluginView` vs slot framework mechanics).
- Persistence of the review marker per repo (`storage.json` keyed by repo
  root) and its UI.
- Diff rendering details: unified vs side-by-side, hunk folding, handling
  renames/binary files, large-file caps (SCM caps output at 16MB; a sane
  per-file cap is an implementer call).
- i18n: whether to follow the host's zh/en pattern (host `pick()`-style) or
  ship a single language.

### Decisions still needed from the user

- None blocking the spec. Naming, icon, and small UX polish can be settled
  during spec/implementation review.
