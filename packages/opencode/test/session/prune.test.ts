import { afterEach, describe, expect, mock, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { SessionCheckpoint, type WriterSettlement } from "../../src/session/checkpoint"
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
    api: { id: "test-model", npm: opts.npm ?? "@ai-sdk/anthropic" },
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
    "compacts old completed tool output",
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
            expect(part.state.time.compacted).toBeNumber()
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

describe("SessionPrune.fireCheckpoints writer failure is not retried in place", () => {
  // A programmable stub of SessionCheckpoint.Service drives the writer
  // outcomes: tryStartCheckpointWriter always returns "started" (counted in
  // stubEnqueueCount), and the settlement queue is drained in order.
  // Each test constructs a fresh harness so module state is per-test.
  //
  // SCAFFOLDING NOTE (no assertion changed): the queue holds WriterSettlement
  // objects rather than bare WriterOutcome strings, and waitForWriter projects
  // `.outcome` off the same queue exactly as production does. prune reads the
  // classification-bearing shape, so a stub that only implemented
  // waitForWriter would leave every failure case below VACUOUS — the queue
  // would never be drained and no failure would ever be observed.
  function makeRetryHarness() {
    const outcomes: Array<WriterSettlement> = []
    const state = { enqueueCount: 0 }

    const nextSettlement = (): WriterSettlement => outcomes.shift() ?? { outcome: "no-writer" as const }

    const stubLayer = Layer.succeed(
      SessionCheckpoint.Service,
      SessionCheckpoint.Service.of({
        tryStartCheckpointWriter: () =>
          Effect.sync(() => {
            state.enqueueCount++
            return "started" as const
          }),
        waitForWriter: () => Effect.sync(() => nextSettlement().outcome),
        waitForWriterSettlement: () => Effect.sync(nextSettlement),
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

    return { env, outcomes, state }
  }

  // Helper: run a prune-layer effect inside a tmpdir + Instance context.
  function runWithHarness<A, E>(
    harness: ReturnType<typeof makeRetryHarness>,
    body: Effect.Effect<A, E, SessionPrune.Service | SessionNs.Service>,
    config?: Partial<Config.Info>,
  ): Promise<A> {
    return Effect.runPromise(
      provideTmpdirInstance(() => body, { config: { compaction: { reserved: 20_000 }, ...config } }).pipe(
        Effect.scoped,
        Effect.provide(harness.env),
      ),
    )
  }

  const makeTokens = () => ({
    input: 60_000,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  const makeTokensAt = (n: number) => ({
    input: n,
    output: 0,
    reasoning: 0,
    cache: { read: 0, write: 0 },
  })

  test("disabled thresholds remain eligible after checkpointing is re-enabled", async () => {
    const previous = process.env.MIMOCODE_DISABLE_CHECKPOINT
    const harness = makeRetryHarness()
    const promptOps = {} as any

    try {
      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          process.env.MIMOCODE_DISABLE_CHECKPOINT = "true"
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
          expect(harness.state.enqueueCount).toBe(0)

          process.env.MIMOCODE_DISABLE_CHECKPOINT = "false"
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
          expect(harness.state.enqueueCount).toBe(1)
        }),
        { checkpoint: { thresholds: ["30K", "45K"] } },
      )
    } finally {
      if (previous === undefined) delete process.env.MIMOCODE_DISABLE_CHECKPOINT
      else process.env.MIMOCODE_DISABLE_CHECKPOINT = previous
    }
  })

  // These cases replace the six that pinned the deleted accounting
  // (writerFailures / MAX_WRITER_FAILURES / MAX_WRITER_WAIT_EXTENSIONS). What
  // they used to assert, and why it is no longer the requirement:
  //
  //   - "three writer failures retry below cap, stop at cap" and "success
  //     outcome resets failure counter" asserted that a failure BELOW the cap
  //     re-armed the same threshold (enqueue 1->2->3) and that a success
  //     cleared the counter. Both encoded in-place retry as the requirement.
  //   - "a timed-out wait never ticks the counter..." and "a writer that fails
  //     past the wait bound is still counted, so the cap stays reachable"
  //     asserted the watcher kept re-entering the bounded wait so a late
  //     outcome still reached the counter.
  //   - the pair bracketing MAX_WRITER_WAIT_EXTENSIONS pinned the 13-call
  //     boundary of that re-entry loop exactly.
  //
  // None of it is required now, because a failed write is self-healing:
  // ensureCheckpointTemplate only writes when the file is ABSENT and the
  // watermark advances only on success, so a failure leaves file and watermark
  // consistent at the last good checkpoint. The requirement is the inverse --
  // a failure must NOT retry in place, and the next crossing must still fire.
  //
  // STILL THE REQUIREMENT after the recovery gate was added. The gate is
  // narrower than these cases on both axes: it needs a RETRYABLE class, and it
  // only applies to the FINAL threshold. Every failure below pushes
  // `{ outcome: "failure" }` with no `failure` field -- an UNCLASSIFIED failure,
  // which the gate refuses -- and the first case's failure is at a non-final
  // threshold anyway. So these three assertions are unchanged, not relaxed:
  // they now also pin that an unclassified failure is treated as "cannot know
  // whether a retry helps" and therefore behaves exactly as before. The gate's
  // own behaviour is pinned separately in the describe block below.
  test("a failed writer does not re-arm its own threshold — no in-place retry", async () => {
    const harness = makeRetryHarness()
    const promptOps = {} as any

    await runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        harness.outcomes.push({ outcome: "failure" })

        // Fire 1 crosses 30K and enqueues; its writer fails.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(1)

        // Fires 2-4 at the same token level must NOT re-enqueue: the threshold
        // stays in `crossed`. The deleted watcher did `crossed.delete()` on a
        // sub-cap failure, so under the old code these three fires would have
        // read 2, then 3, then stopped at the 3-failure cap.
        for (let i = 0; i < 3; i++) {
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
          yield* Effect.sleep(100)
        }
        expect(harness.state.enqueueCount).toBe(1)
      }),
      { checkpoint: { thresholds: ["30K", "45K"] } },
    )
  })

  test("the next threshold crossing still fires after a failure", async () => {
    const harness = makeRetryHarness()
    const promptOps = {} as any

    await runWithHarness(
      harness,
      Effect.gen(function* () {
        const svc = yield* SessionPrune.Service
        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})
        const model = createModel({ context: 100_000, output: 32_000 })

        harness.outcomes.push({ outcome: "failure" }, { outcome: "failure" })

        // 30K crosses and fails.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(35_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(1)

        // Tokens grow past 45K: the failure must not have suppressed the
        // session, so this crossing fires. This is the retry the design relies
        // on instead of an in-place one, and it carries fresher context than a
        // re-fire of 30K would have. The old code reached a SECOND enqueue too
        // -- the counter never gated a NEW threshold -- but it reached a THIRD,
        // because the failure had also re-armed 30K. So the exact count, not
        // just "it still fires", is what pins the absence of in-place retry.
        yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(50_000), promptOps })
        yield* Effect.sleep(100)
        expect(harness.state.enqueueCount).toBe(2)
      }),
      { checkpoint: { thresholds: ["30K", "45K"] } },
    )
  })

  // The FINAL threshold's recovery gate. Sibling of the three cases above, not
  // a reversal of them: those pin that a failure never re-arms its own
  // threshold, and the gate is admitted only for the one threshold that has no
  // successor in the ladder, only for a failure whose class says a retry could
  // succeed, and only once the token count has grown by a full ladder step.
  //
  // Arithmetic all four cases depend on, stated once. The harness pins the
  // compaction reserve at 20K so these recovery-gate tests remain about writer
  // retries rather than changes to the product default. createModel({ context:
  // 100_000, output: 32_000 }) with no `limit.input` gives usable = 100_000 -
  // (min(20_000, 32_000) compaction reserve + min(32_000, 20_000) output
  // reserve) = 60_000, so maxAllowed = 60_000 - CHECKPOINT_RESERVED(13_000) =
  // 47_000. Thresholds are written absolute ("20K"/"30K") so the ladder step is
  // exactly 10_000 and nothing depends on percent-of-window rounding.
  describe("final-threshold recovery gate", () => {
    const TRANSIENT = { kind: "transient" as const, retryable: true, name: "APIError" }
    const DETERMINISTIC = { kind: "overflow" as const, retryable: false, name: "ContextOverflowError" }

    test("a DETERMINISTIC failure at the final threshold arms no gate", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure" }, { outcome: "failure", failure: DETERMINISTIC })

          // Cross the thresholds one at a time so each forked wait drains
          // exactly one seeded settlement (two concurrent waits would race for
          // the head of the queue).
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          // A full ladder step of growth past the final threshold. A retry here
          // would fail identically — overflow/auth/bad-request do not become
          // valid by being repeated — so re-firing would spend a writer's dozen
          // round-trips to reproduce the same error.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(41_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)
        }),
        { checkpoint: { thresholds: ["20K", "30K"] } },
      )
    })

    test("a TRANSIENT failure at the final threshold re-fires it, but only once growth reaches a full ladder step", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure" }, { outcome: "failure", failure: TRANSIENT })

          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          // THE BOUND. Fired at 31_000, so the gate sits at min(31_000 + 10_000,
          // 47_000) = 41_000. Below it nothing re-fires, however many turns go
          // by — which is what stops the transient case from becoming a hot loop
          // spawning a writer per runLoop iteration at an unchanged token count.
          for (const tokens of [31_000, 35_000, 40_999]) {
            yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(tokens), promptOps })
            yield* Effect.sleep(100)
          }
          expect(harness.state.enqueueCount).toBe(2)

          // At the gate it re-fires: there is now a step's worth of uncovered
          // delta that the failed attempt never captured, and the watermark did
          // not advance, so this is new work rather than a repeat.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(41_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(3)
        }),
        { checkpoint: { thresholds: ["20K", "30K"] } },
      )
    })

    test("a TRANSIENT failure arms no gate when the window has no room left for a retry", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure" }, { outcome: "failure", failure: TRANSIENT })

          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          // Final threshold 45K fired at maxAllowed itself, so the gate would be
          // min(47_000 + 25_000, 47_000) = 47_000 — not ahead of where it fired.
          // The retry budget IS the unused window, so here it is zero.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(47_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          for (const tokens of [47_000, 50_000, 59_000]) {
            yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(tokens), promptOps })
            yield* Effect.sleep(100)
          }
          expect(harness.state.enqueueCount).toBe(2)
        }),
        { checkpoint: { thresholds: ["20K", "45K"] } },
      )
    })

    test("a TRANSIENT failure at a NON-final threshold arms no gate — its successor is the retry", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure", failure: TRANSIENT })

          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(1)

          // 20K is not the final threshold, so 30K is already its retry. If the
          // gate were armed here too it would sit at 31_000 and this crossing
          // would enqueue TWICE — once for the re-armed 20K and once for 30K.
          // The exact count, not "it still fires", is what pins that.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          // And the pollution this specifically rules out: the gate is keyed per
          // SESSION, not per threshold, so a gate armed by a NON-final failure
          // would be sitting at 31_000 for the final threshold to consume — the
          // final threshold would fire a second time on the strength of a
          // different threshold's failure. The admission rule alone does not stop
          // that (30K IS the final threshold by the time it reads the gate);
          // refusing to arm from a non-final threshold is what does.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)
        }),
        { checkpoint: { thresholds: ["20K", "30K"] } },
      )
    })

    test("a bound-expiry 'timeout' at the final threshold arms no gate", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure" }, { outcome: "timeout" })

          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          // "timeout" means the writer is STILL IN FLIGHT (#1938's contract) and
          // may yet succeed and advance the watermark, so it must not arm.
          //
          // Honest about what this pins: the `outcome !== "failure"` check alone
          // is NOT observable here, because a timeout also carries no
          // classification, so the retryable check rejects it too. Removing
          // EITHER guard leaves this green; removing BOTH turns it red. It is
          // pinned as the conjunction, and the invariant the redundancy rests on
          // — a timeout never carries a classification — is asserted directly
          // against the real service in checkpoint-writer-wait-timeout.test.ts.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(41_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)
        }),
        { checkpoint: { thresholds: ["20K", "30K"] } },
      )
    })

    test("resetThresholds drops a pending gate — a rebuild re-arms the whole ladder instead", async () => {
      const harness = makeRetryHarness()
      const promptOps = {} as any

      await runWithHarness(
        harness,
        Effect.gen(function* () {
          const svc = yield* SessionPrune.Service
          const ssn = yield* SessionNs.Service
          const info = yield* ssn.create({})
          const model = createModel({ context: 100_000, output: 32_000 })

          harness.outcomes.push({ outcome: "failure" }, { outcome: "failure", failure: TRANSIENT })

          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(21_000), promptOps })
          yield* Effect.sleep(100)
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(31_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(2)

          // A successful discard+rebuild calls resetThresholds (prompt.ts:428).
          // The whole ladder is re-armed from 20K, so a leftover gate on the
          // final threshold would let it fire ahead of its own successors.
          yield* svc.resetThresholds(info.id)

          // Post-reset the ladder replays in order: this crossing enqueues for
          // 20K and 30K, and NOT a third time for the stale gate.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(41_000), promptOps })
          yield* Effect.sleep(150)
          expect(harness.state.enqueueCount).toBe(4)

          // And the replayed final threshold is back to one-shot. A gate that
          // survived the reset would still read 41_000 here — `already` now holds
          // 30K again, so the stale gate would be exactly what admits a re-fire.
          yield* svc.fireCheckpoints({ sessionID: info.id, model, tokens: makeTokensAt(41_000), promptOps })
          yield* Effect.sleep(100)
          expect(harness.state.enqueueCount).toBe(4)
        }),
        { checkpoint: { thresholds: ["20K", "30K"] } },
      )
    })
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
