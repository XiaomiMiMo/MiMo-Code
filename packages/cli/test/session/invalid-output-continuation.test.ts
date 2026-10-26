/**
 * Integration tests for T01: a `finish=stop` step with no usable output
 * (think-only = reasoning only, or empty = nothing at all) must not silently
 * break into an empty assistant. process() drops the empty turn and raises
 * InvalidOutputError so SessionRetry.policy (decide → persistent server budget)
 * owns the retry; it keeps retrying until usable output or cancellation.
 * No reminder message is injected.
 *
 * Driven through a real Session.prompt(...) against the scripted HTTP LLM stub.
 */

import path from "path"
import { afterEach, describe, expect, spyOn, test } from "bun:test"
import { Effect, Fiber, Layer } from "effect"
import { Bus } from "../../src/bus"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import {
  startScriptedLLMServer,
  textStopResponse,
  toolCallResponse,
  emptyStopResponse,
  reasoningLengthResponse,
  reasoningStopResponse,
} from "../lib/scripted-llm-server"

void Log.init({ print: false })

function assistantOnly(
  msgs: MessageV2.WithParts[],
): (MessageV2.WithParts & { info: MessageV2.Assistant })[] {
  return msgs.filter((m): m is MessageV2.WithParts & { info: MessageV2.Assistant } => m.info.role === "assistant")
}

function retryParts(msgs: MessageV2.WithParts[]): MessageV2.RetryPart[] {
  return msgs.flatMap((m) => m.parts.filter((p): p is MessageV2.RetryPart => p.type === "retry"))
}

// The retry must resend the first attempt's history unchanged: no injected reminder.
function nonSystemMessages(capture: { messages: unknown }) {
  return (capture.messages as { role: string; content: unknown }[]).filter((m) => m.role !== "system")
}

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
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
      agent: {
        build: { model: "alibaba/qwen-plus" },
        "checkpoint-writer": { model: "alibaba/qwen-plus" },
      },
      // Empty/think-only output retries under the persistent server budget; the
      // bounded unknown budget stays configured to prove it no longer applies.
      retry: {
        server: { initialDelayMs: 1, maxDelayMs: 1 },
        unknown: { maxRetries: 1, initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 2000 },
      },
    }),
  )
}

// Every retry waits a minute, so a step that finishes quickly after a retry
// proves it gave way instead of sleeping through the backoff.
function writeSlowRetryConfig(dir: string, origin: string) {
  const slow = { initialDelayMs: 60_000, maxDelayMs: 60_000, jitterRatio: 0 }
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${origin}/v1` } } },
      agent: { build: { model: "alibaba/qwen-plus" } },
      retry: {
        request: { ...slow, mode: "bounded", maxRetries: 5, noDeadline: true },
        network: slow,
        server: slow,
        rateLimit: slow,
        stream: slow,
        unknown: slow,
      },
    }),
  )
}

function waitFor(condition: () => boolean) {
  return Effect.promise(async () => {
    while (!condition()) await Bun.sleep(10)
  }).pipe(Effect.timeout("10 seconds"))
}

function writeGPTConfig(dir: string, origin: string) {
  return Bun.write(
    path.join(dir, "mimocode.json"),
    JSON.stringify({
      $schema: "https://opencode.ai/config.json",
      enabled_providers: ["test"],
      provider: {
        test: {
          name: "Test",
          id: "test",
          env: [],
          npm: "@ai-sdk/openai-compatible",
          models: {
            "gpt-5.5": {
              id: "gpt-5.5",
              name: "GPT-5.5",
              attachment: false,
              reasoning: true,
              temperature: false,
              tool_call: true,
              release_date: "2026-01-01",
              limit: { context: 100_000, output: 10_000 },
              cost: { input: 0, output: 0 },
              options: {},
            },
          },
          options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        },
      },
      agent: { build: { model: "test/gpt-5.5" } },
    }),
  )
}

describe("invalid-output continuation — integration", () => {
  // [TP-SR-R21-07]
  test("empty stop is dropped and retried inside process; cancel after settle is clean", async () => {
    await using tmp = await tmpdir({ git: true })
    // First sample is empty (dropped + retried inside process via SessionRetry);
    // second sample is the recovered answer. advance() hangs after the successful
    // step completes so cancel runs against a durable finished turn.
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("recovered answer") }])
    const entered = Promise.withResolvers<void>()
    const advance = spyOn(SessionPrefixSnapshot, "advance").mockImplementation(() =>
      Effect.sync(entered.resolve).pipe(Effect.andThen(Effect.never)),
    )
    try {
      await writeConfig(tmp.path, stub.origin)
      const result = await Instance.provide({
        directory: tmp.path,
        fn: () => run(Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "empty-stop-cancel-window" })
          const fiber = yield* prompt.prompt({
            sessionID: session.id, agent: "build", parts: [{ type: "text", text: "Answer my question." }],
          }).pipe(Effect.exit, Effect.forkChild)
          yield* Effect.promise(() => entered.promise).pipe(Effect.timeout("10 seconds"))
          expect(advance).toHaveBeenCalledTimes(1)
          const atBarrier = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
          yield* prompt.cancel(session.id)
          yield* Fiber.join(fiber)
          advance.mockRestore()
          const afterCancel = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
          return { atBarrier, afterCancel, providerCalls: stub.captures.length }
        })),
      })
      // Cancelling at the barrier, before the run reached its success exit, changes
      // nothing: the retry record of the recovered step stays.
      expect(retryParts(result.atBarrier)).toHaveLength(1)
      expect(result.afterCancel).toEqual(result.atBarrier)
      const assistants = assistantOnly(result.afterCancel)
      expect(assistants.length).toBe(1)
      const assistant = assistants[0]!
      expect(assistant.info.finish).toBe("stop")
      expect(assistant.info.time.completed).toBeDefined()
      expect(assistant.info.error).toBeUndefined()
      // Empty attempt was dropped inside process; only the recovered turn remains.
      expect(assistant.parts.some((part) => part.type === "text" && part.text === "recovered answer")).toBe(true)
      expect(result.providerCalls).toBe(2)
    } finally {
      advance.mockRestore()
      await Instance.disposeAll()
      await stub.stop()
    }
  }, 30_000)

  test("empty stop step is deleted and retried, second call produces a non-empty final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }, { lines: textStopResponse("final answer") }])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-empty" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              // First empty stop => delete + retry; second call => final text.
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants[0]?.info.id).toBe(result.info.id)
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  // 空回合丢弃必须重置内容而不是删除身份：先删再用同一 ID 重建的事件序列
  // 与「已删实体的迟到帧」完全同形，按事件顺序判定的下游只能按删除处理，
  // 重试后的正文就永久不再出现（切会话也补不回来，只有重启换新中心才恢复）。
  test("dropping an empty turn keeps the assistant message identity", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      const observed = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "empty-turn-identity" })
              const removedMessages: string[] = []
              const unsubscribe = Bus.subscribe(MessageV2.Event.Removed, (event) => {
                if (event.properties.sessionID !== session.id) return
                removedMessages.push(event.properties.messageID)
              })
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.ensuring(Effect.sync(unsubscribe)))
              const messages = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              return { messages, removedMessages }
            }),
          ),
      })
      const assistants = assistantOnly(observed.messages)
      expect(assistants.length).toBe(1)
      const assistant = assistants[0]!
      // 身份保留：空回合重置后重试写入的仍是同一条 assistant，删除事实不指向它。
      expect(observed.removedMessages).not.toContain(assistant.info.id)
      expect(observed.removedMessages).toEqual([])
      // 内容重置：空回合的 reasoning 不残留，最终只有重试后的正文。
      expect(assistant.parts.some((part) => part.type === "text" && part.text === "final answer")).toBe(true)
      expect(assistant.parts.some((part) => part.type === "reasoning")).toBe(false)
    } finally {
      await stub.stop()
    }
  })

  test("think-only (reasoning only) stop step is deleted and retried, second call produces a final assistant", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-think-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants.some((m) => m.parts.some((p) => p.type === "reasoning"))).toBe(false)
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("ordinary actor retry deletes the empty turn and injects no reminder", async () => {
    await using tmp = await tmpdir({ git: true })
    let readRecord: (() => MessageV2.RetryPart[]) | undefined
    let midTurn: MessageV2.RetryPart[] = []
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: textStopResponse("actor result"), beforeReply: async () => { midTurn = readRecord?.() ?? [] } },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-actor" })
              readRecord = () => retryParts(MessageV2.page({ sessionID: session.id, limit: 50, agentID: "general-1" }).items)
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Do delegated work." }],
              })
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("no usable"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "general-1" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants.some((m) => m.info.error)).toBe(false)
              // The actor's own assistant carried the retry record while retrying.
              expect(midTurn).toHaveLength(1)
              expect(midTurn[0]).toMatchObject({ messageID: assistants[0]?.info.id, attempt: 1, message: "empty output" })
              expect(retryParts(msgs)).toEqual([])
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("checkpoint-writer retry deletes the empty turn and converges on CHECKPOINT_COMPLETE", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: textStopResponse("CHECKPOINT_COMPLETE") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-checkpoint-writer" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "checkpoint-writer",
                parts: [{ type: "text", text: "Update the checkpoint." }],
              })
              const retry = stub.captures[1].messages as { role: string; content: unknown }[]
              const nonSystem = retry.filter((m) => m.role !== "system")
              expect(nonSystem.length).toBe(1)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("checkpoint writer turn ended"))).toBe(false)
              expect(nonSystem.some((m) => JSON.stringify(m.content).includes("CHECKPOINT_COMPLETE"))).toBe(false)
              expect(nonSystem).toEqual(nonSystemMessages(stub.captures[0]))
              expect(result.parts.some((part) => part.type === "text" && part.text === "CHECKPOINT_COMPLETE")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("consecutive empty stops keep retrying past the bounded unknown budget and recover", async () => {
    await using tmp = await tmpdir({ git: true })
    // Read the live retry record while the third attempt is in flight, before the
    // turn succeeds: it must exist on the main assistant with the latest attempt.
    let readRecord: (() => MessageV2.RetryPart[]) | undefined
    let midTurn: MessageV2.RetryPart[] = []
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: emptyStopResponse() },
      { lines: emptyStopResponse(), beforeReply: async () => { midTurn = readRecord?.() ?? [] } },
      { lines: textStopResponse("recovered after empties") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-persistent" })
              readRecord = () => retryParts(MessageV2.page({ sessionID: session.id, limit: 50 }).items)
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(4)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "text" && p.text === "recovered after empties")).toBe(true)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants.length).toBe(1)
              expect(assistants[0]?.info.id).toBe(result.info.id)
              expect(midTurn).toHaveLength(1)
              expect(midTurn[0]).toMatchObject({ messageID: result.info.id, attempt: 2, kind: "server", message: "empty output" })
              // The turn succeeded: the retry record is cleared and never reached the model.
              expect(retryParts(msgs)).toEqual([])
              for (const capture of stub.captures) expect(JSON.stringify(capture.messages)).not.toContain("empty output")
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("cancel ends an endless empty-output retry with an aborted error and keeps the retry record", async () => {
    await using tmp = await tmpdir({ git: true })
    const reached = Promise.withResolvers<void>()
    let calls = 0
    const stub = startScriptedLLMServer([
      {
        lines: emptyStopResponse(),
        beforeReply: async () => {
          calls++
          if (calls === 5) reached.resolve()
        },
      },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      const outcome = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-persistent-cancel" })
              const fiber = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.exit, Effect.forkChild)
              yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("10 seconds"))
              yield* prompt.cancel(session.id)
              yield* Fiber.join(fiber)
              const settled = stub.captures.length
              yield* Effect.sleep("200 millis")
              const assistants = assistantOnly(yield* sessions.messages({ sessionID: session.id, agentID: "main" }))
              return { settled, after: stub.captures.length, assistants }
            }),
          ),
      })
      expect(outcome.settled).toBeGreaterThan(2)
      expect(outcome.after).toBe(outcome.settled)
      expect(outcome.assistants.length).toBe(1)
      expect(outcome.assistants[0]?.info.error?.name).toBe("MessageAbortedError")
      const kept = retryParts(outcome.assistants)
      expect(kept).toHaveLength(1)
      expect(kept[0]).toMatchObject({ messageID: outcome.assistants[0]?.info.id, kind: "server", message: "empty output" })
      expect(kept[0]!.attempt).toBeGreaterThanOrEqual(outcome.settled - 1)
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a bounded budget that runs out keeps the retry record next to the terminal error", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([{ lines: emptyStopResponse() }])
    try {
      await Bun.write(
        path.join(tmp.path, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
          agent: { build: { model: "alibaba/qwen-plus" } },
          retry: { server: { mode: "bounded", maxRetries: 2, initialDelayMs: 1, maxDelayMs: 1, deadlineMs: 2000 } },
        }),
      )
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-bounded-record" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(3)
              if (result.info.role === "assistant") expect(result.info.error?.name).toBe("InvalidOutputError")
              const kept = retryParts(yield* sessions.messages({ sessionID: session.id, agentID: "main" }))
              expect(kept).toHaveLength(1)
              expect(kept[0]).toMatchObject({ messageID: result.info.id, attempt: 2, kind: "server", message: "empty output" })
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("a prompt queued while the recovered attempt streams waits for it and clears the record once both succeed", async () => {
    await using tmp = await tmpdir({ git: true })
    // The second prompt arrives after the recovered attempt already produced text:
    // the turn is no longer failing, so the prompt waits for the next step.
    const streaming = Promise.withResolvers<void>()
    const queued = Promise.withResolvers<void>()
    const [role, content, ...rest] = textStopResponse("first answer")
    const encoder = new TextEncoder()
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      {
        lines: [],
        stream: new ReadableStream<Uint8Array>({
          async start(ctrl) {
            ctrl.enqueue(encoder.encode(role!))
            ctrl.enqueue(encoder.encode(content!))
            streaming.resolve()
            await queued.promise
            for (const line of rest) ctrl.enqueue(encoder.encode(line))
            ctrl.close()
          },
        }),
      },
      { lines: textStopResponse("second answer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-queued-record" })
              const first = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "First question." }],
              }).pipe(Effect.forkChild)
              yield* Effect.promise(() => streaming.promise).pipe(Effect.timeout("10 seconds"))
              yield* Effect.promise(async () => {
                const streamed = () => assistantOnly(MessageV2.page({ sessionID: session.id, limit: 50 }).items)
                  .some((m) => m.parts.some((p) => p.type === "text"))
                while (!streamed()) await Bun.sleep(10)
              }).pipe(Effect.timeout("10 seconds"))
              const second = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Second question." }],
              }).pipe(Effect.forkChild)
              yield* Effect.sleep("200 millis")
              queued.resolve()
              yield* Fiber.join(first)
              yield* Fiber.join(second)
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              expect(stub.captures.length).toBe(3)
              expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "first answer"))).toBe(true)
              expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "second answer"))).toBe(true)
              expect(retryParts(msgs)).toEqual([])
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a turn cancelled between tool steps keeps its retry record", async () => {
    await using tmp = await tmpdir({ git: true })
    await Bun.write(path.join(tmp.path, "notes.txt"), "fixture notes")
    // The recorded step completes with tool-calls and no error; the run is then
    // cancelled while the next step is being prepared, before any assistant for
    // it exists. Nothing marks the turn as failed, so only a success-exit rule
    // keeps the record.
    const reached = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: toolCallResponse({ id: "call_0", name: "read", args: JSON.stringify({ filePath: path.join(tmp.path, "notes.txt") }) }) },
      { lines: textStopResponse("never delivered") },
    ])
    const advance = spyOn(SessionPrefixSnapshot, "advance").mockImplementation(() =>
      Effect.sync(reached.resolve).pipe(Effect.andThen(Effect.never)),
    )
    try {
      await writeConfig(tmp.path, stub.origin)
      const kept = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-cancel-between-steps" })
              const fiber = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Read the notes." }],
              }).pipe(Effect.exit, Effect.forkChild)
              yield* Effect.promise(() => reached.promise).pipe(Effect.timeout("10 seconds"))
              yield* prompt.cancel(session.id)
              yield* Fiber.join(fiber)
              advance.mockRestore()
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const recorded = assistantOnly(msgs).find((m) => m.parts.some((p) => p.type === "retry"))
              return { kept: retryParts(msgs), recorded: recorded?.info, calls: stub.captures.length }
            }),
          ),
      })
      expect(kept.calls).toBe(2)
      expect(kept.recorded).toMatchObject({ finish: "tool-calls" })
      expect(kept.recorded?.error).toBeUndefined()
      expect(kept.kept).toHaveLength(1)
      expect(kept.kept[0]).toMatchObject({ attempt: 1, kind: "server", message: "empty output" })
    } finally {
      advance.mockRestore()
      await stub.stop()
    }
  }, 30_000)

  test("request-phase provider errors record retries on the turn and still recover", async () => {
    await using tmp = await tmpdir({ git: true })
    const errorLines = [JSON.stringify({ error: { code: "model_not_found", type: "new_api_error", message: "No available channel for model test/model" } })]
    const stub = startScriptedLLMServer([
      { lines: errorLines, status: 503 },
      { lines: errorLines, status: 503 },
      { lines: textStopResponse("recovered after provider errors") },
    ])
    try {
      const fast = { initialDelayMs: 100, maxDelayMs: 100, jitterRatio: 0 }
      await Bun.write(
        path.join(tmp.path, "mimocode.json"),
        JSON.stringify({
          $schema: "https://opencode.ai/config.json",
          enabled_providers: ["alibaba"],
          provider: { alibaba: { options: { apiKey: "test-key", baseURL: `${stub.origin}/v1` } } },
          agent: { build: { model: "alibaba/qwen-plus" } },
          retry: {
            request: { ...fast, mode: "bounded", maxRetries: 2, noDeadline: true },
            network: { ...fast, mode: "bounded", maxRetries: 1, deadlineMs: 1 },
            server: fast,
            rateLimit: fast,
            stream: { ...fast, mode: "bounded", maxRetries: 0, noDeadline: true },
            unknown: fast,
          },
        }),
      )
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "request-retry-record" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.timeout("20 seconds"))
              expect(stub.captures.length).toBe(3)
              expect(result.parts.some((p) => p.type === "text" && p.text === "recovered after provider errors")).toBe(true)
              expect(retryParts(yield* sessions.messages({ sessionID: session.id, agentID: "main" }))).toEqual([])
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a retry-safe stream failure keeps the retry record and removes the failed attempt's parts", async () => {
    await using tmp = await tmpdir({ git: true })
    // Attempt 1: empty stop (records retry 1). Attempt 2: reasoning, then the
    // upstream reports a mid-stream read failure with no tool call, so the attempt
    // is retry-safe and goes through the failed-attempt cleanup. Attempt 3: the
    // recovered answer.
    const reasoning = `data: ${JSON.stringify({ id: "chatcmpl-stub", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant", reasoning_content: "half-finished-thought" } }] })}\n\n`
    const failure = `data: ${JSON.stringify({ error: { type: "upstream_error", message: "upstream stream read failed" } })}\n\n`
    let readRecord: (() => MessageV2.RetryPart[]) | undefined
    let beforeRecovery: MessageV2.RetryPart[] = []
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      { lines: [reasoning, failure] },
      { lines: textStopResponse("recovered after a dropped stream"), beforeReply: async () => { beforeRecovery = readRecord?.() ?? [] } },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "invalid-stream-drop-record" })
              readRecord = () => retryParts(MessageV2.page({ sessionID: session.id, limit: 50 }).items)
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.timeout("20 seconds"))
              expect(stub.captures.length).toBe(3)
              expect(result.parts.some((p) => p.type === "text" && p.text === "recovered after a dropped stream")).toBe(true)
              // The record survived the dropped attempt's cleanup and counted both retries.
              expect(beforeRecovery).toHaveLength(1)
              expect(beforeRecovery[0]).toMatchObject({ messageID: result.info.id, attempt: 2 })
              const msgs = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
              const assistants = assistantOnly(msgs)
              expect(assistants).toHaveLength(1)
              // No residue of the dropped attempt survives.
              expect(JSON.stringify(assistants[0]!.parts)).not.toContain("half-finished-thought")
              expect(retryParts(msgs)).toEqual([])
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a prompt sent while a retried attempt hangs supersedes the step and runs in the same turn", async () => {
    await using tmp = await tmpdir({ git: true })
    const hanging = Promise.withResolvers<void>()
    let readMain: (() => MessageV2.WithParts[]) | undefined
    let beforeAnswer: MessageV2.WithParts[] = []
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      {
        lines: textStopResponse("never delivered"),
        beforeReply: () => {
          hanging.resolve()
          return new Promise(() => {})
        },
      },
      { lines: textStopResponse("answer with the steer"), beforeReply: async () => { beforeAnswer = readMain?.() ?? [] } },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      const msgs = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "retry-superseded-by-steer" })
              readMain = () => MessageV2.page({ sessionID: session.id, limit: 50 }).items
              const first = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.forkChild)
              yield* Effect.promise(() => hanging.promise).pipe(Effect.timeout("10 seconds"))
              const steer = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Use this extra hint." }],
              }).pipe(Effect.forkChild)
              yield* Fiber.join(first).pipe(Effect.timeout("15 seconds"))
              yield* Fiber.join(steer).pipe(Effect.timeout("15 seconds"))
              return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            }),
          ),
      })
      expect(stub.captures.length).toBe(3)
      const request = JSON.stringify(stub.captures[2]!.messages)
      expect(request).toContain("Answer my question.")
      expect(request).toContain("Use this extra hint.")
      expect(request).not.toContain("empty output")
      // While the steered step ran, the superseded step still showed its retry record
      // as a completed, error-free assistant holding nothing else.
      const shell = assistantOnly(beforeAnswer).find((m) => m.parts.some((p) => p.type === "retry"))
      expect(shell?.parts).toHaveLength(1)
      expect(shell?.parts[0]).toMatchObject({ type: "retry", attempt: 1, kind: "server", message: "empty output" })
      expect(shell?.info.error).toBeUndefined()
      expect(shell?.info.time.completed).toBeDefined()
      // The turn succeeded: the record and its empty step are gone.
      const assistants = assistantOnly(msgs)
      expect(assistants).toHaveLength(1)
      expect(assistants[0]!.info.error).toBeUndefined()
      expect(assistants[0]!.parts.some((p) => p.type === "text" && p.text === "answer with the steer")).toBe(true)
      expect(retryParts(msgs)).toEqual([])
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a prompt sent during a request-phase retry wait supersedes the wait", async () => {
    await using tmp = await tmpdir({ git: true })
    const errorLines = [JSON.stringify({ error: { code: "model_not_found", type: "new_api_error", message: "No available channel for model test/model" } })]
    const stub = startScriptedLLMServer([
      { lines: errorLines, status: 503 },
      { lines: textStopResponse("answer with the steer") },
    ])
    try {
      await writeSlowRetryConfig(tmp.path, stub.origin)
      const msgs = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "request-retry-superseded" })
              const first = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.forkChild)
              yield* waitFor(() => retryParts(MessageV2.page({ sessionID: session.id, limit: 50 }).items).length > 0)
              const steer = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Use this extra hint." }],
              }).pipe(Effect.forkChild)
              // The retry wait is a minute long; the steer must not sit behind it.
              yield* Fiber.join(first).pipe(Effect.timeout("10 seconds"))
              yield* Fiber.join(steer).pipe(Effect.timeout("10 seconds"))
              return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            }),
          ),
      })
      expect(stub.captures.length).toBe(2)
      expect(JSON.stringify(stub.captures[1]!.messages)).toContain("Use this extra hint.")
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "answer with the steer"))).toBe(true)
      expect(retryParts(msgs)).toEqual([])
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a prompt that arrived before the step failed supersedes it at the first retry", async () => {
    await using tmp = await tmpdir({ git: true })
    const steerQueued = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse(), beforeReply: () => steerQueued.promise },
      { lines: textStopResponse("answer with the steer") },
    ])
    try {
      await writeSlowRetryConfig(tmp.path, stub.origin)
      const msgs = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "retry-superseded-by-earlier-steer" })
              const first = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              }).pipe(Effect.forkChild)
              yield* waitFor(() => stub.captures.length > 0)
              const steer = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Use this extra hint." }],
              }).pipe(Effect.forkChild)
              yield* waitFor(() => MessageV2.page({ sessionID: session.id, limit: 50 }).items
                .some((m) => m.parts.some((p) => p.type === "text" && p.text === "Use this extra hint.")))
              // The steer waits while the step has not failed; the empty reply records
              // a retry with a minute-long backoff, and the step gives way at once.
              steerQueued.resolve()
              yield* Fiber.join(first).pipe(Effect.timeout("10 seconds"))
              yield* Fiber.join(steer).pipe(Effect.timeout("10 seconds"))
              return yield* sessions.messages({ sessionID: session.id, agentID: "main" })
            }),
          ),
      })
      expect(stub.captures.length).toBe(2)
      expect(JSON.stringify(stub.captures[1]!.messages)).toContain("Use this extra hint.")
      expect(msgs.some((m) => m.parts.some((p) => p.type === "text" && p.text === "answer with the steer"))).toBe(true)
      expect(retryParts(msgs)).toEqual([])
    } finally {
      await stub.stop()
    }
  }, 30_000)

  test("a message sent to a subagent while its retried attempt hangs supersedes the subagent step", async () => {
    await using tmp = await tmpdir({ git: true })
    const hanging = Promise.withResolvers<void>()
    const stub = startScriptedLLMServer([
      { lines: emptyStopResponse() },
      {
        lines: textStopResponse("never delivered"),
        beforeReply: () => {
          hanging.resolve()
          return new Promise(() => {})
        },
      },
      { lines: textStopResponse("actor answer with the steer") },
    ])
    try {
      await writeConfig(tmp.path, stub.origin)
      const msgs = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "actor-retry-superseded" })
              const first = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Do delegated work." }],
              }).pipe(Effect.forkChild)
              yield* Effect.promise(() => hanging.promise).pipe(Effect.timeout("10 seconds"))
              const steer = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                agentID: "general-1",
                parts: [{ type: "text", text: "Use this extra hint." }],
              }).pipe(Effect.forkChild)
              yield* Fiber.join(first).pipe(Effect.timeout("15 seconds"))
              yield* Fiber.join(steer).pipe(Effect.timeout("15 seconds"))
              return yield* sessions.messages({ sessionID: session.id, agentID: "general-1" })
            }),
          ),
      })
      expect(stub.captures.length).toBe(3)
      expect(JSON.stringify(stub.captures[2]!.messages)).toContain("Use this extra hint.")
      const assistants = assistantOnly(msgs)
      expect(assistants).toHaveLength(1)
      expect(assistants[0]!.parts.some((p) => p.type === "text" && p.text === "actor answer with the steer")).toBe(true)
      expect(retryParts(msgs)).toEqual([])
    } finally {
      await stub.stop()
    }
  }, 30_000)

  // [TP-SR-R21-07]
  test("GPT reasoning-only stop step is terminal and is not retried", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningStopResponse("let me think about this...") },
      { lines: textStopResponse("unexpected retry") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-only" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(1)
              expect(result.info.role).toBe("assistant")
              if (result.info.role === "assistant") expect(result.info.error).toBeUndefined()
              expect(result.parts.some((p) => p.type === "reasoning" && p.text.includes("let me think"))).toBe(true)
              expect(result.parts.some((p) => p.type === "text")).toBe(false)
              expect(yield* prompt.recovery({ sessionID: session.id, agentID: "main" })).toEqual([])
              const resumed = yield* Effect.promise(() => Promise.resolve(Server.Default().app.request(
                `/session/${session.id}/resume?directory=${encodeURIComponent(tmp.path)}`,
                { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" },
              )))
              expect(resumed.status).toBe(404)
              expect(stub.captures.length).toBe(1)
              expect((yield* sessions.messages({ sessionID: session.id, agentID: "main" })).find((message) => message.info.id === result.info.id)).toEqual(result)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })

  test("GPT reasoning-only length step still auto-continues", async () => {
    await using tmp = await tmpdir({ git: true })
    const stub = startScriptedLLMServer([
      { lines: reasoningLengthResponse("token budget exhausted while thinking...") },
      { lines: textStopResponse("final answer") },
    ])
    try {
      await writeGPTConfig(tmp.path, stub.origin)
      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const prompt = yield* SessionPrompt.Service
              const session = yield* sessions.create({ title: "gpt-reasoning-length" })
              const result = yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Answer my question." }],
              })
              expect(stub.captures.length).toBe(2)
              expect(JSON.stringify(stub.captures[1].messages)).toContain("output token limit")
              expect(result.parts.some((p) => p.type === "text" && p.text === "final answer")).toBe(true)
            }),
          ),
      })
    } finally {
      await stub.stop()
    }
  })
})
