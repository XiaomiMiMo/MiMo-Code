import { afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "node:fs/promises"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Command } from "../../src/command"
import type { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"
import { InboxController } from "../../src/inbox"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { checkpointPath } from "../../src/session/checkpoint-paths"
import type { MessageV2 } from "../../src/session/message-v2"
import { SESSION_MEMORY_DIR_MARKER, SessionPrompt } from "../../src/session/prompt"
import { MessageID, PartID, type SessionID } from "../../src/session/schema"
import { SessionTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallsResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const FILES = ["alpha.txt", "beta.txt"]
const fileBody = (name: string) => Array.from({ length: 300 }, (_, i) => `${name} body line ${i}`).join("\n")

function config(origin: string, extra: Partial<Config.Info> = {}): Partial<Config.Info> {
  return {
    ...extra,
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
            limit: { context: 400_000, output: 10_000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "test/model" } },
    permission: { read: "allow" },
    lsp: false,
    formatter: false,
  }
}

type Captured = { role: string; content: unknown }

function text(message: Captured) {
  if (typeof message.content === "string") return message.content
  return (message.content as { type: string; text?: string }[]).map((part) => part.text ?? JSON.stringify(part)).join("\n")
}

function conversation(messages: Captured[]) {
  return messages.filter((message) => message.role !== "system")
}

describe("rebuild boundary placement", () => {
  test(
    "the boundary sorts after the tail, the next request carries the tail only through the boundary, and later messages stay live",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        {
          lines: toolCallsResponse(
            FILES.map((file, index) => ({ id: `call-${index}`, name: "read", args: JSON.stringify({ file_path: file }) })),
          ),
        },
        { lines: textStopResponse("checks passed") },
        { lines: textStopResponse("live reply") },
        { lines: textStopResponse("second live reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        for (const file of FILES) await Bun.write(path.join(tmp.path, file), fileBody(file))
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "rebuild placement" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(watermark.info.role).toBe("assistant")
                yield* seedCheckpoint(session.id, watermark.info.id)

                yield* say("run the checks on alpha and beta")
                const tail = (yield* sessions.messages({ sessionID: session.id })).filter(
                  (message) => message.info.id > watermark.info.id,
                )
                expect(tail.map((message) => message.info.role)).toEqual(["user", "assistant", "assistant"])
                const reminded = (message: { parts: MessageV2.Part[] }) =>
                  message.parts.some(
                    (part) => part.type === "text" && part.synthetic && part.text.includes(SESSION_MEMORY_DIR_MARKER),
                  )
                // The memory paths reminder of this context window sits on its first user message, before the tail.
                expect(tail.some(reminded)).toBe(false)

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const stored = yield* sessions.messages({ sessionID: session.id })
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                expect(stored.at(-1)!.info.id).toBe(boundary.info.id)
                for (const message of tail) expect(boundary.info.time.created).toBeGreaterThan(message.info.time.created)
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.coveredUpTo).toBe(watermark.info.id)
                expect(marker.digestUpTo).toBe(tail.at(-1)!.info.id)
                // The turn was finished before the rebuild; the boundary is not a resumable user.
                expect(yield* prompt.recovery({ sessionID: session.id, agentID: "main" })).toEqual([])

                yield* say("after rebuild")
                const first = conversation(server.captures.at(-1)!.messages)
                expect(first.map((message) => message.role)).toEqual(["user", "user"])
                const digest = text(first[0]!)
                expect(digest).toContain("Summary of previous conversation from checkpoint files:")
                expect(digest).toContain("Recent user input (verbatim)")
                expect(digest).toContain("run the checks on alpha and beta")
                expect(digest).toContain("# Recent activity")
                for (const file of FILES) expect(digest).toContain(`read(file_path="${file}")`)
                expect(digest).toContain("- assistant: checks passed")
                for (const file of FILES) expect(JSON.stringify(first)).not.toContain(`${file} body line 0`)
                const live = text(first[1]!)
                expect(live).toContain("after rebuild")
                expect(live).not.toContain("run the checks on alpha and beta")
                // The new context window starts at the boundary, which carries its memory paths reminder.
                const persisted = (yield* sessions.messages({ sessionID: session.id })).find(
                  (message) => message.info.id === boundary.info.id,
                )!
                expect(reminded(persisted)).toBe(true)
                expect(digest).toContain(SESSION_MEMORY_DIR_MARKER)
                expect(live).not.toContain(SESSION_MEMORY_DIR_MARKER)

                yield* say("next step")
                const second = conversation(server.captures.at(-1)!.messages)
                expect(second.map((message) => message.role)).toEqual(["user", "user", "assistant", "user"])
                expect(text(second[0]!)).toBe(text(first[0]!))
                expect(text(second[1]!)).toContain("after rebuild")
                expect(text(second[2]!)).toContain("live reply")
                expect(text(second[3]!)).toContain("next step")
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "an automatic rebuild after a tool step digests that step, keeps the turn on its user message, and ends after the final step",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting", { promptTokens: 1_000 }) },
        {
          lines: toolCallsResponse(
            FILES.map((file, index) => ({ id: `call-${index}`, name: "read", args: JSON.stringify({ file_path: file }) })),
            { promptTokens: 50_000 },
          ),
        },
        { lines: textStopResponse("checks passed", { promptTokens: 1_000 }) },
        { lines: textStopResponse("extra reply", { promptTokens: 1_000 }) },
      ])
      try {
        await using tmp = await tmpdir({
          git: true,
          config: config(server.origin, {
            compaction: { reserved: 100, max_context: 40_000 },
            checkpoint: { thresholds: [], reserved: 100 },
          }),
        })
        for (const file of FILES) await Bun.write(path.join(tmp.path, file), fileBody(file))
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "automatic rebuild after a tool step" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(watermark.info.role).toBe("assistant")
                yield* seedCheckpoint(session.id, watermark.info.id)

                yield* say("run the checks on alpha and beta")
                expect(server.captures).toHaveLength(3)

                const stored = yield* sessions.messages({ sessionID: session.id })
                const user = stored.find((message) => message.info.role === "user" && message.info.id > watermark.info.id)!
                const step = stored.find((message) => message.parts.some((part) => part.type === "tool"))!
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                const reply = stored.at(-1)!
                expect(stored.map((message) => message.info.id).slice(-4)).toEqual([
                  user.info.id,
                  step.info.id,
                  boundary.info.id,
                  reply.info.id,
                ])
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.coveredUpTo).toBe(watermark.info.id)
                expect(marker.digestUpTo).toBe(step.info.id)
                if (reply.info.role !== "assistant") throw new Error("expected the final assistant reply")
                expect(reply.info.parentID).toBe(user.info.id)
                expect(reply.parts.some((part) => part.type === "text" && part.text === "checks passed")).toBe(true)

                const request = conversation(server.captures[2]!.messages)
                expect(request.map((message) => message.role)).toEqual(["user"])
                const digest = text(request[0]!)
                expect(digest).toContain("run the checks on alpha and beta")
                expect(digest).toContain("# Recent activity")
                for (const file of FILES) expect(digest).toContain(`read(file_path="${file}")`)
                expect(digest).toContain("mid-loop in an autonomous task")
                for (const file of FILES) expect(JSON.stringify(request)).not.toContain(`${file} body line 0`)
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )
  test(
    "an unanswered user message at the end of the tail is copied onto the boundary in full; a queued input stays out and arrives live",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        {
          lines: toolCallsResponse(
            FILES.map((file, index) => ({ id: `call-${index}`, name: "read", args: JSON.stringify({ file_path: file }) })),
          ),
        },
        { lines: textStopResponse("checks passed") },
        { lines: textStopResponse("live reply") },
      ])
      const long = [...Array.from({ length: 3_000 }, (_, i) => `word${i}`), "END-OF-LONG-PROMPT"].join(" ")
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        for (const file of FILES) await Bun.write(path.join(tmp.path, file), fileBody(file))
        await Bun.write(path.join(tmp.path, "notes.txt"), "attached notes line 0\nattached notes line 1\n")
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const inbox = yield* InboxController.Service
                const session = yield* sessions.create({ title: "unanswered tail user" })
                const say = (value: string) =>
                  prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: value }] })

                yield* say("start the task")
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                yield* say("run the checks on alpha and beta")
                const answered = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                expect(answered.info.role).toBe("assistant")

                const unanswered = yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  noReply: true,
                  parts: [
                    { type: "text", text: long },
                    {
                      type: "file",
                      mime: "text/plain",
                      filename: "notes.txt",
                      url: pathToFileURL(path.join(tmp.path, "notes.txt")).href,
                    },
                  ],
                })
                const queuedID = MessageID.ascending()
                yield* inbox.accept(
                  {
                    lane: { sessionID: session.id, agentID: "main" },
                    message: { ...(unanswered.info as MessageV2.User), id: queuedID, time: { created: Date.now() } },
                    parts: [{ id: PartID.ascending(), sessionID: session.id, messageID: queuedID, type: "text", text: "QUEUED-INPUT" }],
                    type: "prompt",
                    idempotencyKey: queuedID,
                  },
                  { deferKick: true },
                )

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const stored = yield* sessions.messages({ sessionID: session.id })
                const boundary = stored.find((message) => message.parts.some((part) => part.type === "checkpoint"))!
                expect(stored.at(-1)!.info.id).toBe(boundary.info.id)
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.digestUpTo).toBe(answered.info.id)
                expect(marker.deferredInputs).toEqual([queuedID])

                const copied = boundary.parts.filter((part) => part.type === "text" && part.synthetic)
                expect(copied.some((part) => part.type === "text" && part.text === long)).toBe(true)
                expect(copied.some((part) => part.type === "text" && part.text.includes("attached notes line 1"))).toBe(true)
                expect(
                  boundary.parts.some(
                    (part) => part.type === "file" && part.filename === "notes.txt" && part.mime === "text/plain",
                  ),
                ).toBe(true)
                const context = boundary.parts
                  .flatMap((part) => (part.type === "text" ? [part.text] : []))
                  .find((value) => value.includes("Recent user input (verbatim)"))!
                expect(context).toContain("run the checks on alpha and beta")
                expect(context).not.toContain("word0 word1")
                expect(JSON.stringify(boundary.parts)).not.toContain("QUEUED-INPUT")

                yield* say("after rebuild")
                const request = conversation(server.captures.at(-1)!.messages)
                const first = text(request[0]!)
                expect(first).toContain("END-OF-LONG-PROMPT")
                expect(first).toContain("attached notes line 1")
                expect(first).not.toContain("QUEUED-INPUT")
                expect(request.slice(1).some((message) => text(message).includes("QUEUED-INPUT"))).toBe(true)
                expect(request.slice(1).some((message) => text(message).includes("after rebuild"))).toBe(true)
                for (const file of FILES) expect(JSON.stringify(request)).not.toContain(`${file} body line 0`)
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "after a rebuild, the unanswered user it carries is offered for resume and resumes under that user",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        { lines: textStopResponse("resumed reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const session = yield* sessions.create({ title: "resume after rebuild" })
                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start the task" }] })
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                const unanswered = yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  noReply: true,
                  parts: [{ type: "text", text: "UNANSWERED-BEFORE-REBUILD" }],
                })

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const recovery = yield* prompt.recovery({ sessionID: session.id, agentID: "main" })
                expect(recovery.map((item) => (item.kind === "parent-user" ? item.userMessageID : item.kind))).toEqual([
                  unanswered.info.id,
                ])

                const result = yield* prompt.resume({
                  sessionID: session.id,
                  userMessageID: unanswered.info.id,
                  agentID: "main",
                })
                expect(result.info).toMatchObject({ role: "assistant", parentID: unanswered.info.id, finish: "stop" })
                expect(server.captures).toHaveLength(2)
                const request = conversation(server.captures[1]!.messages)
                expect(request.map((message) => message.role)).toEqual(["user"])
                expect(text(request[0]!)).toContain("UNANSWERED-BEFORE-REBUILD")
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "a queued input left out of a rebuild and then cancelled is offered for resume and reaches the request after the boundary",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        { lines: textStopResponse("resumed reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const inbox = yield* InboxController.Service
                const session = yield* sessions.create({ title: "cancelled queued input" })
                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start the task" }] })
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                const original = (yield* sessions.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user",
                )!
                const queuedID = MessageID.ascending()
                yield* inbox.accept(
                  {
                    lane: { sessionID: session.id, agentID: "main" },
                    message: { ...(original.info as MessageV2.User), id: queuedID, time: { created: Date.now() } },
                    parts: [
                      { id: PartID.ascending(), sessionID: session.id, messageID: queuedID, type: "text", text: "QUEUED-THEN-CANCELLED" },
                    ],
                    type: "prompt",
                    idempotencyKey: queuedID,
                  },
                  { deferKick: true },
                )

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const boundary = (yield* sessions.messages({ sessionID: session.id })).find((message) =>
                  message.parts.some((part) => part.type === "checkpoint"),
                )!
                expect(JSON.stringify(boundary.parts)).not.toContain("QUEUED-THEN-CANCELLED")
                const deferredMarker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (deferredMarker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(deferredMarker.deferredInputs).toEqual([queuedID])

                expect(yield* inbox.abortSession(session.id)).toBe(1)
                const recovery = yield* prompt.recovery({ sessionID: session.id, agentID: "main" })
                expect(recovery.map((item) => (item.kind === "parent-user" ? item.userMessageID : item.kind))).toEqual([
                  queuedID,
                ])

                const result = yield* prompt.resume({ sessionID: session.id, userMessageID: queuedID, agentID: "main" })
                expect(result.info).toMatchObject({ role: "assistant", parentID: queuedID, finish: "stop" })
                const request = conversation(server.captures.at(-1)!.messages)
                expect(request.map((message) => message.role)).toEqual(["user", "user"])
                expect(text(request[0]!)).not.toContain("QUEUED-THEN-CANCELLED")
                expect(text(request[1]!)).toContain("QUEUED-THEN-CANCELLED")
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "an input cancelled before the rebuild is part of the tail and is not placed after the boundary",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        { lines: textStopResponse("live reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const inbox = yield* InboxController.Service
                const session = yield* sessions.create({ title: "input cancelled before rebuild" })
                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start the task" }] })
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                const original = (yield* sessions.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user",
                )!
                const queuedID = MessageID.ascending()
                yield* inbox.accept(
                  {
                    lane: { sessionID: session.id, agentID: "main" },
                    message: { ...(original.info as MessageV2.User), id: queuedID, time: { created: Date.now() } },
                    parts: [
                      { id: PartID.ascending(), sessionID: session.id, messageID: queuedID, type: "text", text: "CANCELLED-BEFORE-REBUILD" },
                    ],
                    type: "prompt",
                    idempotencyKey: queuedID,
                  },
                  { deferKick: true },
                )
                expect(yield* inbox.abortSession(session.id)).toBe(1)

                yield* prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const boundary = (yield* sessions.messages({ sessionID: session.id })).find((message) =>
                  message.parts.some((part) => part.type === "checkpoint"),
                )!
                const marker = boundary.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.deferredInputs).toBeUndefined()
                expect(
                  boundary.parts.some(
                    (part) => part.type === "text" && part.synthetic && part.text === "CANCELLED-BEFORE-REBUILD",
                  ),
                ).toBe(true)

                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "after rebuild" }] })
                const request = conversation(server.captures.at(-1)!.messages)
                expect(request.map((message) => message.role)).toEqual(["user", "user"])
                expect(text(request[0]!)).toContain("CANCELLED-BEFORE-REBUILD")
                expect(text(request[1]!)).toContain("after rebuild")
                expect(JSON.stringify(request).split("CANCELLED-BEFORE-REBUILD")).toHaveLength(2)
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )

  test(
    "an input still queued across two rebuilds and cancelled after the second reaches the next request",
    async () => {
      const server = startScriptedLLMServer([
        { lines: textStopResponse("starting") },
        { lines: textStopResponse("live reply") },
      ])
      try {
        await using tmp = await tmpdir({ git: true, config: config(server.origin) })
        await Instance.provide({
          directory: tmp.path,
          fn: () =>
            AppRuntime.runPromise(
              Effect.gen(function* () {
                const sessions = yield* Session.Service
                const prompt = yield* SessionPrompt.Service
                const inbox = yield* InboxController.Service
                const session = yield* sessions.create({ title: "queued across two rebuilds" })
                const rebuild = prompt.command({
                  sessionID: session.id,
                  command: Command.Default.REBUILD,
                  arguments: "",
                  agent: "build",
                })
                const boundaries = Effect.map(sessions.messages({ sessionID: session.id }), (messages) =>
                  messages.filter((message) => message.parts.some((part) => part.type === "checkpoint")),
                )
                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "start the task" }] })
                const watermark = (yield* sessions.messages({ sessionID: session.id })).at(-1)!
                yield* seedCheckpoint(session.id, watermark.info.id)
                const original = (yield* sessions.messages({ sessionID: session.id })).find(
                  (message) => message.info.role === "user",
                )!
                const queuedID = MessageID.ascending()
                yield* inbox.accept(
                  {
                    lane: { sessionID: session.id, agentID: "main" },
                    message: { ...(original.info as MessageV2.User), id: queuedID, time: { created: Date.now() } },
                    parts: [
                      { id: PartID.ascending(), sessionID: session.id, messageID: queuedID, type: "text", text: "QUEUED-ACROSS-REBUILDS" },
                    ],
                    type: "prompt",
                    idempotencyKey: queuedID,
                  },
                  { deferKick: true },
                )
                yield* rebuild
                const first = (yield* boundaries)[0]!

                yield* prompt.prompt({
                  sessionID: session.id,
                  agent: "build",
                  noReply: true,
                  parts: [{ type: "text", text: "a note after the first rebuild" }],
                })
                yield* seedCheckpoint(session.id, first.info.id)
                yield* rebuild
                const second = (yield* boundaries).at(-1)!
                expect(second.info.id).not.toBe(first.info.id)
                const marker = second.parts.find((part) => part.type === "checkpoint")!
                if (marker.type !== "checkpoint") throw new Error("expected a checkpoint part")
                expect(marker.coveredUpTo).toBe(first.info.id)
                expect(marker.deferredInputs).toEqual([queuedID])

                expect(yield* inbox.abortSession(session.id)).toBe(1)
                yield* prompt.prompt({ sessionID: session.id, agent: "build", parts: [{ type: "text", text: "after rebuild" }] })
                const request = conversation(server.captures.at(-1)!.messages)
                expect(request.map((message) => message.role)).toEqual(["user", "user", "user"])
                expect(text(request[0]!)).toContain("a note after the first rebuild")
                expect(text(request[1]!)).toContain("QUEUED-ACROSS-REBUILDS")
                expect(text(request[2]!)).toContain("after rebuild")
              }),
            ),
        })
      } finally {
        await server.stop()
      }
    },
    60_000,
  )
})

function seedCheckpoint(sessionID: SessionID, watermark: string) {
  return Effect.promise(async () => {
    await fs.mkdir(path.dirname(checkpointPath(sessionID)), { recursive: true })
    await Bun.write(checkpointPath(sessionID), "# Session checkpoint\n\n## §1 Active intent\nRun the checks.\n")
    Database.use((db) =>
      db
        .update(SessionTable)
        .set({ last_checkpoint_message_id: watermark as never })
        .where(eq(SessionTable.id, sessionID))
        .run(),
    )
  })
}
