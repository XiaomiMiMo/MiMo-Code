/**
 * Integration tests for T00: prove that all three runLoop classification sites
 * route through the shared `classifyAssistantStep` helper. Driven through a real
 * Session.prompt(...) against a scripted HTTP LLM stub (no API key required).
 *
 *  - Main path + existing-assistant top break: tool-call step continues, the
 *    final stop+text step exits the loop.
 *  - Main json_schema gate (prompt.ts:2132): a non-`continue` classification in
 *    json_schema mode writes StructuredOutputError and breaks.
 *  - Core guarantee at the gate: a tool call that finishes with finish_reason
 *    "stop" is still classified `continue` (pending client tool part wins over
 *    the json_schema gate), so the loop runs another step instead of breaking.
 *  - Fork json_schema gate (prompt.ts:2050): a fork agent (contextMode "full")
 *    driven with a json_schema request that returns plain text writes
 *    StructuredOutputError — proving the fork branch routes its own
 *    handle.message/parts/processResult through classifyAssistantStep.
 */

import path from "path"
import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ActorRegistry } from "../../src/actor/registry"
import { spawnRef } from "../../src/actor/spawn-ref"
import type { Actor } from "../../src/actor/spawn"
import { MessageID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  startScriptedLLMServer,
  toolCallResponse,
  toolCallStopResponse,
  textStopResponse,
  contentFilterResponse,
  otherFinishResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

// Additionally exposes ActorRegistry.Service. ActorRegistry.defaultLayer is the
// same singleton SessionPrompt.defaultLayer provides internally, so Effect's
// layer memoization hands back the exact instance runLoop reads.
function runFork<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service | ActorRegistry.Service>) {
  return Effect.runPromise(
    fx.pipe(
      Effect.scoped,
      Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, ActorRegistry.defaultLayer)),
    ),
  )
}

function writeConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: {
        alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } },
      },
      agent: { build: { model: "alibaba/qwen-plus" } },
    }),
  )
}

const JSON_SCHEMA = {
  type: "json_schema" as const,
  schema: { type: "object", properties: { answer: { type: "string" } }, required: ["answer"] },
  retryCount: 0,
}

describe("classifier routing — integration", () => {
  test("main path continues on tool-call, existing-assistant top break exits on final", async () => {
    await using tmp = await tmpdir({ git: true })
    const readmePath = path.join(tmp.path, "README.md")
    const stub = startScriptedLLMServer([
      { lines: toolCallResponse({ id: "call_0", name: "read", args: JSON.stringify({ file_path: readmePath }) }) },
      { lines: textStopResponse("done.") },
    ])
    try {
      await Bun.write(readmePath, "# Hello\n")
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-main" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Please read the README." }],
              })
              // Tool-call step => continue (2nd call); final stop+text => break.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "done.")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("main json_schema gate: non-continue classification writes StructuredOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: textStopResponse("plain text, not structured") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-json-gate" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "What is the answer?" }],
                format: JSON_SCHEMA,
              })
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("StructuredOutputError")
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("core guarantee at gate: tool-call finishing with stop still continues (no premature StructuredOutputError)", async () => {
    await using tmp = await tmpdir({ git: true })
    const readmePath = path.join(tmp.path, "README.md")
    const stub = startScriptedLLMServer([
      // Pending client tool part + finish_reason "stop": must continue despite
      // json_schema mode, instead of breaking with StructuredOutputError.
      { lines: toolCallStopResponse({ id: "call_0", name: "read", args: JSON.stringify({ file_path: readmePath }) }) },
      { lines: textStopResponse("plain text terminates the loop") },
    ])
    try {
      await Bun.write(readmePath, "# Hello\n")
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-core-guarantee" })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Read the README then answer." }],
                format: JSON_SCHEMA,
              })
              // If the core guarantee held, step 0 (tool-call + stop) was classified
              // `continue`, so a 2nd LLM call happened. A premature StructuredOutputError
              // would have broken the loop after a single call.
              expect(stub.captures.length).toBeGreaterThanOrEqual(2)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("content-filter (text format): writes ContentFilterError, no retry", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: contentFilterResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-content-filter" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Say something disallowed." }],
              })
              // Terminal on first occurrence — exactly one LLM call, no retry.
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("ContentFilterError")
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("content-filter (json_schema gate): writes ContentFilterError, not StructuredOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: contentFilterResponse() }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-content-filter-json" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer in the schema." }],
                format: JSON_SCHEMA,
              })
              // filtered must be handled BEFORE the json_schema gate, otherwise it
              // gets mislabeled as StructuredOutputError.
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("ContentFilterError")
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("other finish + non-empty text: degraded final, terminates cleanly without error", async () => {
    await using tmp = await tmpdir({ git: true })
    // Unrecognized finish_reason maps to unified "other"; with usable text the
    // classifier returns a degraded `final`. T03: this must terminate as a
    // (logged) final, NOT be misclassified as an error or loop forever.
    const stub = startScriptedLLMServer([{ lines: otherFinishResponse("usable answer despite an odd finish") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-other-finish" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer please." }],
              })
              // Exactly one call: degraded final breaks the loop, no retry/nudge.
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeUndefined()
                expect(result.info.finish).toBe("other")
              }
              expect(
                result.parts.some((p) => p.type === "text" && p.text === "usable answer despite an odd finish"),
              ).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("failed step (provider error): writes terminal error and stops, no infinite retry", async () => {
    await using tmp = await tmpdir({ git: true })
    // HTTP 400 is non-retryable: the stream errors, processor sets assistant.error,
    // and the classifier returns `failed`. T03: the loop must break with a
    // user-visible error rather than silently completing.
    const stub = startScriptedLLMServer([{ lines: [], status: 400 }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "classify-failed" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer please." }],
              })
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error).toBeDefined()
              }
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("fork json_schema gate (prompt.ts:2050): fork agent + plain text + json_schema writes StructuredOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: textStopResponse("plain text from a fork agent") }])
    const forkActorID = "explore-fork-1"
    const prevSpawnRef = spawnRef.current
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          runFork(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const registry = yield* ActorRegistry.Service
              const session = yield* sessions.create({ title: "classify-fork-gate" })

              // Register the fork actor: contextMode "full" + mode "subagent" is
              // exactly what runLoop's `isForkAgent` check requires.
              yield* registry.register({
                sessionID: session.id,
                actorID: forkActorID,
                mode: "subagent",
                agent: "build",
                description: "fork gate test",
                contextMode: "full",
                background: false,
                lifecycle: "ephemeral",
              })

              // The fork branch reads its frozen snapshot via spawnRef.getForkContext.
              // Stub the module singleton so the branch finds a valid ForkContext
              // (watermark precedes the user message prompt() will create).
              const watermarkMsgID = MessageID.ascending()
              const forkCtx: Actor.ForkContext = {
                system: ["fork-system-prompt"],
                tools: {},
                inheritedMessages: [],
                parentPermission: [],
                watermarkMsgID,
                model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
              }
              spawnRef.current = {
                getForkContext: (id: string) => Effect.succeed(id === forkActorID ? forkCtx : undefined),
                spawn: () => Effect.die("spawn not used in fork-gate test"),
                cancel: () => Effect.die("cancel not used in fork-gate test"),
              } as unknown as NonNullable<typeof spawnRef.current>

              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: forkActorID,
                parts: [{ type: "text", text: "Answer in the requested schema." }],
                format: JSON_SCHEMA,
              })

              // Prove we went through the FORK branch, not the main path: the fork
              // branch sends `forkCtx.system` verbatim as the request system, whereas
              // the main path would build the full system prompt. Without this guard
              // a non-shared ActorRegistry instance (isForkAgent=false) would fall to
              // the main gate and also write StructuredOutputError — a false pass.
              const systemMsg = stub.captures[0]?.messages.find((m) => m.role === "system")
              expect(JSON.stringify(systemMsg?.content ?? "")).toContain("fork-system-prompt")

              // Reaching prompt.ts:2050 in the fork branch: classifier returns a
              // non-`continue` result for the plain-text stop, and json_schema mode
              // makes the fork gate write StructuredOutputError.
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("StructuredOutputError")
              }
            }),
          ),
      })
    } finally {
      spawnRef.current = prevSpawnRef
      await stub.stop()
    }
  })

  test("fork json_schema gate: content-filter writes ContentFilterError, not StructuredOutputError", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: contentFilterResponse() }])
    const forkActorID = "explore-fork-cf"
    const prevSpawnRef = spawnRef.current
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          runFork(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const registry = yield* ActorRegistry.Service
              const session = yield* sessions.create({ title: "classify-fork-content-filter" })

              yield* registry.register({
                sessionID: session.id,
                actorID: forkActorID,
                mode: "subagent",
                agent: "build",
                description: "fork content-filter test",
                contextMode: "full",
                background: false,
                lifecycle: "ephemeral",
              })

              const watermarkMsgID = MessageID.ascending()
              const forkCtx: Actor.ForkContext = {
                system: ["fork-system-prompt"],
                tools: {},
                inheritedMessages: [],
                parentPermission: [],
                watermarkMsgID,
                model: { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") },
              }
              spawnRef.current = {
                getForkContext: (id: string) => Effect.succeed(id === forkActorID ? forkCtx : undefined),
                spawn: () => Effect.die("spawn not used in fork content-filter test"),
                cancel: () => Effect.die("cancel not used in fork content-filter test"),
              } as unknown as NonNullable<typeof spawnRef.current>

              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: forkActorID,
                parts: [{ type: "text", text: "Answer in the requested schema." }],
                format: JSON_SCHEMA,
              })

              // Prove we went through the FORK branch (see sibling fork test).
              const systemMsg = stub.captures[0]?.messages.find((m) => m.role === "system")
              expect(JSON.stringify(systemMsg?.content ?? "")).toContain("fork-system-prompt")

              // filtered handled before the fork json_schema gate ⇒ ContentFilterError.
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") {
                expect(result.info.error?.name).toBe("ContentFilterError")
              }
            }),
          ),
      })
    } finally {
      spawnRef.current = prevSpawnRef
      await stub.stop()
    }
  })
})
