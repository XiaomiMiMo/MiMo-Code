import { expect } from "bun:test"
import path from "node:path"
import { Effect, Layer } from "effect"
import { z } from "zod"
import type { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { raw, TestLLMServer } from "../lib/llm-server"

const it = testEffect(
  Layer.mergeAll(Session.defaultLayer, SessionPrompt.defaultLayer, CrossSpawnSpawner.defaultLayer, TestLLMServer.layer),
)
const opaque = " first message state \t"
const signatures = [" first call signature \t", " second call signature \t"]
const readable = "This is ordinary readable reasoning."
const unknown = "unrecognized_fixture_extension"

function config(url: string): Partial<Config.Info> {
  const model = {
    reasoning: true,
    interleaved: { field: "reasoning_content" as const },
    limit: { context: 64_000, output: 4_000 },
  }
  // Leave npm unset: an unrecognized provider ID must select the bundled compatible adapter by default.
  const provider = { options: { apiKey: "test-key", baseURL: url }, models: { model, alternate: model } }
  return {
    model: "test/model",
    enabled_providers: ["test", "other"],
    provider: { test: provider, other: provider },
    permission: { read: "allow" },
    checkpoint: { thresholds: [] },
  }
}

function chunk(delta: Record<string, unknown>, finish_reason: string | null = null) {
  return { id: "chatcmpl-test", object: "chat.completion.chunk", choices: [{ delta, finish_reason }] }
}

function readCall(index: number, id: string, signature?: string) {
  return {
    index,
    id,
    type: "function",
    function: { name: "read", arguments: JSON.stringify({ file_path: `${id}.txt` }) },
    ...(signature && { extra_content: { google: { thought_signature: signature, [unknown]: true }, [unknown]: true } }),
  }
}

const wireMessages = z.array(
  z.looseObject({
    role: z.string(),
    tool_call_id: z.string().optional(),
    tool_calls: z.array(z.looseObject({ id: z.string() })).optional(),
  }),
)

function messages(body: Record<string, unknown>) {
  return wireMessages.parse(body.messages)
}

function checkHistory(body: Record<string, unknown>, sameOrigin: boolean, includeSerial: boolean) {
  const history = messages(body)
  const assistants = history.filter((m) => m.role === "assistant" && m.tool_calls?.length)
  expect(assistants.map((m) => m.tool_calls!.map((call) => call.id))).toEqual(
    includeSerial ? [["signed", "neighbor"], ["serial"]] : [["signed", "neighbor"]],
  )
  if (sameOrigin) expect(assistants[0].reasoning_opaque).toBe(opaque)
  for (const m of history) {
    if (!sameOrigin || m !== assistants[0]) expect(m).not.toHaveProperty("reasoning_opaque")
  }

  const calls = assistants.flatMap((m) => m.tool_calls!)
  for (const call of calls) {
    if (sameOrigin && call.id !== "neighbor") {
      const signature = signatures[call.id === "signed" ? 0 : 1]
      expect(call.extra_content).toEqual({ google: { thought_signature: signature } })
    } else expect(call).not.toHaveProperty("extra_content")
  }
  const results = history.filter((m) => m.role === "tool")
  expect(results).toHaveLength(calls.length)
  expect(new Set(results.map((m) => m.tool_call_id))).toEqual(new Set(calls.map((call) => call.id)))
  for (const result of results) expect(result.content).toContain(`payload for ${result.tool_call_id}`)

  const json = JSON.stringify(body)
  expect(json).not.toContain(unknown)
  expect(json).not.toContain("superseded-state")
  expect(json.split(JSON.stringify(opaque)).length - 1).toBe(sameOrigin ? 1 : 0)
  for (const [idx, signature] of signatures.entries()) {
    expect(json.split(JSON.stringify(signature)).length - 1).toBe(sameOrigin && (idx === 0 || includeSerial) ? 1 : 0)
  }
}

it.live(
  "replays compatible message and per-call state on the next request and after restoring history, only for the originating provider/model",
  () =>
    provideTmpdirServer(
      ({ dir, llm }) =>
        Effect.gen(function* () {
          for (const id of ["neighbor", "signed", "serial"]) {
            yield* Effect.promise(() => Bun.write(path.join(dir, `${id}.txt`), `payload for ${id}`))
          }
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const chat = yield* sessions.create({ title: "Signature replay" })
          const ask = (sessionID: typeof chat.id, modelRef: string, text: string) =>
            prompt.prompt({
              sessionID,
              agent: "build",
              harness: "default",
              modelRef,
              parts: [{ type: "text", text }],
            })

          yield* llm.reason(readable, { text: "Ready." })
          yield* ask(chat.id, "test/model", "Start with a plain reply.")
          yield* llm.push(
            raw({
              chunks: [
                chunk({ role: "assistant", content: null, reasoning_opaque: "superseded-state" }),
                chunk({ reasoning_opaque: opaque, [unknown]: true }),
                chunk({ reasoning_opaque: "" }),
                chunk({ reasoning_opaque: null }),
                chunk({ reasoning_opaque: 42 }),
                chunk({ tool_calls: [readCall(0, "signed", signatures[0]), readCall(1, "neighbor")] }),
                chunk({}, "tool_calls"),
              ],
            }),
            raw({
              chunks: [
                chunk({ role: "assistant", tool_calls: [readCall(0, "serial", signatures[1])] }),
                chunk({}, "tool_calls"),
              ],
            }),
          )
          yield* llm.text("All files read.")
          yield* ask(chat.id, "test/model", "Read the three files.")
          const inputs = yield* llm.inputs
          expect(inputs).toHaveLength(4)
          expect(messages(inputs[1]).filter((m) => m.role === "assistant")).toMatchObject([
            { content: "Ready.", reasoning_content: readable },
          ])
          expect(JSON.stringify(inputs[1].messages)).not.toContain("reasoning_opaque")
          expect(JSON.stringify(inputs[1].messages)).not.toContain("thought_signature")

          const stored = (yield* sessions.messages({ sessionID: chat.id })).flatMap((m) => m.parts)
          expect(stored.filter((p) => p.type === "reasoning").map((p) => p.text)).toEqual([readable])
          const signedCall = stored.find((p) => p.type === "tool" && p.callID === "signed")
          expect(signedCall).toBeDefined()
          expect(stored.filter((p) => "reasoningOpaque" in p)).toMatchObject([
            { type: "step-finish", messageID: signedCall!.messageID, reasoningOpaque: opaque },
          ])
          expect(JSON.stringify(stored)).not.toContain(unknown)

          // A new session per origin starts from copied database history, not the live stream or the prior request.
          for (const modelRef of ["other/model", "test/alternate", "test/model"]) {
            const branch = yield* sessions.fork({ sessionID: chat.id })
            yield* llm.text("Finished.")
            const result = yield* ask(branch.id, modelRef, "Continue from the saved conversation.")
            const [providerID, modelID] = modelRef.split("/")
            expect(result.info).toMatchObject({ role: "assistant", providerID, modelID })
            const hit = (yield* llm.hits).at(-1)!
            expect(hit.url.pathname).toBe("/v1/chat/completions")
            expect(hit.body.model).toBe(modelID)
            checkHistory(hit.body, modelRef === "test/model", true)
          }

          checkHistory(inputs[2], true, false)
          checkHistory(inputs[3], true, true)
        }),
      { git: true, config },
    ),
  30_000,
)
