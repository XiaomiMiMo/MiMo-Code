import { describe, expect } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Effect, Layer } from "effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { Snapshot } from "../../src/snapshot"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

void Log.init({ print: false })

const env = Layer.mergeAll(
  SessionPrompt.defaultLayer,
  Session.defaultLayer,
  Snapshot.defaultLayer,
  CrossSpawnSpawner.defaultLayer,
)

const it = testEffect(env)

const tokens = {
  input: 0,
  output: 0,
  reasoning: 0,
  cache: { read: 0, write: 0 },
}

const write = (file: string, text: string) => Effect.promise(() => fs.writeFile(file, text))
const read = (file: string) => Effect.promise(() => fs.readFile(file, "utf-8"))

const user = Effect.fn("test.user")(function* (sessionID: SessionID) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "user" as const,
    sessionID,
    agent: "default",
    model: { providerID: ProviderID.make("openai"), modelID: ModelID.make("gpt-4") },
    time: { created: Date.now() },
  })
})

const assistant = Effect.fn("test.assistant")(function* (sessionID: SessionID, parentID: MessageID, dir: string) {
  const session = yield* Session.Service
  return yield* session.updateMessage({
    id: MessageID.ascending(),
    role: "assistant" as const,
    sessionID,
    mode: "default",
    agent: "default",
    path: { cwd: dir, root: dir },
    cost: 0,
    tokens,
    modelID: ModelID.make("gpt-4"),
    providerID: ProviderID.make("openai"),
    parentID,
    time: { created: Date.now() },
    finish: "end_turn",
  })
})

const text = Effect.fn("test.text")(function* (sessionID: SessionID, messageID: MessageID, content: string) {
  const session = yield* Session.Service
  return yield* session.updatePart({
    id: PartID.ascending(),
    messageID,
    sessionID,
    type: "text" as const,
    text: content,
  })
})

describe("session undo command", () => {
  it.live(
    "reverts file changes from the latest turn",
    provideTmpdirInstance(
      (dir) =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const snapshot = yield* Snapshot.Service
          const file = path.join(dir, "note.txt")

          yield* write(file, "before")

          const info = yield* session.create({})
          const u = yield* user(info.id)
          yield* text(info.id, u.id, "change note")
          const a = yield* assistant(info.id, u.id, dir)
          const before = yield* snapshot.track()
          if (!before) throw new Error("expected snapshot")
          yield* write(file, "after")
          const after = yield* snapshot.track()
          if (!after) throw new Error("expected snapshot")
          const patch = yield* snapshot.patch(before)

          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "step-start",
            snapshot: before,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "step-finish",
            reason: "stop",
            snapshot: after,
            cost: 0,
            tokens,
          })
          yield* session.updatePart({
            id: PartID.ascending(),
            messageID: a.id,
            sessionID: info.id,
            type: "patch",
            hash: patch.hash,
            files: patch.files,
          })

          expect(yield* read(file)).toBe("after")

          const result = yield* prompt.command({
            sessionID: info.id,
            command: "undo",
            arguments: "",
          })

          expect(result.info.id).toBe(a.id)
          expect((yield* session.get(info.id)).revert?.messageID).toBe(u.id)
          expect(yield* read(file)).toBe("before")
        }),
      { git: true },
    ),
    30000,
  )
})
