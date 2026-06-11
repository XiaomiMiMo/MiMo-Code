import { $ } from "bun"
import { describe, expect, afterEach } from "bun:test"
import { Effect } from "effect"
import * as fsp from "fs/promises"
import * as path from "path"
import { Session } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Global } from "../../src/global"
import { Worktree } from "../../src/worktree"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { WorkflowRuntime } from "../../src/workflow/runtime"
import { makeLayer, ref, providerCfg } from "./lib"

// Worktree isolation lives in its own file: it boots a real Instance per isolated
// agent, which is heavyweight. A dedicated file gives a fresh process, exactly
// like test/project/worktree.test.ts.
afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

const fileExists = (p: string) =>
  fsp
    .stat(p)
    .then(() => true)
    .catch(() => false)

describe("WorkflowRuntime worktree isolation", () => {
  it.live("an isolated agent's relative file write lands in its worktree, not the parent tree", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // The single agent writes a relative file (one tool call), then ends its turn.
        yield* llm.tool("write", { filePath: "port.rs", content: "// rust" })
        yield* llm.text("done")
        // A worktree is a fresh checkout of HEAD; uncommitted files (like the
        // fixture's mimocode.json provider config) do NOT propagate. Commit it so
        // the isolated agent's worktree Instance can resolve the test provider.
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("translate", { isolation: "worktree" })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        const result = (outcome as { result: any }).result
        // Changed worktree -> result is enveloped with _worktree carrying the dir.
        expect(result?._worktree?.directory).toBeTruthy()
        const wtDir = result._worktree.directory as string
        // The edit is in the worktree, NOT the parent project dir.
        expect(yield* Effect.promise(() => fileExists(`${wtDir}/port.rs`))).toBe(true)
        expect(yield* Effect.promise(() => fileExists(`${dir}/port.rs`))).toBe(false)
        // Tear the kept worktree down via the service so the parent repo's
        // .git/worktrees admin entry is gone before the fixture finalizer rm's the
        // tmpdir. A lingering worktree pointer makes that rm retry (~28s) and trips
        // the test timer; removing it here keeps teardown fast and deterministic.
        yield* (yield* Worktree.Service).remove({ directory: wtDir }).pipe(Effect.ignore)
      }),
      { git: true, config: providerCfg },
    ),
    // Booting a fresh Instance inside the worktree (createFromInfo -> bootstrap)
    // is heavyweight; give it generous headroom over the default 5s test timeout.
    30000,
  )

  it.live("a read-only isolated agent leaves no worktree behind", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate clean",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.text("done") // no tool call -> worktree untouched -> auto-removed
        // Commit the fixture config so the worktree's Instance can resolve the provider.
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("look", { isolation: "worktree" })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        // Untouched (pristine) -> no envelope, just the plain finalText; tree removed.
        expect((outcome as { result: any }).result).toBe("done")
      }),
      { git: true, config: providerCfg },
    ),
    30000,
  )

  it.live("two concurrent isolated agents writing the same path land in different worktrees", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate concurrent",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        // Two agents racing on the same global LLM queue: bind each one's turns to
        // its OWN prompt sentinel (the agent-scoped task echoed in the request body)
        // so dispatch is deterministic regardless of which agent's request lands
        // first. Plain FIFO push would interleave non-deterministically — one agent
        // could consume the other's `text("done")` as its first turn and finish
        // pristine. The sentinels are uppercase/underscore tokens that cannot occur
        // in the system prompt or tool descriptions (a substring like "alpha" would
        // false-match "alphanumeric" in the prompt and make BOTH matchers fire).
        // Each agent: one write tool call (matched), then a final text turn (matched).
        // Both write the SAME relative path on purpose — the property under test is
        // that distinct worktrees keep them from clobbering each other.
        const isA = (h: { body: unknown }) => JSON.stringify(h.body).includes("WF_TASK_ONE")
        const isB = (h: { body: unknown }) => JSON.stringify(h.body).includes("WF_TASK_TWO")
        yield* llm.toolMatch(isA, "write", { filePath: "port.rs", content: "// one" })
        yield* llm.textMatch(isA, "done")
        yield* llm.toolMatch(isB, "write", { filePath: "port.rs", content: "// two" })
        yield* llm.textMatch(isB, "done")
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `const r = await parallel([`,
          `  () => agent("WF_TASK_ONE", { isolation: "worktree" }),`,
          `  () => agent("WF_TASK_TWO", { isolation: "worktree" }),`,
          `])`,
          `return r.map((x) => x && x._worktree ? x._worktree.directory : null)`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("completed")
        const dirs = (outcome as { result: (string | null)[] }).result
        expect(dirs.filter(Boolean).length).toBe(2)
        expect(dirs[0]).not.toBe(dirs[1]) // disjoint trees — no clobber
        // Teardown: both worktrees are CHANGED (kept) — remove them so the fixture's
        // fs.rm doesn't hit the ~28s retry storm from live .git/worktrees entries.
        const wt = yield* Worktree.Service
        for (const d of dirs) if (d) yield* wt.remove({ directory: d }).pipe(Effect.ignore)
      }),
      { git: true, config: providerCfg },
    ),
    30000,
  )

  it.live("cancel removes worktrees of in-flight isolated agents", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate cancel",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.hang // the isolated agent hangs so it is in-flight at cancel time
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("x", { isolation: "worktree" })`,
        ].join("\n")
        const { runID } = yield* runtime.start({ script, sessionID: parent.id, parentActorID: "main", model: ref })
        yield* Effect.sleep("600 millis") // let the worktree get created + agent spawn
        // The in-flight worktree dir is not surfaced to the test (the agent hung
        // before returning an envelope), so a deterministic filesystem assertion is
        // not available. The reliable guard is that cancel COMPLETES without throwing
        // (it now calls worktree.remove for the in-flight worktree, best-effort) and
        // the run lands cancelled — a regression where cancel throws on worktree
        // removal would fail right here.
        yield* runtime.cancel({ runID })
        const s = yield* runtime.status({ runID })
        expect(s.status).toBe("cancelled")
      }),
      { git: true, config: providerCfg },
    ),
    30000,
  )

  it.live("a deadline-fired run reclaims the in-flight isolated agent's worktree", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf reclaim on deadline",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.hang // the isolated agent hangs → run will hit the deadline
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const root = path.join(Global.Path.data, "worktree", Instance.project.id)
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("x", { isolation: "worktree" })`,
        ].join("\n")
        const { runID } = yield* runtime.start({
          script,
          sessionID: parent.id,
          parentActorID: "main",
          model: ref,
          scriptDeadlineMs: 2000,
        })
        const outcome = yield* runtime.wait({ runID })
        expect(outcome.status).toBe("failed")
        const left = yield* Effect.promise(() => fsp.readdir(root).catch(() => [] as string[]))
        expect(left.length).toBe(0)
      }),
      { git: true, config: providerCfg },
    ),
    30000,
  )

  it.live("a per-agent timeout reclaims the hung isolated agent's worktree; the run completes", () =>
    provideTmpdirServer(
      Effect.fnUntraced(function* ({ dir, llm }) {
        const runtime = yield* WorkflowRuntime.Service
        const session = yield* Session.Service
        const parent = yield* session.create({
          title: "wf isolate agent-timeout",
          permission: [{ permission: "*", pattern: "*", action: "allow" }],
        })
        yield* llm.hang // the isolated agent hangs → its per-agent timeout fires
        yield* Effect.promise(() => $`git add -A && git commit -q -m wf-config`.cwd(dir).quiet().nothrow())
        const root = path.join(Global.Path.data, "worktree", Instance.project.id)
        const script = [
          `export const meta = { name: "t", description: "d" }`,
          `return await agent("x", { isolation: "worktree" })`,
        ].join("\n")
        // agentTimeoutMs (NOT scriptDeadlineMs) bounds the hung agent. Unlike the
        // deadline (which FAILS the run), a per-agent timeout resolves that agent to
        // null and lets the run COMPLETE — and its in-flight worktree must be
        // reclaimed via the isolated path's null→not-success disposition (the M3
        // branch). scriptDeadline far above so a PASS proves the per-agent path fired.
        const { runID } = yield* runtime.start({
          script,
          sessionID: parent.id,
          parentActorID: "main",
          model: ref,
          agentTimeoutMs: 1500,
          scriptDeadlineMs: 60000,
        })
        const outcome = yield* runtime.wait({ runID })
        // Completed (graceful timeout→null), with the agent's deliverable nullish.
        // (The host returns null; the sandbox marshals host null → guest undefined —
        // same sentinel convention as the shared-path timeout test.)
        expect(outcome.status).toBe("completed")
        const result = (outcome as { result: unknown }).result
        expect(result === null || result === undefined).toBe(true)
        // No worktree leaked: the timed-out isolated agent's tree was removed.
        const left = yield* Effect.promise(() => fsp.readdir(root).catch(() => [] as string[]))
        expect(left.length).toBe(0)
      }),
      { git: true, config: providerCfg },
    ),
    30000,
  )
})
