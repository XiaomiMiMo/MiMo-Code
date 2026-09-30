import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Stream } from "effect"
import * as fs from "fs/promises"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Plugin, HookEvent } from "../../src/plugin"
import { Bus } from "../../src/bus"
import { Log } from "../../src/util"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Actor } from "../../src/actor/spawn"
import { Session } from "../../src/session"
import { checkpointPath, metaDir } from "../../src/session/checkpoint-paths"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"
import * as CheckpointContext from "../../src/session/checkpoint-context"
import { SessionCheckpoint } from "../../src/session/checkpoint"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("CheckpointSplitoverPlugin (integration)", () => {
  test("triggerActorPreStop(checkpoint-writer) on over-budget file → continue=true with EXTRACTION reason", async () => {
    await using tmp = await tmpdir({})

    const sessionID = ("s_" + Math.random().toString(36).slice(2, 10)) as SessionID

    // Write an over-budget checkpoint.md before invoking the plugin. metaDir()
    // resolves under XDG_DATA_HOME (set per-PID by test/preload.ts), so the
    // file lives in the same data root the plugin will read from inside
    // Instance.provide.
    await fs.mkdir(metaDir(sessionID), { recursive: true })
    await fs.writeFile(checkpointPath(sessionID), "## §1 Active intent\n" + "x ".repeat(3000) + "\n")
    // memory.md intentionally absent: missing memory file produces no violation
    // (validateMemory is gated on expectedRevisions.length > 0), so the only
    // signal in this test is the over-budget checkpoint.

    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID,
            actorID: "act_int_test",
            agentType: "checkpoint-writer",
            mode: "subagent",
            lifecycle: "ephemeral",
            task: "checkpoint",
            iteration: 0,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(result.continue).toBe(true)
    expect(result.reason).toBeDefined()
    expect(result.reason!).toContain("EXTRACTION REQUIRED")
    // "CheckpointSplitoverPlugin" tracks the function's .name — applyPlugin
    // records pluginName via plugin.name (src/plugin/index.ts). Rewriting the
    // export as a const arrow would change .name and break this assertion.
    expect(result.contributingPluginNames).toContain("CheckpointSplitoverPlugin")
    expect(result.contributingHookIDs.some((id) => id.endsWith("#actor.preStop"))).toBe(true)
  })
})

describe("CheckpointSplitoverPlugin spawn-loop integration", () => {
  test("over-budget file → splitover hook drives writer through one ReAct repair turn → success", async () => {
    // End-to-end test of the spawn.ts ReAct loop wiring for the splitover
    // plugin. Asserts that the hook's {continue: true, reason} actually drives
    // the checkpoint-writer through iteration 0 → iteration 1 via MAX_PRE_REACT,
    // not just that triggerActorPreStop returns the right shape (covered above).
    //
    // Flow:
    //   1. Create session inside Instance.provide, pre-write over-budget
    //      checkpoint.md at the session's path (extract-required violation).
    //   2. Spawn checkpoint-writer actor with scripted LLM (two text turns).
    //   3. Turn 0 runs; preStop hook reads over-budget file → continue=true.
    //   4. Bus subscriber catches ReActReentered → overwrites file with clean
    //      v5 skeleton. (This stands in for what a real writer turn would do
    //      via tool calls — the scripted LLM can't drive write tool calls
    //      without far more complexity, and this design still proves the
    //      contract: hook fires → reentry happens → next iteration sees
    //      corrected state → hook returns continue=false → delivery.)
    //   5. Turn 1 runs; preStop hook reads clean file → continue=false.
    //   6. Outcome: success, two captures, exactly one ReActReentered.
    const server = startScriptedLLMServer([
      { lines: textStopResponse("first writer turn (over-budget)") },
      { lines: textStopResponse("repair turn (clean)") },
    ])

    const OVERSIZED = "## §1 Active intent\n" + "x ".repeat(3000) + "\n"
    const CLEAN = `Topic: clean repair output

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)

### Discovered
(none)

### Dead ends
(none)
`

    let sessionIDForCleanup: SessionID | undefined
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            `${dir}/mimocode.json`,
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                "checkpoint-writer": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const { outcome, reenteredEvents } = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const reenteredEvents: Array<{
                phase: string
                triggeredByPlugins: string[]
                iteration: number
              }> = []

              const sessions = yield* Session.Service
              const sess = yield* sessions.create({ title: "splitover spawn-loop" })
              sessionIDForCleanup = sess.id

              // Pre-write the over-budget checkpoint at this session's path.
              // The hook reads from metaDir(sessionID)/checkpoint.md — the
              // same path that runValidatorsForCkpt resolves inside the
              // splitover plugin.
              yield* Effect.promise(async () => {
                await fs.mkdir(metaDir(sess.id), { recursive: true })
                await fs.writeFile(checkpointPath(sess.id), OVERSIZED)
              })

              // Subscribe to ReActReentered. On the first re-entry event,
              // overwrite checkpoint.md with a clean v5 skeleton so the next
              // preStop pass sees no violations and returns continue=false.
              yield* bus.subscribe(HookEvent.ReActReentered).pipe(
                Stream.runForEach((p) =>
                  Effect.gen(function* () {
                    reenteredEvents.push({
                      phase: p.properties.phase,
                      triggeredByPlugins: p.properties.triggeredByPlugins,
                      iteration: p.properties.iteration,
                    })
                    // Overwrite with clean content. The next preStop tick
                    // reads from disk, finds no violations, returns
                    // continue=false → break out of the loop.
                    yield* Effect.promise(() => fs.writeFile(checkpointPath(sess.id), CLEAN))
                  }),
                ),
                Effect.forkScoped,
              )

              const actor = yield* Actor.Service
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "checkpoint-writer",
                task: "produce a checkpoint",
                context: "none",
                tools: [],
                background: false,
              })
              const out = yield* Deferred.await(result.outcome)
              // Allow the subscriber fork to drain any tail events.
              yield* Effect.sleep("50 millis")
              return { outcome: out, reenteredEvents }
            }).pipe(Effect.scoped),
          ),
      })

      if (outcome.status === "failure") throw new Error(`Actor failed: ${outcome.error}`)
      if (outcome.status === "cancelled") throw new Error("Actor was cancelled")

      // Exactly two LLM calls — proves the ReAct loop ran one repair turn,
      // not zero (no reentry) and not three (cap).
      expect(server.captures.length).toBe(2)

      // At least one ReActReentered fired in the pre phase, attributed to
      // CheckpointSplitoverPlugin. The subscriber's callback overwrote the
      // file → second preStop saw clean content → no further re-entries.
      const preEvents = reenteredEvents.filter((e) => e.phase === "pre")
      expect(preEvents.length).toBe(1)
      expect(preEvents[0].triggeredByPlugins).toContain("CheckpointSplitoverPlugin")
      expect(preEvents[0].iteration).toBe(1)
    } finally {
      await server.stop()
      // Best-effort cleanup of pre-written metaDir (Instance.disposeAll
      // doesn't touch the data root).
      if (sessionIDForCleanup) {
        await fs.rm(metaDir(sessionIDForCleanup), { recursive: true, force: true }).catch(() => {})
      }
    }
  })
})

describe("CheckpointContext producer (tryStartCheckpointWriter)", () => {
  test("populates context before spawn and cleans up via Effect.ensuring after settle", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("turn 0 output (writer ran)") },
    ])

    let sessionIDForCleanup: SessionID | undefined
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            `${dir}/mimocode.json`,
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                },
              },
              agent: {
                "checkpoint-writer": { model: "alibaba/qwen-plus" },
              },
            }),
          )
        },
      })

      // Reset CheckpointContext so leftover entries from earlier tests in
      // the same process don't pollute the size assertion.
      CheckpointContext._reset()

      const beforeSize = CheckpointContext._size()
      expect(beforeSize).toBe(0)

      const result = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const sess = yield* sessions.create({ title: "ctx producer test" })
              sessionIDForCleanup = sess.id

              // tryStartCheckpointWriter early-skips on empty sessions, so
              // seed a single user message + text part to get past that gate.
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: sess.id,
                agent: "build",
                model: {
                  providerID: ProviderID.make("alibaba"),
                  modelID: ModelID.make("qwen-plus"),
                },
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: sess.id,
                type: "text",
                text: "seed",
              })

              // Seed a prior checkpoint so loadPriorDiscoveredTitles
              // returns a non-empty Set we can later observe.
              yield* Effect.promise(async () => {
                await fs.mkdir(metaDir(sess.id), { recursive: true })
                await fs.writeFile(
                  checkpointPath(sess.id),
                  `Topic: prior

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)

### Discovered
- PriorTopicForLearningDedup
  Why: ensures priorTitles is non-empty
  How to apply: do nothing

### Dead ends
(none)
`,
                )
              })

              const svc = yield* SessionCheckpoint.Service
              const status = yield* svc.tryStartCheckpointWriter({
                sessionID: sess.id,
                model: { providerID: "alibaba", modelID: "qwen-plus" },
                promptOps: {} as never,
              })
              // During execution, _size must reflect that set ran.
              const midSize = CheckpointContext._size()
              yield* svc.waitForWriter(sess.id)
              // waitForWriter and the forked settle watcher (which owns the
              // Effect.ensuring cleanup) both race on the same outcome
              // Deferred. The watcher's `ensuring` may not have fired by the
              // time waitForWriter returns — poll briefly until _size drops
              // to 0, capped so a real leak still fails the test.
              const afterSize = yield* Effect.gen(function* () {
                for (let i = 0; i < 50; i++) {
                  const s = CheckpointContext._size()
                  if (s === 0) return s
                  yield* Effect.sleep("20 millis")
                }
                return CheckpointContext._size()
              })
              return { status, midSize, afterSize }
            }).pipe(Effect.scoped),
          ),
      })

      expect(result.status).toBe("started")
      // During the writer's lifetime, the context entry exists.
      expect(result.midSize).toBeGreaterThanOrEqual(1)
      // After settle, ensuring ran → no leak.
      expect(result.afterSize).toBe(0)
    } finally {
      await server.stop()
      if (sessionIDForCleanup) {
        await fs.rm(metaDir(sessionIDForCleanup), { recursive: true, force: true }).catch(() => {})
      }
    }
  })
})

describe("parentSessionID end-to-end (Axis A wiring)", () => {
  test("clean parent checkpoint → splitover plugin reads parent's path → no ReAct reentry fired", async () => {
    // Regression for MR !162 review M1: when tryStartCheckpointWriter spawns
    // a child session, the splitover plugin's actor.preStop hook needs to
    // re-derive paths against the PARENT's sessionID (where the writer wrote
    // its checkpoint.md), not the child's. Without parentSessionID plumbed
    // through SpawnInput → forkWork → triggerActorPreStop, the plugin sees
    // checkpointPath(child) → empty file → false topic-missing → forces a
    // ReActReentered loop up to MAX_PRE_REACT, costing 2-3× LLM calls per
    // checkpoint.
    //
    // This test drives the real Actor.spawn path with a scripted LLM,
    // pre-writes a CLEAN checkpoint at the PARENT's path, and asserts that
    // the writer settles cleanly with ZERO ReActReentered events. Pre-fix
    // (before MR review M1) would surface ≥1 reentry event with a
    // "checkpoint file did not exist" reason because the plugin read from
    // the child's path.
    const server = startScriptedLLMServer([
      { lines: textStopResponse("turn 0: writer would normally write here") },
    ])

    const CLEAN = `Topic: clean parent checkpoint

### Execution context
(none)

### Live resources
(none)

### Session metadata
(none)

### Discovered
(none)

### Dead ends
(none)
`

    let parentSessionIDForCleanup: SessionID | undefined
    let childSessionIDForCleanup: SessionID | undefined

    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(
            `${dir}/mimocode.json`,
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: { apiKey: "test-key", baseURL: `${server.origin}/v1` },
                },
              },
              agent: {
                "checkpoint-writer": { model: "alibaba/qwen-plus" },
              },
            }),
          )
        },
      })

      const { reenteredEvents, parentID, childID } = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const reenteredEvents: Array<{
                phase: string
                triggeredByPlugins: string[]
                iteration: number
              }> = []

              const sessions = yield* Session.Service
              const parent = yield* sessions.create({ title: "parentSessionID wiring test" })
              parentSessionIDForCleanup = parent.id

              // Seed a single user message so tryStartCheckpointWriter's
              // empty-skip guard doesn't fire.
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                role: "user",
                sessionID: parent.id,
                agent: "build",
                model: {
                  providerID: ProviderID.make("alibaba"),
                  modelID: ModelID.make("qwen-plus"),
                },
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                messageID: user.id,
                sessionID: parent.id,
                type: "text",
                text: "seed",
              })

              // Pre-write CLEAN checkpoint at PARENT's path. If parentSessionID
              // is wired correctly, the splitover plugin will read THIS file
              // and see no violations. If not wired, the plugin reads the
              // child's empty path and fires a topic-missing reflection.
              yield* Effect.promise(async () => {
                await fs.mkdir(metaDir(parent.id), { recursive: true })
                await fs.writeFile(checkpointPath(parent.id), CLEAN)
              })

              // Subscribe to ReActReentered so we can assert it never fires.
              yield* bus.subscribe(HookEvent.ReActReentered).pipe(
                Stream.runForEach((p) =>
                  Effect.sync(() => {
                    reenteredEvents.push({
                      phase: p.properties.phase,
                      triggeredByPlugins: p.properties.triggeredByPlugins,
                      iteration: p.properties.iteration,
                    })
                  }),
                ),
                Effect.forkScoped,
              )

              // Trigger checkpoint writer the production way — this creates
              // a child session and spawns the writer in it. The wiring under
              // test: actor.spawn must receive parentSessionID = parent.id,
              // forkWork must propagate it, plugin must see it.
              const svc = yield* SessionCheckpoint.Service
              const status = yield* svc.tryStartCheckpointWriter({
                sessionID: parent.id,
                model: { providerID: "alibaba", modelID: "qwen-plus" },
                promptOps: {} as never,
              })
              if (status !== "started") throw new Error(`expected started, got ${status}`)

              yield* svc.waitForWriter(parent.id)

              // Find the child session created by tryStartCheckpointWriter.
              const children = yield* Effect.sync(() => sessions.children(parent.id))
              const childList = yield* children
              const child = childList.find((c) => c.title.startsWith("checkpoint-writer:"))
              if (!child) throw new Error("expected a checkpoint-writer child session")
              childSessionIDForCleanup = child.id

              // Allow the subscriber fork to drain any tail events.
              yield* Effect.sleep("50 millis")

              return { reenteredEvents, parentID: parent.id, childID: child.id }
            }).pipe(Effect.scoped),
          ),
      })

      // Sanity: parent and child differ (proves Axis A active).
      expect(childID).not.toBe(parentID)

      // The contract under test: clean parent file → no preStop reentry.
      // Pre-fix: at least one reentry event from CheckpointSplitoverPlugin
      // with reason mentioning "checkpoint file did not exist".
      const splitoverReentries = reenteredEvents.filter((e) =>
        e.triggeredByPlugins.includes("CheckpointSplitoverPlugin"),
      )
      expect(splitoverReentries.length).toBe(0)
    } finally {
      await server.stop()
      for (const sid of [parentSessionIDForCleanup, childSessionIDForCleanup]) {
        if (sid) {
          await fs.rm(metaDir(sid), { recursive: true, force: true }).catch(() => {})
        }
      }
    }
  })
})
