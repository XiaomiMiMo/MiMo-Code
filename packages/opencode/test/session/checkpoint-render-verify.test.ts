// Live verification scratch — prints a fully-populated rebuild context for
// human inspection. Not a CI-required test (tagged "verify" so it can be
// skipped); kept under test/ so it shares the existing fixture infra.
//
// Run with: bun test test/session/checkpoint-render-verify.test.ts
import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import * as fs from "fs/promises"
import path from "path"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Memory } from "../../src/memory"
import { Session } from "../../src/session"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { TaskRegistry } from "../../src/task/registry"
import { ActorRegistry } from "../../src/actor/registry"
import { Instance } from "../../src/project/instance"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    Bus.defaultLayer,
    Config.defaultLayer,
    Memory.defaultLayer,
    Session.defaultLayer,
    TaskRegistry.defaultLayer,
    ActorRegistry.defaultLayer,
    SessionCheckpoint.defaultLayer,
  ),
)

describe("v5 verify (visual)", () => {
  it.live("prints fully populated rebuild context and on-disk tree", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const reg = yield* TaskRegistry.Service
        const actorReg = yield* ActorRegistry.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "v3 visual verify" })

        // Top-level tasks + sub-tasks
        const t1 = yield* reg.create({ session_id: sess.id, summary: "Implement memory v3" })
        const t2 = yield* reg.create({
          session_id: sess.id,
          parent_id: t1.id,
          summary: "Phase 4 wiring",
        })
        const t3 = yield* reg.create({
          session_id: sess.id,
          parent_id: t1.id,
          summary: "Phase 5 verification",
        })
        const t4 = yield* reg.create({
          session_id: sess.id,
          summary: "Unrelated user request",
        })

        // Background subagent actor under the parent session, mirroring v6
        // model-spawned subagents: shared sessionID, actor_id = "<type>-<n>".
        yield* actorReg.register({
          sessionID: sess.id,
          actorID: "explorer-1",
          mode: "subagent",
          agent: "explorer",
          description: "explore memory layout",
          contextMode: "none",
          background: true,
          lifecycle: "ephemeral",
        })
        yield* actorReg.updateStatus(sess.id, "explorer-1", { status: "running" })

        // Seed v5 single-file checkpoint artifacts on disk. Focus is on t2
        // (started last), so seed progress.md under t2's task dir.
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)
        const taskDir = path.join(root, "sessions", sess.id, "tasks", t2.id)
        const projDir = path.join(root, "projects", Instance.project.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.mkdir(taskDir, { recursive: true })
          await fs.mkdir(projDir, { recursive: true })

          await fs.writeFile(
            path.join(projDir, "MEMORY.md"),
            `# Project memory
Updated: 2026-05-15T10:00:00Z (ckpt #1)

## User preferences
- Always use Bun, never npm
- Prefer functional style with type guards

## User constraints
- Don't touch packages/migration

## Project context emphasized by user
- Memory v5 hard cutover, no v4 fallback
`,
          )

          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: Memory v5 phase 4 wiring complete

### Execution context
- Skill: superpowers:executing-plans, phase 5 of 6
- Identifier: phase-5-live-verification
- Position: running synthetic checks

### Live resources

**Computation**
- Subagent ids: act_42 agent=explorer status=running — exploring memory layout

**External connections / locks**
(none)

**Temporary artifacts**
- Git worktree: /root/projects/.vibe-board-workspaces/b88f-memory branch=vb/b88f-memory

### Session metadata
Branch: vb/b88f-memory; uncommitted: 0

### Discovered

- Drizzle's sqliteTable accepts no-arg column constructors when field name matches
  Why: removes redundant column-name strings
  How to apply: use \`text().notNull()\` not \`text("col_name").notNull()\`
- TaskRegistry auto-clears focus on done; assigns sensible parent/sibling
- ActorRegistry.complete calls completion hook before status update

### Dead ends

- Tried storing checkpoint index alongside session.json → ambiguous ownership
  → moved to <data>/memory/sessions/<sid>/_meta.json
`,
          )
          await fs.writeFile(
            path.join(taskDir, "progress.md"),
            `## ckpt #1 — 2026-05-15T10:00:00Z

Phase 1-4 complete: SQL schemas, registries wired, checkpoint orchestrator
updated to dispatch the writer subagent.

Next: implement renderRebuildContext 9-section render in src/session/checkpoint.ts
`,
          )
        })

        // Render rebuild context.
        const out = yield* cp.renderRebuildContext(sess.id)

        // Visual dump.
        console.log("\n=========== ON-DISK LAYOUT ===========")
        const tree = async (dir: string, prefix = ""): Promise<void> => {
          const entries = await fs.readdir(dir, { withFileTypes: true }).catch(() => [])
          entries.sort((a, b) => a.name.localeCompare(b.name))
          for (const e of entries) {
            const full = path.join(dir, e.name)
            if (e.isDirectory()) {
              console.log(prefix + "[" + e.name + "/]")
              await tree(full, prefix + "  ")
            } else {
              const stat = await fs.stat(full)
              console.log(prefix + e.name + "  (" + stat.size + "B)")
            }
          }
        }
        yield* Effect.promise(() => tree(root))

        console.log("\n=========== REBUILD CONTEXT ===========")
        console.log(out)

        console.log("\n=========== MEMORY.SEARCH('Bun') ===========")
        const hits = yield* memory.search({ query: "Bun" })
        console.log(JSON.stringify(hits, null, 2))

        console.log("\n=========== MEMORY.SEARCH('focus') ===========")
        const hits2 = yield* memory.search({ query: "focus" })
        console.log(JSON.stringify(hits2, null, 2))

        // Sanity assertions on render.
        expect(out).not.toContain("<system-reminder>")
        expect(out).toContain("## Project memory")
        expect(out).toContain("Always use Bun")
        expect(out).toContain("Tasks ledger")
        expect(out).toContain(t1.id)
        expect(out).toContain(t2.id)
        expect(out).toContain(t4.id)
        expect(out).toContain("## Session checkpoint")
        expect(out).toContain("Active actors")
        expect(out).toContain("agent=explorer")
        expect(out).toContain("Drizzle's sqliteTable")
      }),
    ),
  )

  it.live("renderRebuildContext appends seam framing", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "seam framing test" })

        // Seed at least one checkpoint artifact so renderRebuildContext has
        // content to emit before the framing.
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: Seam framing fixture\n\n### Execution context\n- minimal seed\n`,
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id)

        expect(out).toContain("preserved verbatim below")
        expect(out).toContain("Pick up the last task as if the break never happened")
        expect(out).toContain("Resume directly")
      }),
    ),
  )

  it.live("renderRebuildContext appends autonomous addendum when lastMessageInfo is assistant/tool-calls", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "autonomous addendum tool-calls" })

        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: Autonomous addendum fixture\n\n### Execution context\n- minimal seed\n`,
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "assistant", finish: "tool-calls" } })

        expect(out).toContain("autonomous task")
        expect(out).toContain("Continue your work loop")
      }),
    ),
  )

  it.live("renderRebuildContext omits autonomous addendum when lastMessageInfo is assistant/stop", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "autonomous addendum stop" })

        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: Autonomous addendum fixture\n\n### Execution context\n- minimal seed\n`,
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id, { lastMessageInfo: { role: "assistant", finish: "stop" } })

        expect(out).not.toContain("autonomous task")
      }),
    ),
  )

  it.live("renderRebuildContext omits autonomous addendum when opts undefined", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "autonomous addendum undefined" })

        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: Autonomous addendum fixture\n\n### Execution context\n- minimal seed\n`,
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id)

        expect(out).not.toContain("autonomous task")
      }),
    ),
  )

  it.live("rebuild context does NOT contain Active recall protocol (F4b)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "f4b sess" })

        // Seed a checkpoint so renderRebuildContext produces non-empty output;
        // otherwise it bails early and the assertion is vacuously true. With
        // content present, the buggy state would emit the wrapping
        // <system-reminder> block; F4b removes it.
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)
        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await fs.writeFile(
            path.join(sessDir, "checkpoint.md"),
            `Topic: F4b removal fixture\n\n### Execution context\n- minimal seed\n`,
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id)

        expect(out.length).toBeGreaterThan(0)
        expect(out).not.toContain("Active recall protocol")
        expect(out).not.toContain("Facts below come from session memory")
      }),
    ),
  )

  it.live("rebuild context emits F17 'already loaded' header", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "f17 sess" })

        // Seed minimal checkpoint so renderRebuildContext doesn't early-bail.
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)
        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await Bun.write(
            path.join(sessDir, "checkpoint.md"),
            "# Session checkpoint\n\n## §1 Active intent\n\ntest seeded\n",
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id)

        expect(out).toContain("auto-loaded from your session memory")
        expect(out).toContain("Use Grep for specific facts")
      }),
    ),
  )

  it.live("rebuild context loads notes.md when non-empty (F14)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "f14 notes sess" })
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await Bun.write(path.join(sessDir, "checkpoint.md"), "# Session checkpoint\n\nseeded\n")
          await Bun.write(
            path.join(sessDir, "notes.md"),
            "# Session notes\n\n## [turn 5 · 2026-01-01T00:00:00Z]\n\nDecided to use approach X for testing recall.\n",
          )
        })

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).toContain("## Session notes")
        expect(out).toContain("Decided to use approach X")
      }),
    ),
  )

  it.live("rebuild context skips notes.md block when missing or empty (F14)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const memory = yield* Memory.Service

        const sess = yield* session.create({ title: "f14 nonotes sess" })
        const root = yield* memory.root()
        const sessDir = path.join(root, "sessions", sess.id)

        yield* Effect.promise(async () => {
          await fs.mkdir(sessDir, { recursive: true })
          await Bun.write(path.join(sessDir, "checkpoint.md"), "# Session checkpoint\n\nseeded\n")
          // No notes.md
        })

        const out = yield* cp.renderRebuildContext(sess.id)
        expect(out).not.toContain("## Session notes")
      }),
    ),
  )

  // F25b/F31: integration test for §4 dual-source HARD CONSTRAINT.
  //
  // Skipped: the writer-spawn end-to-end pipeline requires the full Actor layer
  // (Actor → SessionPrompt → ToolRegistry + ~20 transitive deps; see
  // `test/actor/spawn.test.ts:116-183` for the construction shape). The current
  // file's test layer only mounts SessionCheckpoint.defaultLayer + immediate
  // deps; without Actor.layer wired in, `spawnRef.current` is undefined and
  // `tryStartCheckpointWriter` short-circuits to "skipped" before any writer
  // fires. Wiring up the full Actor stack here would also pull in TestLLMServer
  // + scripted-response harness for every writer LLM round-trip (multiple
  // `task list` reads, template `Read`s, three `Write`s for checkpoint.md /
  // memory.md / notes.md, then `stop`) — brittle plumbing that the v8.3 plan
  // explicitly flags as the reason this test was deferred from v8.1 Task 4.
  //
  // The HARD CONSTRAINT it would validate (writer §4 must reflect only DB-truthy
  // task IDs) is currently covered behaviorally by the harness validation in
  // F30: post-run `grep -E "T[0-9]+ \(T[0-9]+\.[0-9]+\)|T[0-9]+\.[0-9]+ \(T[0-9]+\)" checkpoint.md`
  // is required to return zero hits across long-running runs. That catches
  // dual-naming regressions; F31's purpose is to make the same regression
  // catchable in a fast unit cycle.
  //
  // To unskip, the work plan is:
  //   1. Build a fixture layer that mounts Actor.layer + TestLLMServer in a
  //      shape compatible with this file's existing layer composition.
  //   2. Use `provideTmpdirServer` (not `provideTmpdirInstance`) so the
  //      TestLLMServer URL is wired into the config provider.
  //   3. Pre-seed `llm.tool("task", { action: "list", ... })` responses with the
  //      writer's expected sequence: one `task list` returning [T1,T2,T3], a
  //      few `read` results for templates, three `write` actions, then `stop`.
  //   4. Spawn the writer via `cp.tryStartCheckpointWriter(...)` and await
  //      `cp.waitForWriter(sess.id) === "success"`.
  //   5. Read `checkpoint.md` and assert §4 contains T1/T2/T3 but not T7/T99.
  //
  // Skeleton preserved below for reference; flip to `it.live` once the layer
  // wiring lands.
  it.live.skip("writer §4 contains only DB-truthy task IDs (F25b/F31)", () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const cp = yield* SessionCheckpoint.Service
        const session = yield* Session.Service
        const tasks = yield* TaskRegistry.Service

        const sess = yield* session.create({ title: "F25b dual-source test" })

        // Seed task DB with three rows. IDs are auto-allocated as T1/T2/T3.
        const t1 = yield* tasks.create({ session_id: sess.id, summary: "Implement parser" })
        const t2 = yield* tasks.create({ session_id: sess.id, summary: "Add lexer tests" })
        const t3 = yield* tasks.create({ session_id: sess.id, summary: "Wire CLI flags" })
        yield* tasks.done({ session_id: sess.id, id: t1.id })
        yield* tasks.done({ session_id: sess.id, id: t2.id })

        // TODO(F31): trigger writer fire here once Actor layer is wired in.
        //   const outcome = yield* cp.tryStartCheckpointWriter({
        //     sessionID: sess.id,
        //     model: { providerID: "test", modelID: "test-model" },
        //     promptOps: {} as ActorPromptOps,
        //   })
        //   expect(outcome).toBe("started")
        //   const settled = yield* cp.waitForWriter(sess.id)
        //   expect(settled).toBe("success")

        // Read checkpoint.md and extract §4.
        const cpPath = checkpointPath(sess.id)
        const content = yield* Effect.promise(() => Bun.file(cpPath).text().catch(() => ""))
        const sec4 = content.match(/## §4 [^]+?(?=\n## §5)/)?.[0] ?? ""

        // Positive control: seeded IDs must appear.
        expect(sec4).toContain(t1.id)
        expect(sec4).toContain(t2.id)
        expect(sec4).toContain(t3.id)

        // Negative control: arbitrary unseeded IDs must NOT appear.
        expect(sec4).not.toContain("T7")
        expect(sec4).not.toContain("T99")

        // Mark unused refs as intentionally referenced for the skeleton above.
        void cp
      }),
    ),
  )
})
