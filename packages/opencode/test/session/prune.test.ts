import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { SessionPrune, defaultThresholdsFor } from "../../src/session/prune"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import type { Provider } from "../../src/provider"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ActorRegistry } from "../../src/actor/registry"
import { Flag } from "../../src/flag/flag"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

afterEach(() => {
  mock.restore()
})

function createModel(opts: {
  context: number
  output: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionPrune.layer.pipe(
    Layer.provide(SessionNs.defaultLayer),
    Layer.provide(SessionCheckpoint.defaultLayer),
    Layer.provide(ActorRegistry.defaultLayer),
    Layer.provideMerge(deps),
  ),
)

const it = testEffect(env)

/**
 * Seeds a session that `prune` can act on: one user+assistant turn with a
 * 200k-char tool output, then two follow-up user turns. The 200k output is
 * old enough (separated by later turns) that prune should consider it for
 * trimming, unless the tool name is in the protected list.
 */
const seedSessionWithOldToolOutput = Effect.fn("PruneTest.seed")(function* (input: {
  sessionID: SessionID
  dir: string
  tool: string
}) {
  const ssn = yield* SessionNs.Service

  const user = yield* ssn.updateMessage({
    id: MessageID.ascending(),
    role: "user",
    sessionID: input.sessionID,
    agent: "build",
    model: ref,
    time: { created: Date.now() },
  })
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: user.id,
    sessionID: input.sessionID,
    type: "text",
    text: "first",
  })
  const assistant: MessageV2.Assistant = {
    id: MessageID.ascending(),
    role: "assistant",
    sessionID: input.sessionID,
    mode: "build",
    agent: "build",
    path: { cwd: input.dir, root: input.dir },
    cost: 0,
    tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    modelID: ref.modelID,
    providerID: ref.providerID,
    parentID: user.id,
    time: { created: Date.now() },
    finish: "end_turn",
  }
  yield* ssn.updateMessage(assistant)
  yield* ssn.updatePart({
    id: PartID.ascending(),
    messageID: assistant.id,
    sessionID: input.sessionID,
    type: "tool",
    callID: crypto.randomUUID(),
    tool: input.tool,
    state: {
      status: "completed",
      input: {},
      output: "x".repeat(200_000),
      title: "done",
      metadata: {},
      time: { start: Date.now(), end: Date.now() },
    },
  })
  for (const text of ["second", "third"]) {
    const msg = yield* ssn.updateMessage({
      id: MessageID.ascending(),
      role: "user",
      sessionID: input.sessionID,
      agent: "build",
      model: ref,
      time: { created: Date.now() },
    })
    yield* ssn.updatePart({
      id: PartID.ascending(),
      messageID: msg.id,
      sessionID: input.sessionID,
      type: "text",
      text,
    })
  }
})

describe("SessionPrune.prune", () => {
  it.live(
    "preserves old completed tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const info = yield* ssn.create({})

          yield* seedSessionWithOldToolOutput({ sessionID: info.id, dir, tool: "bash" })

          // pressure-based level requires tokens > 0; simulate heavy usage
          const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* svc.prune({ sessionID: info.id, model, tokens })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          expect(part?.state.status).toBe("completed")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
            expect(part.state.output).toBe("x".repeat(200_000))
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )

  it.live(
    "skips protected skill tool output",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const model = createModel({ context: 100_000, output: 32_000 })
          const info = yield* ssn.create({})

          yield* seedSessionWithOldToolOutput({ sessionID: info.id, dir, tool: "skill" })

          const tokens = { input: 80_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } }
          yield* svc.prune({ sessionID: info.id, model, tokens })

          const msgs = yield* ssn.messages({ sessionID: info.id })
          const part = msgs.flatMap((msg) => msg.parts).find((part) => part.type === "tool")
          expect(part?.type).toBe("tool")
          if (part?.type === "tool" && part.state.status === "completed") {
            expect(part.state.time.compacted).toBeUndefined()
          }
        }),

      {
        config: {
          compaction: { prune: true },
        },
      },
    ),
  )
})

describe("SessionPrune.fireCheckpoints single-attempt behavior", () => {
  async function withCheckpointEnabled<T>(run: () => Promise<T>) {
    const enabled = Flag.MIMOCODE_ENABLE_CHECKPOINT
    Flag.MIMOCODE_ENABLE_CHECKPOINT = true
    try {
      return await run()
    } finally {
      Flag.MIMOCODE_ENABLE_CHECKPOINT = enabled
    }
  }
  function makeCheckpointHarness() {
    const state = { enqueueCount: 0, waitCount: 0 }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            state.enqueueCount++
            return "started" as const
          }),
        waitForWriter: () =>
          Effect.sync(() => {
            state.waitCount++
            return "failure" as const
          }),
        drainWriters: () => Effect.succeed({ drained: 0, timedOut: 0 }),
        hasCheckpoint: () => Effect.succeed(false),
        hasMemoryOrTasks: () => Effect.succeed(false),
        loadLatest: () => Effect.succeed(undefined),
        loadCheckpoints: () => Effect.succeed([]),
        renderIndex: () => Effect.succeed(""),
        renderRebuildContext: () => Effect.succeed(""),
        lastBoundary: () => Effect.succeed(undefined),
        isWriterRunning: () => Effect.succeed(false),
        insertRebuildBoundary: () => Effect.succeed(false),
      }),
    )

    const env = Layer.mergeAll(
      SessionNs.defaultLayer,
      CrossSpawnSpawner.defaultLayer,
      SessionPrune.layer.pipe(
        Layer.provide(SessionNs.defaultLayer),
        Layer.provide(stubLayer),
        Layer.provide(ActorRegistry.defaultLayer),
        Layer.provideMerge(deps),
      ),
    )

    return { env, state }
  }

  // Helper: run a prune-layer effect inside a tmpdir + Instance context.
  function runWithHarness<A, E>(
    harness: ReturnType<typeof makeCheckpointHarness>,
    body: Effect.Effect<A, E, SessionPrune.Service | SessionNs.Service>,
    config?: Partial<Config.Info>,
  ): Promise<A> {
    return Effect.runPromise(
      provideTmpdirInstance(() => body, { config }).pipe(Effect.scoped, Effect.provide(harness.env)),
    )
  }

  const makeTokens = () => ({
    input: 60_000,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  test("does not start a writer while checkpoint generation is disabled", async () => {
    const harness = makeCheckpointHarness()
    const enabled = Flag.MIMOCODE_ENABLE_CHECKPOINT
    Flag.MIMOCODE_ENABLE_CHECKPOINT = false
    try {
      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          yield* svc.fireCheckpoints({
            sessionID: info.id,
            model: createModel({ context: 100_000, output: 32_000 }),
            tokens: makeTokens(),
            promptOps: {} as any,
          })
          expect(harness.state.enqueueCount).toBe(0)
        }),
        { checkpoint: { thresholds: ["50%"] } },
      )
    } finally {
      Flag.MIMOCODE_ENABLE_CHECKPOINT = enabled
    }
  })

  test("does not retry a failed writer at the same threshold", async () => {
    const harness = makeCheckpointHarness()
    const promptOps = {} as any

    await withCheckpointEnabled(() => runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        for (let i = 0; i < 3; i++) {
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokens(), promptOps })
        }
        expect(harness.state.enqueueCount).toBe(1)
        expect(harness.state.waitCount).toBe(0)
      }),
      { checkpoint: { thresholds: ["50%"] } },
    ))
  })

  test("only an explicit threshold reset permits another writer", async () => {
    const harness = makeCheckpointHarness()
    const promptOps = {} as any

    await withCheckpointEnabled(() => runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokens(), promptOps })
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokens(), promptOps })
        expect(harness.state.enqueueCount).toBe(1)

        yield* svc.resetThresholds(info.id)
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokens(), promptOps })
        expect(harness.state.enqueueCount).toBe(2)
        expect(harness.state.waitCount).toBe(0)
      }),
      { checkpoint: { thresholds: ["50%"] } },
    ))
  })
})

describe("defaultThresholdsFor (Part 2 density)", () => {
  // Constants used in expected outputs; declared once so a typo in any one
  // assertion is caught against a single source.
  const FOUR_AT_20 = ["20%", "40%", "60%", "80%"] as const
  const NINE_AT_10 = [
    "10%", "20%", "30%", "40%", "50%", "60%", "70%", "80%", "90%",
  ] as const
  const EIGHTEEN_AT_5 = Array.from({ length: 18 }, (_, i) => `${(i + 1) * 5}%`)

  test("window < 25K returns empty (subsystem disabled)", () => {
    expect(defaultThresholdsFor(0)).toEqual([])
    expect(defaultThresholdsFor(20_000)).toEqual([])
    expect(defaultThresholdsFor(24_999)).toEqual([])
  })

  test("25K ≤ window ≤ 200K uses [20%, 40%, 60%, 80%] (4 triggers @ 20%)", () => {
    expect(defaultThresholdsFor(25_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(50_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(100_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(150_000)).toEqual(FOUR_AT_20)
    expect(defaultThresholdsFor(200_000)).toEqual(FOUR_AT_20)
  })

  test("200K < window ≤ 500K uses 9-tier [10%..90%]", () => {
    expect(defaultThresholdsFor(200_001)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(300_000)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(400_000)).toEqual(NINE_AT_10)
    expect(defaultThresholdsFor(500_000)).toEqual(NINE_AT_10)
  })

  test("window > 500K uses 18-tier [5%, 10%, ..., 90%]", () => {
    expect(defaultThresholdsFor(500_001)).toEqual(EIGHTEEN_AT_5)
    expect(defaultThresholdsFor(1_000_000)).toEqual(EIGHTEEN_AT_5)
    expect(defaultThresholdsFor(2_000_000)).toEqual(EIGHTEEN_AT_5)
  })

  test("18-tier shape: starts at 5%, ends at 90%, 18 items, monotonic", () => {
    const out = defaultThresholdsFor(1_000_000)
    expect(out.length).toBe(18)
    expect(out[0]).toBe("5%")
    expect(out[8]).toBe("45%") // mid-array spot check (closes a generator-typo gap)
    expect(out[out.length - 1]).toBe("90%")
    const nums = out.map((s) => parseFloat(s.replace("%", "")))
    for (let i = 1; i < nums.length; i++) {
      expect(nums[i]).toBeGreaterThan(nums[i - 1])
    }
  })
})
