# MiMoCode Dynamic Workflows Reference

Dynamic workflows let you orchestrate many subagents **deterministically** from a small JavaScript script — fan-out, pipelines, nested workflows — instead of driving each subagent by hand. The script runs in a sandbox; you call `agent()` to spawn work and combine results with plain JS.

## Where to write workflow files

Save a workflow as a `.js` file in either directory (searched nearest-first, walking up from cwd to the worktree root; project overrides parent):

```
.mimocode/workflows/<name>.js      # preferred
.claude/workflows/<name>.js        # also read
```

The file name (minus `.js`) is **not** the workflow's identity — the `meta.name` inside is. Names must match `[A-Za-z0-9._-]+`.

## Required script shape

Every workflow **must begin** with a `meta` export (a pure data literal — it is parsed, not executed):

```js
export const meta = {
  name: "triage-issues",              // required, non-empty
  description: "Triage open issues",   // required, non-empty
  whenToUse: "when the backlog needs sorting",  // optional
  phases: [{ title: "Fetch" }, { title: "Classify" }],  // optional
  model: "standard",                   // optional default model for agents
}

export default async function () {
  // ... orchestration ...
  return result   // becomes the workflow's result
}
```

Only `name` and `description` are required. The body is ordinary async JS with the sandbox globals below.

## In-script API (sandbox globals)

| Global | Signature | Returns |
|--------|-----------|---------|
| `agent(prompt, opts?)` | spawn one subagent | Promise → its deliverable (text, or a validated object if `opts.schema`), or **`null`** on failure. Never throws. |
| `parallel(thunks)` | run an array of `() => Promise` concurrently | `Promise<any[]>` (a throwing thunk rejects the batch) |
| `pipeline(items, ...stages)` | run each item through sequential stages, items in parallel | `Promise<any[]>` |
| `workflow(nameOrScript, args?, opts?)` | run a child workflow as its own sub-run and await it | Promise → child result, or `null` on runtime failure |
| `readFile(path)` | read a workspace file | `Promise<string \| null>` (null if absent) |
| `writeFile(path, content)` | write a workspace file (auto-creates dirs) | `Promise<void>` |
| `glob(pattern)` | list matching workspace paths (relative, sorted) | `Promise<string[]>` |
| `exists(path)` | whether a workspace path exists | `Promise<boolean>` |
| `phase(title)` | mark a progress phase | — |
| `log(message)` | emit a progress line | — |
| `args` | the JSON value passed when the workflow started | (value) |

File primitives are **jailed to the workspace root** (the worktree by default, or the `workspace` you pass at run). `..`/absolute escapes throw. Use `glob()` to enumerate work units — don't spawn an agent just to list files.

### `agent()` options

```js
const out = await agent("Summarize src/parser.ts", {
  agentType: "explore",      // subagent type; default "general"
  model: "lite",             // provider/model literal OR a group/tier name
  tools: ["read", "grep"],   // tool allowlist; omit to inherit
  schema: { type: "object", properties: { bug: { type: "string" } }, required: ["bug"] },
  isolation: "worktree",     // run in a fresh isolated worktree
  label: "parser-scan",      // observability tag
  timeoutMs: 120000,         // per-call timeout; on timeout resolves null
})
```

With `schema`, the deliverable is a **validated object** (never prose). Without it, you get the agent's final text.

## Determinism constraints

The sandbox removes non-deterministic APIs so a run can be replayed/resumed identically: no `Date`, `crypto`, `fetch`, timers, or `process`; `Math.random` is a seeded PRNG. Do network/time-dependent work **inside** `agent()` (a real subagent), not in the orchestration script.

## Running a workflow

Use the `workflow` tool (or ask the agent to run one):

| Operation | Purpose |
|-----------|---------|
| `run` | Start and block until terminal; provide `name` (a saved/built-in workflow) **or** `script` (inline JS). Optional `args`, `workspace`, `async`. |
| `status` | Snapshot a run by `run_id` without blocking |
| `wait` | Block on a run's result (optional `timeout_ms`) |
| `cancel` | Best-effort cancel a running workflow |
| `resume` | Re-launch a persisted run under the same `run_id` (journal replay makes it convergent) |

- `async: false` (default) streams the transcript inline and returns the result.
- `async: true` returns a `run_id` immediately; the result arrives as an inbox notification.
- Provide **either** `name` **or** `script`, never both.

### Built-in workflows

Runnable by `name` without writing a file:

- **`compose`** — full spec→ship pipeline (brainstorm → design → implement (TDD) → verify → review → merge). Pass `args.task`. Auto-parallelizes independent subtasks into per-task worktrees and chains each phase's structured output to the next. Re-running on existing docs reuses them and scopes the fan-out to the actual diff (incremental amend).
- **`deep-research`** — comprehensive research report generator (brief → plan → parallel sub-agent research → reflect gap-check → single-writer cited Markdown report → cold review). Pass `args: { dir, question, today, depth?, context? }`. Convergent: file checkpoints enable resume after interruption.
- **`fact-check`** — adversarial fact verification (plan → parallel web search → source extraction → group duplicates → 3-juror crosscheck → structured JSON findings). Pass the question as `args`. Best for verifying specific claims.

### `compose` workflow vs `compose` agent

Both drive the same spec→ship lifecycle, but choose by task shape:

- **`compose` workflow** (this, deterministic code) — best when requirements are **well-defined** and the task **decomposes into independent subtasks**. It fans out to parallel worktrees and runs **non-interactively to completion** — fire-and-forget.
- **`compose` agent** (conversational, switch with `Tab`) — best for **exploratory or ambiguous** work where you want to redirect mid-flow, answer questions, or inject judgment between steps.

## Semantics worth knowing

- **Failed `agent()` resolves to `null`, never throws** — check for null; a hung agent is cancelled and also yields `null` so it can't stall a `parallel`/`pipeline` barrier.
- **Failed child `workflow()` resolves to `null`** for runtime failures, but **structural faults throw** and propagate up the whole tree: cycle detected (a saved name calling itself), nesting past `maxDepth`, or an unknown workflow name.
- **Concurrency** is one process-wide semaphore sized by `workflow.maxConcurrentAgents`; a per-run value can only narrow it. Excess `agent()` calls queue automatically.
- **Communicate between workflows by dataflow** — return a value from a child and pass it as `args` to the next, or write a shared file with `writeFile` and read it later. Workflows don't message each other directly.

## Watching a run (TUI)

A running workflow shows a bounded inline panel (capped to ~12 lines) with live spinner, phase, and status counters. After a workflow tool message, the `view workflow agents` keybind opens the full-screen workflow page — message-style cards per agent, colored status counters, and drill-down into each subagent's (and nested workflow's) full conversation, with scroll position preserved across navigation.

## Config knobs (`workflow.*`)

| Key | Default | Purpose |
|-----|---------|---------|
| `maxConcurrentAgents` | `min(16, 2×cores)` | Process-wide ceiling on concurrent subagents across all runs (incl. nested). No upper clamp — set deliberately. |
| `maxDepth` | `8` | Max `workflow()`-calls-`workflow()` nesting; exceeding fails the run |
| `maxLifecycleAgents` | `1000` | Hard ceiling on total agents one run spawns over its life; over-cap `agent()` → `null` |
| `scriptDeadlineMs` | `43200000` (12h) | Wall-clock budget for the whole script; enforced as a hard kill |
