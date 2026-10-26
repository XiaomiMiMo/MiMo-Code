import path from "path"
import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Permission } from "../../src/permission"
import { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Session } from "../../src/session"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import { usable } from "../../src/session/overflow"
import { SessionPrompt } from "../../src/session/prompt"
import type { SessionID } from "../../src/session/schema"
import { PartTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Log } from "../../src/util"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { startScriptedLLMServer } from "../lib/scripted-llm-server"

void Log.init({ print: false })

const it = testEffect(
  Layer.mergeAll(
    SessionPrompt.defaultLayer,
    Session.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    Permission.defaultLayer,
  ),
)

const FILES = 8
const HIGH_USAGE = 260_000

function sse(delta: Record<string, unknown>, finish?: string, usage?: number) {
  return `data: ${JSON.stringify({
    id: "chatcmpl-lossless",
    object: "chat.completion.chunk",
    choices: [{ delta, ...(finish ? { finish_reason: finish } : {}) }],
    ...(usage ? { usage: { prompt_tokens: usage, completion_tokens: 1, total_tokens: usage + 1 } } : {}),
  })}\n\n`
}

function step(input: { reasoning: string; text?: string; reads?: number; usage?: number }) {
  const calls = Array.from({ length: input.reads ?? 0 }, (_, index) => [
    sse({ tool_calls: [{ index, id: `read-${index}`, type: "function", function: { name: "read", arguments: "" } }] }),
    sse({ tool_calls: [{ index, function: { arguments: JSON.stringify({ file_path: `file-${index}.txt` }) } }] }),
  ]).flat()
  return {
    lines: [
      sse({ role: "assistant" }),
      sse({ reasoning_content: input.reasoning }),
      ...(input.text ? [sse({ content: input.text })] : []),
      ...calls,
      sse({}, calls.length ? "tool_calls" : "stop", input.usage),
      "data: [DONE]\n\n",
    ],
  }
}

function config(origin: string): Partial<Config.Info> {
  return {
    enabled_providers: ["test"],
    model: "test/model",
    provider: {
      test: {
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          model: {
            name: "Test",
            tool_call: true,
            reasoning: true,
            limit: { context: 400_000, output: 10_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { edit: "allow", bash: "allow", read: "allow" },
    checkpoint: { thresholds: ["50%"] },
    lsp: false,
    formatter: false,
  }
}

function storedParts(sessionID: SessionID) {
  return Database.use((db) =>
    db.select({ id: PartTable.id, data: PartTable.data }).from(PartTable).where(eq(PartTable.session_id, sessionID)).all(),
  )
}

it.live(
  "a resumed main session with the legacy compaction.prune opt-in keeps every stored tool output and reasoning part",
  () =>
    Effect.gen(function* () {
      const server = startScriptedLLMServer([
        step({ reasoning: "plan: read every file", reads: FILES }),
        step({ reasoning: "all files are read", text: "read all files" }),
        step({ reasoning: "second turn thinking", text: "two" }),
        step({ reasoning: "third turn thinking", text: "three" }),
        step({ reasoning: "fourth turn thinking", text: "four" }),
        step({ reasoning: "fifth turn thinking", text: "five", usage: HIGH_USAGE }),
        step({ reasoning: "final turn thinking", text: "six" }),
      ])
      yield* Effect.addFinalizer(() => Effect.promise(() => server.stop()))
      yield* provideTmpdirInstance(
        (dir) =>
          Effect.gen(function* () {
            // A user config written before this change opts in to the removed turn-end prune.
            const configFile = path.join(dir, "mimocode.json")
            const written = yield* Effect.promise(() => Bun.file(configFile).json())
            yield* Effect.promise(() =>
              Bun.write(configFile, JSON.stringify({ ...written, compaction: { prune: true } })),
            )
            for (let index = 0; index < FILES; index++) {
              const body = Array.from({ length: 45 }, (_, line) => `file ${index} line ${line} `.padEnd(1000, "x")).join(
                "\n",
              )
              yield* Effect.promise(() => Bun.write(path.join(dir, `file-${index}.txt`), body))
            }
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const session = yield* sessions.create({ title: "Lossless turn end" })
            for (const text of ["read the files", "turn two", "turn three", "turn four", "turn five"])
              yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text }] })

            const history = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            const reads = history
              .flatMap((message) => message.parts)
              .filter((part) => part.type === "tool" && part.tool === "read" && part.state.status === "completed")
            expect(reads).toHaveLength(FILES)
            const reasoning = history.flatMap((message) => message.parts).filter((part) => part.type === "reasoning")
            expect(reasoning.length).toBeGreaterThanOrEqual(6)

            // The session is resumed after its prompt cache expired, with usage in the former level-2 band.
            const last = history.findLast((message) => message.info.role === "assistant")!
            if (last.info.role !== "assistant") throw new Error("expected an assistant message")
            expect(last.info.tokens.input).toBeGreaterThanOrEqual(HIGH_USAGE)
            yield* sessions.updateMessage({
              ...last.info,
              time: { ...last.info.time, completed: Date.now() - 86_400_000 },
            })
            const cfg = yield* Config.Service.use((svc) => svc.get())
            const model = yield* Provider.Service.use((svc) =>
              svc.getModel(ProviderID.make("test"), ModelID.make("model")),
            )
            const ratio = HIGH_USAGE / usable({ cfg, model })
            expect(ratio).toBeGreaterThanOrEqual(0.7)
            expect(ratio).toBeLessThan(0.85)

            const ids = new Set([...reads, ...reasoning].map((part) => part.id))
            const before = storedParts(session.id).filter((row) => ids.has(row.id))
            expect(before).toHaveLength(ids.size)
            expect(yield* Effect.promise(() => Bun.file(checkpointPath(session.id)).exists())).toBe(false)

            yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "turn six" }] })
            // The removed prune ran in a fiber forked after the reply; the wait lets a reintroduced one touch the database.
            yield* Effect.sleep("1 second")

            const after = new Map(storedParts(session.id).map((row) => [row.id, row.data]))
            const changed = before
              .filter((row) => !Bun.deepEquals(after.get(row.id), row.data))
              .map((row) => ({ id: row.id, type: row.data.type, after: after.get(row.id) }))
            expect(changed).toEqual([])
            // Usage crossed the 50% checkpoint threshold, so the checkpoint writer started.
            expect(yield* Effect.promise(() => Bun.file(checkpointPath(session.id)).exists())).toBe(true)
          }),
        { git: true, config: config(server.origin) },
      )
    }),
  60_000,
)
