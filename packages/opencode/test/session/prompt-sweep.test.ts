import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import path from "path"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Instance } from "../../src/project/instance"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(
  Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, CrossSpawnSpawner.defaultLayer),
)

const makeAssistant = (
  sessionID: MessageV2.Assistant["sessionID"],
  parentID: MessageV2.Assistant["parentID"],
  dir: string,
  time: MessageV2.Assistant["time"],
): MessageV2.Assistant => ({
  id: MessageID.ascending(),
  role: "assistant",
  sessionID,
  mode: "default",
  agent: "default",
  path: { cwd: path.resolve(dir), root: path.resolve(dir) },
  cost: 0,
  tokens: { output: 0, input: 0, reasoning: 0, cache: { read: 0, write: 0 } },
  modelID: ModelID.make("test-model"),
  providerID: ProviderID.make("test"),
  parentID,
  time,
})

describe("sweepOrphanAssistants", () => {
  it.live("drops a trailing incomplete assistant regardless of age", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const userMsg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() - 5_000 },
        })

        // A FRESH orphan — the exact shape a hard interruption leaves behind.
        // The old age gate kept it on disk for an hour, where it poisoned every
        // request and made new messages render as stuck QUEUED. Callers only
        // invoke the sweep on an idle session, so age is irrelevant now.
        const now = Date.now()
        const assistant = makeAssistant(session.id, userMsg.id, dir, { created: now - 3_000 })
        yield* sessions.updateMessage(assistant)

        yield* svc.sweepOrphanAssistants(session.id)

        const after = yield* sessions.messages({ sessionID: session.id })
        expect(after.find((m) => m.info.id === assistant.id)).toBeUndefined()
        // The user turn it belonged to is untouched.
        expect(after.find((m) => m.info.id === userMsg.id)).toBeDefined()
      }),
    ),
  )

  it.live("leaves an already-completed trailing assistant untouched", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const userMsg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() - 7_300_000 },
        })

        const now = Date.now()
        const originalCompleted = now - 7_200_000
        const assistant = makeAssistant(session.id, userMsg.id, dir, {
          created: now - 7_200_000,
          completed: originalCompleted,
        })
        yield* sessions.updateMessage(assistant)

        yield* svc.sweepOrphanAssistants(session.id)

        const after = yield* sessions.messages({ sessionID: session.id })
        const updated = after.find((m) => m.info.id === assistant.id)
        expect(updated).toBeDefined()
        const info = updated!.info as MessageV2.Assistant
        expect(info.time.completed).toBe(originalCompleted)
        expect(info.error).toBeUndefined()
      }),
    ),
  )

  it.live("drops a NON-trailing incomplete assistant in the main slice", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const firstUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() - 9_000 },
        })
        // A NON-trailing incomplete assistant. The sweep runs before
        // createUserMessage, so an orphan is trailing in the single-slice case —
        // but it is left non-trailing whenever a later message already exists (a
        // concurrent subagent row, or a previous source:"spawn"|"hook" prompt that
        // skipped the sweep block). A trailing-only rule strands it forever, and
        // the TUI's `pending` marker (routes/session/index.tsx) derives from the
        // newest INCOMPLETE assistant regardless of what follows it — so the
        // stranded row keeps rendering fresh messages as stuck QUEUED, the exact
        // symptom this sweep exists to prevent.
        const assistant = makeAssistant(session.id, firstUser.id, dir, { created: Date.now() - 8_000 })
        yield* sessions.updateMessage(assistant)
        const secondUser = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() - 1_000 },
        })

        yield* svc.sweepOrphanAssistants(session.id)

        const after = yield* sessions.messages({ sessionID: session.id })
        expect(after.find((m) => m.info.id === assistant.id)).toBeUndefined()
        // Both user turns are untouched.
        expect(after.find((m) => m.info.id === firstUser.id)).toBeDefined()
        expect(after.find((m) => m.info.id === secondUser.id)).toBeDefined()
      }),
    ),
  )

  it.live("never touches a non-main slice, whose actor may still be mid-turn", () =>
    provideTmpdirInstance((dir) =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const svc = yield* SessionPrompt.Service
        const session = yield* sessions.create({})

        const userMsg = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "default",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() - 9_000 },
        })
        // SessionProcessor publishes status for the MAIN slice alone, so the idle
        // gate the caller checks proves nothing about a subagent. This row is the
        // newest message in the session AND incomplete — i.e. exactly what a live
        // background actor's in-flight assistant looks like. Removing it would
        // delete that row out from under the actor's own processor, which keeps
        // calling updatePart against this messageID.
        const subAssistant: MessageV2.Assistant = {
          ...makeAssistant(session.id, userMsg.id, dir, { created: Date.now() - 1_000 }),
          agentID: "explore-1",
        }
        yield* sessions.updateMessage(subAssistant)

        yield* svc.sweepOrphanAssistants(session.id)

        const sub = yield* sessions.messages({ sessionID: session.id, agentID: "explore-1" })
        const survivor = sub.find((m) => m.info.id === subAssistant.id)
        expect(survivor).toBeDefined()
        expect((survivor!.info as MessageV2.Assistant).time.completed).toBeUndefined()
      }),
    ),
  )
})
