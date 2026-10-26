import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { History } from "../../src/history"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session as SessionNs } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { Log } from "../../src/util"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, History.defaultLayer, CrossSpawnSpawner.defaultLayer))

const ref = { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") }

const model = {
  id: "test-model",
  providerID: "test",
  name: "Test",
  limit: { context: 100_000, output: 10_000 },
  cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
  capabilities: {
    toolcall: true,
    attachment: false,
    reasoning: false,
    temperature: true,
    input: { text: true, image: false, audio: false, video: false },
    output: { text: true, image: false, audio: false, video: false },
  },
  api: { id: "test-model", npm: "@ai-sdk/openai-compatible" },
  options: {},
} as Provider.Model

const CLEARED = "[Old tool result content cleared]"

describe("legacy compacted tool rows", () => {
  it.live(
    "still render the cleared marker while history get pages the full stored output",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const history = yield* History.Service
        const info = yield* sessions.create({})

        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: info.id,
          agent: "build",
          model: ref,
          time: { created: Date.now() },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: user.id,
          sessionID: info.id,
          type: "text",
          text: "run the tools",
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          sessionID: info.id,
          agent: "build",
          parentID: user.id,
          providerID: ref.providerID,
          modelID: ref.modelID,
          mode: "build",
          path: { cwd: "/tmp/example", root: "/tmp/example" },
          cost: 0,
          finish: "tool-calls",
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          time: { created: Date.now(), completed: Date.now() },
        })
        const outputs = {
          legacy: Array.from({ length: 400 }, (_, i) => `legacy line ${i}`).join("\n"),
          live: Array.from({ length: 400 }, (_, i) => `live line ${i}`).join("\n"),
        }
        const parts = {
          legacy: yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "tool",
            callID: "call-legacy",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "seq 400" },
              output: outputs.legacy,
              title: "bash",
              metadata: {},
              time: { start: 1, end: 2, compacted: 3 },
            },
          }),
          live: yield* sessions.updatePart({
            id: PartID.ascending(),
            messageID: assistant.id,
            sessionID: info.id,
            type: "tool",
            callID: "call-live",
            tool: "bash",
            state: {
              status: "completed",
              input: { command: "seq 400" },
              output: outputs.live,
              title: "bash",
              metadata: {},
              time: { start: 1, end: 2 },
            },
          }),
        }

        const stored = yield* sessions.messages({ sessionID: info.id })
        const rendered = yield* Effect.promise(() => MessageV2.toModelMessages(stored, model))
        const results = rendered
          .flatMap((message) => (message.role === "tool" ? message.content : []))
          .flatMap((content) => (content.type === "tool-result" ? [content] : []))
        const resultText = (callID: string) => JSON.stringify(results.find((result) => result.toolCallId === callID))
        expect(resultText("call-legacy")).toContain(CLEARED)
        expect(resultText("call-legacy")).not.toContain("legacy line 0")
        expect(resultText("call-live")).toContain("live line 399")
        expect(resultText("call-live")).not.toContain(CLEARED)

        for (const key of ["legacy", "live"] as const) {
          let text = ""
          let offset = 0
          let pages = 0
          while (true) {
            const page = yield* history.get({ part_id: parts[key].id, offset })
            if (!page) throw new Error(`history get returned nothing for ${key}`)
            text += page.text
            pages++
            if (!page.has_more) break
            offset = page.next_offset
          }
          expect(pages).toBeGreaterThan(1)
          expect(text).toContain(JSON.stringify(outputs[key]))
          expect(text).not.toContain(CLEARED)
        }
      }),
    ),
  )
})
