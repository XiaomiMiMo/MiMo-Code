import { afterAll, beforeAll, beforeEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Stream, ManagedRuntime, Layer } from "effect"
import { LLM } from "../../src/session/llm"
import { ActorRegistry } from "../../src/actor/registry"
import { Session as SessionNs } from "../../src/session"
import { Instance } from "../../src/project/instance"
import { Provider } from "../../src/provider"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { Filesystem } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import type { Agent } from "../../src/agent/agent"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionID, MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Global } from "../../src/global"

// Reuses the same HTTP-mock approach from llm.test.ts to capture the
// system prompt the LLM layer assembled before sending. The system prompt
// is the only place buildMemoryInstructions content lands ("# Memory system");
// asserting on body.system gives a concrete check that the agentID guard
// fired without having to extract the private helper.

type Capture = { url: URL; headers: Headers; body: Record<string, unknown> }

const queueState = {
  server: null as ReturnType<typeof Bun.serve> | null,
  queue: [] as Array<{
    path: string
    response: Response
    resolve: (value: Capture) => void
  }>,
}

function deferred<T>() {
  const result = {} as { promise: Promise<T>; resolve: (value: T) => void }
  result.promise = new Promise((resolve) => (result.resolve = resolve))
  return result
}

function waitRequest(pathname: string, response: Response) {
  const pending = deferred<Capture>()
  queueState.queue.push({ path: pathname, response, resolve: pending.resolve })
  return pending.promise
}

function createChatStream(text: string) {
  const payload =
    [
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { role: "assistant" } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: { content: text } }] })}`,
      `data: ${JSON.stringify({ id: "x", object: "chat.completion.chunk", choices: [{ delta: {}, finish_reason: "stop" }] })}`,
      "data: [DONE]",
    ].join("\n\n") + "\n\n"
  const encoder = new TextEncoder()
  return new ReadableStream<Uint8Array>({
    start(controller) {
      controller.enqueue(encoder.encode(payload))
      controller.close()
    },
  })
}

async function loadFixture(providerID: string, modelID: string) {
  const fixturePath = path.join(import.meta.dir, "../tool/fixtures/models-api.json")
  const data = await Filesystem.readJson<Record<string, any>>(fixturePath)
  const provider = data[providerID]
  if (!provider) throw new Error(`Missing provider in fixture: ${providerID}`)
  const model = provider.models[modelID]
  if (!model) throw new Error(`Missing model in fixture: ${modelID}`)
  return { provider, model }
}

beforeAll(() => {
  queueState.server = Bun.serve({
    port: 0,
    async fetch(req) {
      const next = queueState.queue.shift()
      if (!next) return new Response("unexpected request", { status: 500 })
      const url = new URL(req.url)
      const body = (await req.json()) as Record<string, unknown>
      next.resolve({ url, headers: req.headers, body })
      if (!url.pathname.endsWith(next.path)) return new Response("not found", { status: 404 })
      return next.response
    },
  })
})

beforeEach(() => {
  queueState.queue.length = 0
})

afterAll(() => {
  void queueState.server?.stop()
})

async function getModel(providerID: ProviderID, modelID: ModelID) {
  return AppRuntime.runPromise(
    Effect.gen(function* () {
      const provider = yield* Provider.Service
      return yield* provider.getModel(providerID, modelID)
    }),
  )
}

function makeBaseUser(sessionID: SessionID, providerID: string, modelID: ModelID): MessageV2.User {
  return {
    id: MessageID.make("user-llm-sysprompt"),
    sessionID,
    role: "user",
    time: { created: Date.now() },
    agent: "test",
    model: { providerID: ProviderID.make(providerID), modelID },
  } satisfies MessageV2.User
}

function makeAgent(): Agent.Info {
  return {
    name: "test",
    mode: "primary",
    options: {},
    permission: [{ permission: "*", pattern: "*", action: "allow" }],
  } satisfies Agent.Info
}

function tmpConfig(providerID: string, baseURL: string) {
  return JSON.stringify({
    $schema: "https://opencode.ai/config.json",
    enabled_providers: [providerID],
    provider: {
      [providerID]: { options: { apiKey: "test-key", baseURL } },
    },
  })
}

describe("session.llm system prompt — memory-instructions guard", () => {
  test("main agent (no agentID) — '# Memory system' IS appended", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hi"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        // buildSystemArray now collapses everything into a single system message.
        expect(sysMsgs.length).toBe(1)
        const allSys = sysMsgs.map((m) => m.content).join("\n")
        expect(allSys).toContain("# Memory system")
      },
    })
  })

  test("system-spawned actor — '# Memory system' is NOT appended", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hi"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        // Create a real session row first — actor_registry.session_id is a FK to session.id.
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }

        // Register a system-spawn actor at this session BEFORE the stream call.
        // ActorRegistry uses the global Database, which is shared with the
        // LLM-runtime's actorRegistry layer instance, so the row is visible
        // to isSystemSpawned() during stream assembly.
        const regRt = ManagedRuntime.make(ActorRegistry.defaultLayer)
        try {
          await regRt.runPromise(
            ActorRegistry.Service.use((svc) =>
              svc.register({
                sessionID,
                actorID: "checkpoint-writer-1",
                mode: "subagent",
                agent: "checkpoint-writer",
                description: "writer fixture",
                contextMode: "full",
                background: true,
                lifecycle: "ephemeral",
              }),
            ),
          )
        } finally {
          await regRt.dispose()
        }

        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                  agentID: "checkpoint-writer-1",
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        const allSys = sysMsgs.map((m) => m.content).join("\n")
        expect(allSys).not.toContain("# Memory system")
      },
    })
  })

  test("main agent (no agentID) — Active recall protocol IS in system prompt (F4a)", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hi"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        const allSys = sysMsgs.map((m) => m.content).join("\n")
        expect(allSys).toContain("Active recall protocol")
        expect(allSys).toContain("use Grep with a keyword pattern")
      },
    })
  })

  test("v8.1 buildMemoryInstructions reflects writer-as-curator ownership (F22)", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hi"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const messages = capture.body.messages as Array<{ role: string; content: string }>
        const sysMsgs = messages.filter((m) => m.role === "system")
        const allSys = sysMsgs.map((m) => m.content).join("\n")

        // F22 v8.1 assertions:
        // (1) writer-as-sole-curator language
        expect(allSys).toContain("sole curator")

        // (2) Active recall protocol still present (carried over from v8 F8)
        expect(allSys).toContain("Active recall protocol")
        expect(allSys).toContain("already in your context")

        // (3) Subagent return format hint mentioned
        expect(allSys).toContain("Subagent return format")
        expect(allSys).toContain("**Status**:")

        // (4) Agent's mid-task writing duties removed (v8.0 sections):
        expect(allSys).not.toContain("Maintaining task progress")
        expect(allSys).not.toContain("Notes.md format")

        // v8.2: notes.md is back as the agent's only legal scratchpad (F26b).
        expect(allSys).toContain("Notes scratchpad")
        expect(allSys).toContain("notes.md")

        // (5) MEMORY.md exception still present
        expect(allSys).toContain("MEMORY.md")
        expect(allSys).toContain("User states a project-level rule")
      },
    })
  })

  test("main agent memory instructions use absolute memory paths", async () => {
    const server = queueState.server!
    const providerID = "alibaba"
    const modelID = "qwen-plus"
    const fixture = await loadFixture(providerID, modelID)
    const request = waitRequest(
      "/chat/completions",
      new Response(createChatStream("Hi"), { status: 200, headers: { "Content-Type": "text/event-stream" } }),
    )

    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, "mimocode.json"), tmpConfig(providerID, `${server.url.origin}/v1`))
      },
    })

    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const resolved = await getModel(ProviderID.make(providerID), ModelID.make(fixture.model.id))
        const sessionRt = ManagedRuntime.make(SessionNs.defaultLayer)
        let sessionID: SessionID
        try {
          const info = await sessionRt.runPromise(SessionNs.Service.use((svc) => svc.create({})))
          sessionID = info.id
        } finally {
          await sessionRt.dispose()
        }
        const rt = ManagedRuntime.make(Layer.mergeAll(LLM.defaultLayer))
        try {
          await rt.runPromise(
            LLM.Service.use((svc) =>
              svc
                .stream({
                  user: makeBaseUser(sessionID, providerID, resolved.id),
                  sessionID,
                  model: resolved,
                  agent: makeAgent(),
                  system: ["You are a helpful assistant."],
                  messages: [{ role: "user", content: "Hello" }],
                  tools: {},
                })
                .pipe(Stream.runDrain),
            ),
          )
        } finally {
          await rt.dispose()
        }
        const capture = await request
        const allSys = (capture.body.messages as Array<{ role: string; content: string }>)
          .filter((m) => m.role === "system")
          .map((m) => m.content)
          .join("\n")
        expect(allSys).toContain(path.join(Global.Path.data, "memory", "projects", Instance.current.project.id, "MEMORY.md"))
        expect(allSys).toContain(path.join(Global.Path.data, "memory", "sessions", sessionID, "checkpoint.md"))
        // Global memory is taught (read-side) and points at the canonical path.
        expect(allSys).toContain("## Global memory")
        expect(allSys).toContain(path.join(Global.Path.data, "memory", "global", "MEMORY.md"))
        expect(allSys).not.toContain("<data>/memory/projects")
        expect(allSys).not.toContain("<data>/memory/sessions")
      },
    })
  })
})
