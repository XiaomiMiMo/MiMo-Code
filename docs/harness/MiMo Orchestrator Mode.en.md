# MiMo Orchestrator Mode

**In one line**: a "coordinator" primary mode — manage all your tasks from a **single window, single session, in pure natural language**: it delegates work to child sessions and handles coordination, integration, and reporting, so you never have to switch back and forth between multiple windows/sessions (experimental, off by default).

## 1. Background & Goals

When you push several pieces of work forward at once, the usual approach is to open several terminal windows, run a coding session in each, and then constantly switch between them: watching which one finished, which is blocked waiting for approval, which needs the next instruction. The real burden is not machine compute — it's **your attention and energy**: context ping-pongs between windows and you get worn down by "multiplexing" yourself.

That is exactly what Orchestrator mode solves: **let you manage all your tasks from one window, one session, in pure natural language**. You hand the goal to the Orchestrator in natural language, and it splits the work up, dispatches it, watches progress, comes back to you when it needs a decision, and summarizes when done — you stay in the same conversation the whole time, never jumping between windows.

To do this, the Orchestrator plays a "**leader / manager**" role:

- it **decomposes** your goal into deliverable units of work,
- **dispatches a child session** for each unit (running in its own mode, model, task panel, and memory),
- then **coordinates, integrates (git merge), and reports**.

The normal coding modes (build / plan / compose) are "executors": one session in one directory, reading/writing code and running commands itself — to advance several things in parallel you'd open several windows. The Orchestrator is the "manager": the parallel child sessions run in the background while what you face is always **this one** coordination session.

**Core boundary**: the Orchestrator does **no substantive work itself** — no writing code, no concrete implementation planning, no quality review. Those are all delegated: a unit that needs planning goes to `plan` (or `compose`, whose workflow has plan/review phases built in); code goes to `build`. "Decomposing into dispatchable units" is its job; "how a given unit is implemented" and "reviewing the result" are jobs it delegates.

**Off by default**: the whole capability is gated behind a single flag `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR` (see §6). When off, MiMoCode behaves exactly as before — no Orchestrator mode, no `session` tool, no approval routing, no workspace switching.

## 2. Overall Model

```
user goal
   │  decomposition
   ▼
Orchestrator session (globally unique, see §5)
   │  session create ──► child A (build,  dir=repo1, --isolate)  ┐
   │  session create ──► child B (plan,   dir=repo2)             │  parallel, in background
   │  session create ──► child C (compose,dir=repo1, --isolate)  ┘
   │
   │  child finishes → actor_notification back to inbox → wakes the Orchestrator
   ▼
coordinate / integrate (git merge each child's mimocode/* branch) / report to user
```

- Each child is an **independent session** (its own session id, task panel, memory), running in the **background** with `mode: "peer"`.
- The Orchestrator **returns immediately** after dispatching and does not poll; a child **actively wakes** it via an inbox notification when it finishes.
- A child is a peer, not an in-session subagent — you can **fully attach** into any child session to view/take over, just like `mimo -c <id>`.

## 3. The `session` Tool (the Orchestrator's core capability)

Only Orchestrator mode can see and call the `session` tool (gated by agent name + by the flag). It offers both JSON and shell call forms (the exact syntax is given by the tool description). Eight verbs in total:

| verb | purpose | key params |
|---|---|---|
| `create` | dispatch a new child session in the background | `task` (first-turn task, required); optional `mode` (build\|plan\|compose, default build), `model`, `title`, `dir` (the directory the child runs in — any project/path, defaults to the Orchestrator's own), `isolate` (run in a dedicated git worktree of `dir` to avoid concurrent-write conflicts) |
| `switch` | move the frontend panel to a session | `sessionID` (resolve natural language to an id via `list` first, then switch) |
| `list` | list this Orchestrator's child sessions (id / title / mode / status) | — |
| `cancel` | stop a child that is no longer needed; if it was `--isolate`d, also remove its worktree and branch | `sessionID` |
| `ask` | ask a session one **read-only, one-shot** side question (answered from a frozen snapshot of its history, without interrupting its run) | `session_id` + `question` |
| `setmode` | change the mode a child runs under for its **subsequent turns** (e.g. a plan child, once done planning, switches to build to execute in the **same session**, no new session needed) | `sessionID` + `mode` (build\|plan\|compose) |
| `approve` | approve a child's **currently pending** permission request (see §4) | `sessionID` |
| `grant-approval` | pre-authorize: auto-approve future permission requests (no prompt each time) | `target` (a child's sessionID, or `all` for every child) |

Implementation: `packages/opencode/src/tool/session.ts` (verb list `KNOWN_VERBS`).

### 3.1 Directory & isolation (`--dir` / `--isolate`)

The Orchestrator is a **general** coordinator that can work across different projects, so each child's directory and isolation are **decided per task**, not assumed from the current project:

- `dir` — the directory the child runs in. Point it at the project/subproject/scratch dir the task belongs to; omit to use the Orchestrator's own directory.
- `isolate` — when on, the child runs in **its own git worktree** of `dir`'s repo (branch `mimocode/<task>`), so multiple children editing the same repo don't collide with each other or with the Orchestrator. Use it for "will edit files, possibly concurrently"; leave it off for read-only/single-writer work, or a non-git dir (which degrades to running directly in `dir`).

The worktree is created/removed in `dir`'s own repo Instance (cross-project correct); a child worktree lives at `<data>/worktree/<projID>/<task-slug>`, on branch `mimocode/<task-slug>`.

### 3.2 Integration & cleanup

- An isolated child's commits live on its own `mimocode/<...>` branch. The Orchestrator integrates them itself with git (it has `bash`): `git log <branch>` / `git diff <base>...<branch>` / `git merge-tree` to preview conflicts → `git merge <branch>` (or cherry-pick). Find a child's branch via `git worktree list` / `git branch --list 'mimocode/*'`.
- **Only `cancel` an isolated child after its work is merged, or the task is abandoned** — `cancel` deletes the worktree and branch, so doing it on **unmerged** work permanently loses that work. Don't `cancel` a child just because it "finished" (finishing produces commits on its branch that still need merging).

### 3.3 Lifecycle (no-poll / interrupt / resume)

- **No polling**: `create` returns immediately, the child runs in the background, and a message into the inbox wakes the Orchestrator when it's done. After dispatching, return / answer the user / end the turn — don't loop on `list`/status and burn turns.
- **Interrupt**: interrupting the Orchestrator does **not** stop its children — they keep running in the background and notify on completion. To stop a specific child, use `session cancel <id>`. When the whole session exits, all children exit with it.
- **Resume all**: `session list` enumerates children; for any child whose last outcome wasn't success (cancelled/failed/never reported) or that still has open tasks, forward it a message via the `actor` send action to continue. There's no separate resume command — drive resume with list + relay.

## 4. Child-session permission-approval routing

**Problem**: a background child has no interactive panel facing the user directly. By default a background session that hits a permission gate requiring an `ask` (e.g. accessing a directory outside its workspace, reading `.env`) is **denied outright** (`interactive:false` → `DeniedError`) — the user never sees it and cannot approve it.

An Orchestrator child does have a path to a human — its parent session and the user viewing the TUI. So for an **Orchestrator peer child**, a permission `ask` is **forwarded for approval** instead of silently denied:

- **Decision**: `decideAskRouting` (`src/agent/config.ts`) splits three ways: system agents (checkpoint-writer/dream/distill) → still auto-deny; **Orchestrator peer** (background + `mode:peer` + has a parent) → forward for approval; other background (compose subagents, etc.) → still auto-deny.
- **Who approves**: a forwarded request can be resolved by (a) the **user directly** (switch into the child, use the normal per-session permission UI), or (b) the **Orchestrator on your behalf** — when it holds a matching delegation grant.
- **Delegation grants**:
  - `session grant-approval <childSessionID>` — pre-authorize a given child's future asks to pass automatically;
  - `session grant-approval all` — pre-authorize **all** of this Orchestrator's children;
  - `session approve <childSessionID>` — one-shot approve the child's currently pending request.
- **Dedup**: there is only one copy of each permission request. Both the direct-user path (`Permission.reply`) and the Orchestrator path (`session approve`) converge on the same Deferred; the second is an idempotent no-op. Once either side approves, the Orchestrator's forwarded copy is dropped — no double handling, no stale request.
- **Never hangs**: a forwarded ask that no one answers is **auto-denied** after `FORWARD_DENY_TIMEOUT_MS` (5 minutes, `src/permission/index.ts`), preserving the "never hang" guarantee of the original auto-deny; abortSignal can still cancel it anytime.
- **Notifications**: recording a forwarded request **wakes the Orchestrator** (inbox note with the child id and how to approve) and pops a toast for the user; a child's **completion** also toasts the user (not just the Orchestrator).

## 5. The globally-unique Orchestrator workspace

Orchestrator mode uses a **fixed global working directory** (`<data>/orchestrator`, via `orchestratorDir()` in `src/global/index.ts`):

- No matter which directory you launch MiMoCode from, **switching into Orchestrator mode** switches the TUI's working directory to this global directory and lands on the **single** root Orchestrator session there (find-or-create).
- So it's always the same Orchestrator session regardless of where you launched — previously-created child sessions are always visible and reachable. Otherwise, launching from different directories would give different Orchestrator sessions, and you couldn't find the children you created before.

The switch reuses the worktree dialog's sequence: `instance.dispose → switchDirectory → sync.bootstrap →` find/create the root session and navigate. The server's cwd-containment check allows this app-owned global directory (only when the feature is enabled).

## 6. Flag, off by default

A single flag gates the whole capability, **off by default**, explicit opt-in:

```
MIMOCODE_EXPERIMENTAL_ORCHESTRATOR: MIMOCODE_EXPERIMENTAL || truthy("MIMOCODE_EXPERIMENTAL_ORCHESTRATOR")
```

- Default **OFF**; set `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` to enable (the umbrella `MIMOCODE_EXPERIMENTAL=1` enables it too).
- **Two load-bearing gates** make the feature fully disappear when off:
  1. **Agent registration** (`src/agent/agent.ts`) — the orchestrator agent is registered only when the flag is on, via a conditional spread (matching how `max` mode is done). When off it's not in the agent set, so it doesn't appear in the TUI mode-cycle (Tab), the agent dialog, or `defaultAgent`, and no peer can be dispatched.
  2. **Tool registration** (`src/tool/registry.ts`) — the `session` tool is registered only when the flag is on. When off, no agent can get it.
- **Defense in depth** (dead code once off, but explicit): the TUI's enter-Orchestrator dir-switch effect early-returns when off; the server middleware's global-dir exception applies only when on; `decideAskRouting` given `orchestratorEnabled:false` falls back to auto-deny for peers.

The flag is evaluated once at import (reads `process.env`). Tests set it to `true` early in `test/preload.ts` (the Orchestrator suites exercise the feature).

## 7. Quick start

1. Enable the feature: `MIMOCODE_EXPERIMENTAL_ORCHESTRATOR=true` (or `MIMOCODE_EXPERIMENTAL=1`).
2. Launch MiMoCode and press **Tab** to cycle to **Orchestrator** mode — the working directory switches automatically to the global Orchestrator workspace and lands on the single Orchestrator session.
3. Give it work, e.g.: *"Create a build-mode child to add a login page to repo1, dir set to /path/to/repo1, with isolate on; and a compose child to design the billing schema in repo2."*
4. Use `/sessions` (or have the Orchestrator `session list`) to see the `↳`-labeled children; select one to fully attach in to view/take over, and return with the session-parent keybind.
5. A child's completion wakes the Orchestrator and toasts you; operations needing approval are forwarded to you (or auto-approved per your `grant-approval`).
6. When satisfied, have the Orchestrator merge/integrate each isolated child's `mimocode/*` branch.

## 8. Related source

| Concern | Location |
|---|---|
| Orchestrator agent definition + flag gate | `packages/opencode/src/agent/agent.ts` |
| Orchestrator system prompt (delegator identity) | `packages/opencode/src/session/prompt/orchestrator.txt` |
| `session` tool (8 verbs) | `packages/opencode/src/tool/session.ts` |
| Tool registration + flag gate | `packages/opencode/src/tool/registry.ts` |
| Permission approval-routing decision | `packages/opencode/src/agent/config.ts` (`decideAskRouting`) |
| Forward/grant ref + dedup | `packages/opencode/src/permission/permission-forward-ref.ts`, `src/permission/index.ts` |
| Global Orchestrator workspace | `packages/opencode/src/global/index.ts` (`orchestratorDir`), `src/cli/cmd/tui/app.tsx` |
| flag definition | `packages/opencode/src/flag/flag.ts` (`MIMOCODE_EXPERIMENTAL_ORCHESTRATOR`) |
