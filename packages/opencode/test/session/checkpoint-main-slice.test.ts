import { describe, expect } from "bun:test"
import { Deferred, Effect, Layer } from "effect"
import { Bus } from "../../src/bus"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Memory } from "../../src/memory"
import { ActorRegistry } from "../../src/actor/registry"
import { Actor, type AgentOutcome, type SpawnInput } from "../../src/actor/spawn"
import { spawnRef } from "../../src/actor/spawn-ref"
import { prefixCaptureRef } from "../../src/session/prefix-capture-ref"
import { TaskRegistry } from "../../src/task/registry"
import { SessionCheckpoint } from "../../src/session/checkpoint"
import { Log } from "../../src/util"
import { Plugin } from "../../src/plugin"
import { provideTmpdirInstance } from "../fixture/fixture"
import { Session as SessionNs } from "../../src/session"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { ProviderTest } from "../fake/provider"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

void Log.init({ print: false })

const ref = {
  providerID: ProviderID.make("test"),
  modelID: ModelID.make("test-model"),
}

// Capture the SpawnInput passed to actor.spawn so the test can inspect the
// ForkContext (specifically watermarkMsgID) that tryStartCheckpointWriter
// computed. The outcome never resolves — we only care about what was passed
// in, not what the writer produces.
interface PrefixRecord {
  id: string
  agentID?: string
}
interface Captures {
  input: SpawnInput | undefined
  prefixMsgs: ReadonlyArray<PrefixRecord> | undefined
}
const captures: Captures = { input: undefined, prefixMsgs: undefined }

const recordingActor = Layer.effect(
  Actor.Service,
  Effect.gen(function* () {
    const prevSpawnRef = spawnRef.current
    const prevPrefixCaptureRef = prefixCaptureRef.current
    const impl = Actor.Service.of({
      spawn: (input) =>
        Effect.gen(function* () {
          captures.input = input
          const outcome = yield* Deferred.make<AgentOutcome>()
          return {
            actorID: `${input.agentType}-1`,
            sessionID: input.sessionID,
            outcome,
          }
        }),
      cancel: () => Effect.void,
      getForkContext: () => Effect.succeed(undefined),
    })
    spawnRef.current = impl

    // Stand-in prefix capture: records what msgs[] was passed in (which is
    // the slice tryStartCheckpointWriter sliced from `msgs` at the watermark)
    // and returns an empty prefix so the fork capture path completes.
    const capture: typeof prefixCaptureRef.current = (input) =>
      Effect.sync(() => {
        captures.prefixMsgs = (input.msgs as Array<{ info: { id: string; agentID?: string } }>).map((m) => ({
          id: m.info.id,
          agentID: m.info.agentID,
        }))
        return {
          system: [] as string[],
          tools: {},
          inheritedMessages: [],
          parentPermission: [],
        }
      })
    prefixCaptureRef.current = capture

    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (spawnRef.current === impl) spawnRef.current = prevSpawnRef
        if (prefixCaptureRef.current === capture) prefixCaptureRef.current = prevPrefixCaptureRef
      }),
    )
    return impl
  }),
)

const deps = Layer.mergeAll(
  ProviderTest.fake().layer,
  Agent.defaultLayer,
  Plugin.defaultLayer,
  Bus.layer,
  Config.defaultLayer,
  Memory.defaultLayer,
  TaskRegistry.defaultLayer,
  ActorRegistry.defaultLayer,
  recordingActor,
)

const env = Layer.mergeAll(
  SessionNs.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
  SessionCheckpoint.layer.pipe(Layer.provide(SessionNs.defaultLayer), Layer.provideMerge(deps)),
)

const it = testEffect(env)

// Regression for fork-prefix parity: tryStartCheckpointWriter must consume the
// main-only slice (matching parent's runLoop view at prompt.ts:2036-2040). If
// it ever pulls the unfiltered session stream again, computeBoundary lands on
// a subagent's finished assistant turn and the prefix-cache invariant from
// docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md breaks.
describe("SessionCheckpoint.tryStartCheckpointWriter main-slice", () => {
  it.live(
    "watermark + prefix msgs ignore non-main agentID rows",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        captures.input = undefined
        captures.prefixMsgs = undefined

        const ssn = yield* SessionNs.Service
        const info = yield* ssn.create({})

        // Helper: seed a (user, finished assistant) main pair with body text
        // sized to clear computeBoundary's TAIL_MIN_TOKENS floor.
        const big = "lorem ipsum ".repeat(800) // ≈ 9.6KB → ~2.4k tokens, 5 pairs > TAIL_MIN_TOKENS
        const mainIDs: string[] = []
        let t = Date.now()
        for (let i = 0; i < 5; i++) {
          const u = yield* ssn.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID: info.id,
            agent: "build",
            model: ref,
            time: { created: t++ },
          })
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: u.id,
            sessionID: info.id,
            type: "text",
            text: big,
          })
          mainIDs.push(u.id)
          const aID = MessageID.ascending()
          yield* ssn.updateMessage({
            id: aID,
            role: "assistant" as const,
            sessionID: info.id,
            agentID: "main",
            agent: "build",
            mode: "primary",
            modelID: ref.modelID,
            providerID: ref.providerID,
            parentID: u.id,
            time: { created: t++, completed: t++ },
            finish: "end_turn",
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            path: { cwd: "/", root: "/" },
            cost: 0,
          })
          const a = { id: aID }
          yield* ssn.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "text",
            text: big,
          })
          mainIDs.push(a.id)
        }

        // Subagent slice on the SAME sessionID. Without main-slice filtering,
        // computeBoundary's `findLastIndex(finish !== undefined)` lands on
        // this subagent assistant. We size the subagent payload above
        // TAIL_MAX_TOKENS so the natural tail clears the algorithm's
        // walk-back gates: under the buggy unfiltered path this freezes the
        // watermark inside the subagent slice and the captured prefix carries
        // subagent rows.
        const huge = "explore body ".repeat(40_000) // ~480KB / 4 ≈ 120k token est.
        const subUser = yield* ssn.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agentID: "explore-1",
          agent: "explore",
          model: ref,
          time: { created: t++ },
        })
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: subUser.id,
          sessionID: info.id,
          type: "text",
          text: huge,
        })
        const subAsstID = MessageID.ascending()
        yield* ssn.updateMessage({
          id: subAsstID,
          role: "assistant" as const,
          sessionID: info.id,
          agentID: "explore-1",
          agent: "explore",
          mode: "default",
          modelID: ref.modelID,
          providerID: ref.providerID,
          parentID: subUser.id,
          time: { created: t++, completed: t++ },
          finish: "end_turn",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          path: { cwd: "/", root: "/" },
          cost: 0,
        })
        const subAsst = { id: subAsstID }
        yield* ssn.updatePart({
          id: PartID.ascending(),
          messageID: subAsst.id,
          sessionID: info.id,
          type: "text",
          text: huge,
        })

        const svc = yield* SessionCheckpoint.Service
        const status = yield* svc.tryStartCheckpointWriter({
          sessionID: info.id,
          model: { providerID: "test", modelID: "test-model" },
          promptOps: {} as never,
        })
        expect(status).toBe("started")

        // ForkContext.watermarkMsgID must point at a MAIN message — not a
        // subagent turn that an unfiltered stream would have pulled in.
        const capturedInput: SpawnInput | undefined = yield* Effect.sync(() => captures.input)
        const capturedPrefixMsgs: ReadonlyArray<PrefixRecord> | undefined = yield* Effect.sync(
          () => captures.prefixMsgs,
        )
        const fork = capturedInput?.forkContext
        expect(fork).toBeDefined()
        const mainSet = new Set(mainIDs)
        expect(mainSet.has(fork!.watermarkMsgID as string)).toBe(true)

        // Slice fed to buildPrefix must be main-only. If a future regression
        // pulls in subagent rows, this assertion fails — the prefix-cache
        // parity invariant from the spec relies on parent's runLoop and
        // tryStartCheckpointWriter consuming the same main slice.
        const seenIDs = capturedPrefixMsgs?.map((m) => m.id) ?? []
        for (const id of seenIDs) expect(mainSet.has(id)).toBe(true)
        expect(seenIDs).not.toContain(subUser.id)
        expect(seenIDs).not.toContain(subAsst.id)
        const seenAgents = new Set(capturedPrefixMsgs?.map((m) => m.agentID ?? "main"))
        expect(seenAgents).toEqual(new Set(["main"]))
      }),
    ),
  )
})
