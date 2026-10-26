import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session as SessionNs } from "../../src/session"
import { readRebuildTail, withRebuildTail } from "../../src/session/checkpoint"
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

const it = testEffect(Layer.mergeAll(SessionNs.defaultLayer, CrossSpawnSpawner.defaultLayer))

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

const T0 = 1_700_000_000_000
const BASH_OUTPUT = Array.from({ length: 400 }, (_, i) => `bash tail line ${i}`).join("\n")
const READ_OUTPUT = Array.from({ length: 400 }, (_, i) => `read tail line ${i}`).join("\n")
const LIVE_OUTPUT = Array.from({ length: 50 }, (_, i) => `live read line ${i}`).join("\n")
const INDEX_TEXT = "## Checkpoint\n\nDirectory: /tmp/checkpoint/\n"
const REBUILD_TEXT = [
  "# Session checkpoint",
  "",
  "prior summary",
  "",
  "# Recent user input (verbatim)",
  "",
  "run the checks",
  "now summarize",
  "",
  "# Recent activity",
  "",
  "- assistant: running checks",
  '- bash(command="bun test")',
  '- read(file_path="report.txt")',
  "- assistant: checks passed",
  "- assistant: summary follows",
  "",
  "This session is continued from a checkpoint.",
].join("\n")

describe("legacy rebuild boundary golden request", () => {
  it.live(
    "renders a boundary stamped at watermark + 1 ms with its assistant tail collapsed and its users live",
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* SessionNs.Service
        const info = yield* sessions.create({})
        const sessionID = info.id

        const user = Effect.fn("GoldenTest.user")(function* (time: number, text: string) {
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "user",
            sessionID,
            agent: "build",
            model: ref,
            time: { created: time },
          })
          yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
          return msg
        })
        const assistant = Effect.fn("GoldenTest.assistant")(function* (
          time: number,
          parentID: MessageID,
          finish: string,
          text: string,
          tools: { callID: string; tool: string; input: Record<string, unknown>; output: string }[] = [],
        ) {
          const msg = yield* sessions.updateMessage({
            id: MessageID.ascending(),
            role: "assistant",
            sessionID,
            agent: "build",
            parentID,
            providerID: ref.providerID,
            modelID: ref.modelID,
            mode: "build",
            path: { cwd: "/tmp/example", root: "/tmp/example" },
            cost: 0,
            finish,
            tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
            time: { created: time, completed: time + 1 },
          })
          yield* sessions.updatePart({ id: PartID.ascending(), messageID: msg.id, sessionID, type: "text", text })
          for (const tool of tools)
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: msg.id,
              sessionID,
              type: "tool",
              callID: tool.callID,
              tool: tool.tool,
              state: {
                status: "completed",
                input: tool.input,
                output: tool.output,
                title: tool.tool,
                metadata: {},
                time: { start: time, end: time + 1 },
              },
            })
          return msg
        })

        const u1 = yield* user(T0, "start the task")
        const watermark = yield* assistant(T0 + 10, u1.id, "stop", "starting")
        const u2 = yield* user(T0 + 20, "run the checks")
        yield* assistant(T0 + 30, u2.id, "tool-calls", "running checks", [
          { callID: "call-bash", tool: "bash", input: { command: "bun test" }, output: BASH_OUTPUT },
          { callID: "call-read", tool: "read", input: { file_path: "report.txt" }, output: READ_OUTPUT },
        ])
        yield* assistant(T0 + 40, u2.id, "stop", "checks passed")
        const u3 = yield* user(T0 + 50, "now summarize")
        const newest = yield* assistant(T0 + 60, u3.id, "stop", "summary follows")

        const boundary = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID,
          agent: "build",
          model: ref,
          time: { created: watermark.time.created + 1 },
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: boundary.id,
          sessionID,
          type: "checkpoint",
          checkpointDir: "",
          checkpointNumber: 0,
          coveredUpTo: watermark.id,
          digestUpTo: newest.id,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: boundary.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: INDEX_TEXT,
        })
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: boundary.id,
          sessionID,
          type: "text",
          synthetic: true,
          text: REBUILD_TEXT,
        })

        const u4 = yield* user(T0 + 100, "after rebuild")
        yield* assistant(T0 + 110, u4.id, "tool-calls", "live reply", [
          { callID: "call-live", tool: "read", input: { file_path: "live.txt" }, output: LIVE_OUTPUT },
        ])

        const window = yield* MessageV2.filterCompactedEffect(sessionID, { agentID: "main" })
        const rendered = yield* Effect.promise(() =>
          MessageV2.toModelMessages(window, model, { collapseCheckpointTail: true }),
        )
        expect(rendered).toEqual([
          {
            role: "user",
            content: [
              { type: "text", text: "Summary of previous conversation from checkpoint files:" },
              { type: "text", text: INDEX_TEXT },
              { type: "text", text: REBUILD_TEXT },
            ],
          },
          { role: "user", content: [{ type: "text", text: "run the checks" }] },
          { role: "user", content: [{ type: "text", text: "now summarize" }] },
          { role: "user", content: [{ type: "text", text: "after rebuild" }] },
          {
            role: "assistant",
            content: [
              { type: "text", text: "live reply" },
              { type: "tool-call", toolCallId: "call-live", toolName: "read", input: { file_path: "live.txt" } },
            ],
          },
          {
            role: "tool",
            content: [
              {
                type: "tool-result",
                toolCallId: "call-live",
                toolName: "read",
                output: { type: "text", value: LIVE_OUTPUT },
              },
            ],
          },
        ])
        // The legacy tail is already inside the window, so the checkpoint writer reads it unchanged.
        expect(withRebuildTail(window, readRebuildTail(sessionID, window))).toBe(window)
        expect(window.map((message) => message.info.id)).toContain(newest.id)
      }),
    ),
  )
})
