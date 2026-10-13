import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { pathToFileURL } from "node:url"
import { Effect } from "effect"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionRequests } from "../../src/session/requests"
import { MessageV2 } from "../../src/session/message-v2"
import { NamedError } from "@mimo-ai/shared/util/error"
import { HostErrorRegistry } from "../../src/error/host-registry"
import { ActorExecution } from "../../src/actor/execution"
import { ResumeTestHooks } from "../../src/session/resume-test-hooks"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"
import { Log } from "../../src/util"

void Log.init({ print: false })
afterEach(async () => {
  ResumeTestHooks.reset()
  await Instance.disposeAll()
})
const model = { providerID: ProviderID.make("alibaba"), modelID: ModelID.make("qwen-plus") }
function client(directory: string, sessionID: string) {
  const app = Server.Default().app
  const request = (route: string, body?: unknown, query = "") =>
    app.request(
      `/session/${sessionID}/${route}?directory=${encodeURIComponent(directory)}${query}`,
      body === undefined
        ? {}
        : {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify(body),
          },
    )
  const get = async (id: string) => SessionRequests.Info.parse(await (await request(`request/${id}`)).json())
  const wait = async (
    id: string,
    predicate: (info: SessionRequests.Info) => boolean = (info) =>
      ["completed", "failed", "cancelled"].includes(info.status),
  ) => {
    for (let i = 0; i < 250; i++) {
      const info = await get(id)
      if (predicate(info)) return info
      await Bun.sleep(20)
    }
    throw new Error(`Request did not converge: ${id}`)
  }
  return { request, get, wait }
}

// [TP-RUN-R13-09]
for (const nested of [false, true]) {
  for (const tracked of [false, true]) {
    test(`real tool context is frozen through ${nested ? "nested exec" : "plugin registry"}, tracked=${tracked}`, async () => {
      const llm = startScriptedLLMServer([
        { lines: toolCallResponse({ id: "provenance-call", name: nested ? "exec" : "provenance", args: JSON.stringify(nested ? { code: 'return await tools.provenance({ requestExecution: "forged" })' } : { requestExecution: "forged" }) }) },
        { lines: textStopResponse("done") },
      ])
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          const file = path.join(dir, "provenance-plugin.ts")
          const sink = path.join(dir, "context.json")
          await Bun.write(file, `import fs from "node:fs/promises"
export default async () => ({ tool: { provenance: {
  description: "Inspect trusted context", args: {},
  execute: async (_args, ctx) => {
    const value = ctx.requestExecution
    await fs.writeFile(${JSON.stringify(sink + ".tmp")}, JSON.stringify({
      requestExecution: value, messageID: ctx.messageID, directory: ctx.directory,
      frozen: !!value && Object.isFrozen(value) && Object.isFrozen(value.executionRef) && Object.isFrozen(value.requestIDs)
    }))
    await fs.rename(${JSON.stringify(sink + ".tmp")}, ${JSON.stringify(sink)})
    return "captured"
  }
} } })`)
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({
            enabled_providers: ["alibaba"],
            provider: { alibaba: { options: { apiKey: "test", baseURL: `${llm.origin}/v1` } } },
            plugin: [pathToFileURL(file).href],
          }))
          return sink
        },
      })
      try {
        const sessionID = await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "tool provenance" }))).then((s) => s.id) })
        const api = client(tmp.path, sessionID)
        const { runtimeID } = await (await api.request("request")).json() as { runtimeID: string }
        const response = await api.request("prompt_async", {
          ...(tracked ? { runtimeID, requestID: "host" } : {}), model, harness: nested ? "codex" : "default",
          parts: [{ type: "text", text: "capture context" }],
        })
        expect(response.status).toBe(tracked ? 202 : 204)
        if (tracked) expect((await api.wait("host")).status).toBe("completed")
        for (let i = 0; i < 250 && !(await Bun.file(tmp.extra).exists()); i++) await Bun.sleep(20)
        const captured = await Bun.file(tmp.extra).json()
        expect(captured.frozen).toBe(true)
        expect(captured.directory).toBe(tmp.path)
        expect(captured.requestExecution.executionRef).toMatchObject({ runtimeID, sessionID, agentID: "main" })
        expect(captured.requestExecution.requestIDs).toEqual(tracked ? ["host"] : [])
        const messages = await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.messages({ sessionID }))) })
        const message = messages.find((m) => m.info.id === captured.messageID)!
        expect(message.info.role).toBe("assistant")
        if (message.info.role === "assistant") expect(captured.requestExecution.userMessageID).toBe(message.info.parentID)
        if (tracked) expect(captured.requestExecution.executionRef).toEqual((await api.get("host")).executionRefs[0])
      } finally {
        await llm.stop()
      }
    }, 30_000)
  }
}

// [TP-RUN-R13-01][TP-RUN-R13-03][TP-RUN-R13-04][TP-RUN-R13-05]
test("HTTP prompt/steer are idempotent and a shared Runner reports both consumed inputs", async () => {
  const llm = startScriptedLLMServer([{ lines: textStopResponse("both consumed") }])
  await using tmp = await tmpdir({
    git: true,
    config: {
      enabled_providers: ["alibaba"],
      provider: { alibaba: { options: { apiKey: "test", baseURL: `${llm.origin}/v1` } } },
    },
  })
  try {
    const sessionID = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "requests" }))).then((s) => s.id),
    })
    const api = client(tmp.path, sessionID)
    const initial = (await (await api.request("request")).json()) as { runtimeID: string; requests: unknown[] }
    expect(initial.requests).toEqual([])
    let release!: () => void
    const barrier = new Promise<void>((resolve) => {
      release = resolve
    })
    ResumeTestHooks.beforeStep0ParentCheck = () => Effect.promise(() => barrier)
    const input = {
      requestID: "send",
      runtimeID: initial.runtimeID,
      commandKind: "send",
      model,
      parts: [{ type: "text", text: "first" }],
    }
    const replies = await Promise.all([api.request("prompt_async", input), api.request("prompt_async", input)])
    expect(replies.map((r) => r.status)).toEqual([202, 202])
    await api.wait("send", (r) => !!r.userMessageID)
    const steer = await api.request("prompt_async", {
      ...input,
      requestID: "steer",
      commandKind: "steer",
      parts: [{ type: "text", text: "second" }],
    })
    expect(steer.status).toBe(202)
    await api.wait("steer", (r) => !!r.userMessageID)
    expect((await api.get("steer")).status).toBe("accepted")
    expect((await api.request("prompt_async", { ...input, parts: [{ type: "text", text: "different" }] })).status).toBe(
      409,
    )
    release()
    const a = await api.wait("send"),
      b = await api.wait("steer")
    expect(a.status).toBe("completed")
    expect(b.status).toBe("completed")
    expect(a.executionRefs).toEqual(b.executionRefs)
    expect(a.assistantMessageIDs).toEqual(b.assistantMessageIDs)
    expect(a.executionRefs[0]).toMatchObject({ runtimeID: initial.runtimeID, sessionID, agentID: "main" })
    expect((await api.request("prompt_async", input)).status).toBe(202)
    expect(await api.get("send")).toEqual(a)
    const messages = await Instance.provide({
      directory: tmp.path,
      fn: () => AppRuntime.runPromise(Session.Service.use((svc) => svc.messages({ sessionID }))),
    })
    expect(messages.filter((m) => m.info.role === "user")).toHaveLength(2)
    expect(messages.filter((m) => m.info.role === "assistant")).toHaveLength(1)
  } finally {
    await llm.stop()
  }
}, 30_000)

// [TP-SR-R21-23][TP-SR-R21-24][TP-RUN-R13-01][TP-RUN-R13-02]
for (const entry of ["paired", "assistant", "trailing", "useful"] as const)
  test(`HTTP ${entry} recovery records validated parent and reports invalid targets without a message`, async () => {
    const llm = startScriptedLLMServer([{ lines: textStopResponse("recovered") }])
    await using tmp = await tmpdir({
      git: true,
      config: {
        enabled_providers: ["alibaba"],
        provider: { alibaba: { options: { apiKey: "test", baseURL: `${llm.origin}/v1` } } },
      },
    })
    try {
      const seeded = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const sessions = yield* Session.Service
              const session = yield* sessions.create({ title: "empty recovery" })
              const user = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "user",
                agent: "build",
                model,
                time: { created: Date.now() },
              })
              yield* sessions.updatePart({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: user.id,
                type: "text",
                text: "original",
              })
              if (entry === "trailing") return { sessionID: session.id, user: user.id, shell: undefined }
              const shell = yield* sessions.updateMessage({
                id: MessageID.ascending(),
                sessionID: session.id,
                role: "assistant",
                parentID: user.id,
                agent: "build",
                mode: "build",
                path: { cwd: tmp.path, root: tmp.path },
                cost: 0,
                tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
                modelID: model.modelID,
                providerID: model.providerID,
                time: { created: Date.now() },
              })
              if (entry === "useful")
                yield* sessions.updatePart({
                  id: PartID.ascending(),
                  sessionID: session.id,
                  messageID: shell.id,
                  type: "text",
                  text: "partial response",
                })
              return { sessionID: session.id, user: user.id, shell: shell.id }
            }),
          ),
      })
      const api = client(tmp.path, seeded.sessionID)
      const { runtimeID } = (await (await api.request("request")).json()) as { runtimeID: string }
      const reply = await api.request("resume", {
        runtimeID,
        requestID: "resume",
        ...(entry === "assistant" || entry === "useful"
          ? { assistantMessageID: seeded.shell }
          : {
              userMessageID: seeded.user,
              emptyAssistantMessageID: seeded.shell,
            }),
      })
      expect(reply.status).toBe(202)
      const result = await api.wait("resume")
      expect(result.status).toBe("completed")
      expect(result.userMessageID).toBe(seeded.user)
      expect(result.assistantMessageIDs).toHaveLength(1)
      expect(result.assistantMessageIDs).not.toContain(seeded.shell)
      expect(result.executionRefs).toHaveLength(1)
      const invalid = await api.request("resume", {
        runtimeID,
        requestID: "stale",
        userMessageID: seeded.user,
        emptyAssistantMessageID: seeded.shell,
      })
      expect(invalid.status).toBe(202)
      const failed = await api.wait("stale")
      expect(failed.status).toBe("failed")
      expect(failed.error?.name).toBe("NotFoundError")
      expect(failed.userMessageID).toBeUndefined()
      expect(failed.assistantMessageIDs).toBeUndefined()
      const command = await api.request("command", {
        runtimeID,
        requestID: "command",
        command: "nonexistent-request-test-command",
        arguments: "",
      })
      expect(command.status).toBe(202)
      expect((await api.wait("command")).status).toBe("failed")
      const native = await api.request("resume", { userMessageID: seeded.user, emptyAssistantMessageID: seeded.shell })
      expect(native.status).toBe(404)
    } finally {
      await llm.stop()
    }
  }, 30_000)

// [TP-RUN-R13-02][TP-RUN-R13-05][TP-RUN-R13-08] Receipt diagnostics are projected before GET and SSE publication.
test("GET and SSE receipt errors never expose provider or exception contents", async () => {
  await using tmp = await tmpdir({ git: true })
  const secret = "SYNTHETIC_PRIVATE_RECEIPT_DETAIL"
  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "receipt diagnostic boundary" }))).then(
        (session) => session.id,
      ),
  })
  const api = client(tmp.path, sessionID)
  const { runtimeID } = (await (await api.request("request")).json()) as { runtimeID: string }
  const previousCatalog = HostErrorRegistry.hostErrorCatalog()
  HostErrorRegistry.loadHostErrorCatalog({
    protocolVersion: 2,
    rules: [
      {
        match: { providerID: "test", statusCode: 429, response: { kind: "empty" } },
        code: "mimo_desktop.rate_limited",
        retryClass: "persistent",
      },
    ],
  })
  const provider = new MessageV2.APIError({
    message: secret,
    statusCode: 401,
    isRetryable: false,
    responseHeaders: { authorization: secret },
    responseBody: secret,
    metadata: { request: secret },
    hostCode: secret,
  })
  const unknown = new NamedError.Unknown({ message: secret, metadata: { request: secret } })
  const cases = [
    {
      id: "prepare-api",
      mode: "prepare",
      error: provider,
      expected: {
        name: "APIError",
        data: { message: "Authentication failed. Invalid API Key.", statusCode: 401, isRetryable: false },
      },
    },
    {
      id: "work-api",
      mode: "work",
      error: provider,
      expected: {
        name: "APIError",
        data: { message: "Authentication failed. Invalid API Key.", statusCode: 401, isRetryable: false },
      },
    },
    {
      id: "prepare-named",
      mode: "prepare",
      error: unknown,
      expected: { name: "UnknownError", data: { message: "Request failed." } },
    },
    {
      id: "work-error",
      mode: "work",
      error: new Error(secret),
      expected: { name: "UnknownError", data: { message: "Request failed." } },
    },
    {
      id: "assistant-api",
      mode: "assistant",
      error: provider.toObject(),
      expected: {
        name: "APIError",
        data: { message: "Authentication failed. Invalid API Key.", statusCode: 401, isRetryable: false },
      },
    },
    {
      id: "unknown-name",
      mode: "work",
      error: {
        name: secret,
        data: { message: secret, statusCode: 401, hostCode: secret },
        toObject: () => ({ name: secret, data: { secret } }),
      },
      expected: { name: "UnknownError", data: { message: "Request failed." } },
    },
    {
      id: "invalid-fields",
      mode: "assistant",
      error: {
        name: "APIError",
        data: { message: secret, statusCode: secret, isRetryable: secret, hostCode: secret, metadata: { secret } },
      },
      expected: { name: "APIError", data: { message: "Model request failed." } },
    },
    {
      id: "host-class",
      mode: "work",
      error: new MessageV2.APIError({
        message: secret,
        statusCode: 429,
        isRetryable: true,
        hostCode: "mimo_desktop.rate_limited",
        metadata: { secret },
      }),
      expected: {
        name: "APIError",
        data: {
          message: "Too Many Requests.",
          statusCode: 429,
          isRetryable: true,
          hostCode: "mimo_desktop.rate_limited",
        },
      },
    },
    {
      id: "context-class",
      mode: "assistant",
      error: new MessageV2.ContextOverflowError({ message: secret, responseBody: secret }).toObject(),
      expected: { name: "ContextOverflowError", data: { message: "ContextOverflowError" } },
    },
    {
      id: "assistant-unknown",
      mode: "assistant",
      error: { name: secret, data: { message: secret, responseBody: secret, statusCode: 401 } },
      expected: { name: "UnknownError", data: { message: "Request failed." } },
    },
    {
      id: "invalid-status",
      mode: "assistant",
      error: { name: "APIError", data: { message: secret, statusCode: 999, isRetryable: { secret } } },
      expected: { name: "APIError", data: { message: "Model request failed." } },
    },
    {
      id: "fractional-status",
      mode: "assistant",
      error: { name: "APIError", data: { message: secret, statusCode: 401.5, isRetryable: false } },
      expected: { name: "APIError", data: { message: "Model request failed.", isRetryable: false } },
    },
  ]
  const response = await Server.Default().app.request(`/event?directory=${encodeURIComponent(tmp.path)}`)
  const reader = response.body!.getReader()
  const decode = new TextDecoder()
  try {
    expect(decode.decode((await reader.read()).value)).toContain("server.connected")
    const receipts = new Map<string, SessionRequests.Info>()
    for (const item of cases) {
      const accepted = await Instance.provide({
        directory: tmp.path,
        fn: () =>
          AppRuntime.runPromise(
            SessionRequests.Service.use((requests) =>
              requests.submit(
                { sessionID, runtimeID, requestID: item.id, kind: "command", payload: {} },
                item.mode === "assistant"
                  ? Effect.succeed({ info: { role: "assistant", error: item.error }, parts: [] })
                  : Effect.fail(item.error),
                item.mode === "prepare" ? Effect.fail(item.error) : undefined,
              ),
            ),
          ),
      })
      expect(JSON.stringify(accepted)).not.toContain(secret)
      const receipt = await api.wait(item.id)
      expect(receipt.status).toBe("failed")
      expect(receipt.error).toEqual(item.expected)
      expect(JSON.stringify(receipt)).not.toContain(secret)
      receipts.set(item.id, receipt)
    }
    const listed = await (await api.request("request")).json()
    expect(JSON.stringify(listed)).not.toContain(secret)
    const terminal = new Map<string, SessionRequests.Info>()
    let buffer = ""
    while (terminal.size < cases.length) {
      const chunk = await reader.read()
      if (chunk.done) throw new Error("SSE closed before receipt terminal events")
      buffer += decode.decode(chunk.value, { stream: true })
      const frames = buffer.split("\n\n")
      buffer = frames.pop() ?? ""
      for (const frame of frames) {
        if (!frame.startsWith("data: ")) continue
        const event = JSON.parse(frame.slice(6))
        if (event.type !== "session.request.updated") continue
        expect(frame).not.toContain(secret)
        const receipt = SessionRequests.Info.parse(event.properties)
        if (receipt.status === "failed") terminal.set(receipt.requestID, receipt)
      }
    }
    expect(terminal).toEqual(receipts)
    expect(provider.data.responseBody).toBe(secret)
  } finally {
    await reader.cancel()
    HostErrorRegistry.loadHostErrorCatalog(previousCatalog)
  }
}, 30_000)

// [TP-RUN-R13-06] Admission includes reservations and cannot recapture a replacement.
test("HTTP Stop freezes actor reservations before 202 and preserves replacements", async () => {
  await using tmp = await tmpdir({ git: true })
  const run = <A>(work: Effect.Effect<A, never, ActorExecution.Service | Session.Service>) =>
    Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(work) })
  const sessionID = (await run(Session.Service.use((svc) => svc.create({ title: "reservation stop" })))).id
  const api = client(tmp.path, sessionID)
  const { runtimeID } = (await (await api.request("request")).json()) as { runtimeID: string }
  const old = await run(ActorExecution.Service.use((svc) => svc.reserve(sessionID, "worker")))
  const input = { runtimeID, requestID: "stop-reserved" }
  expect((await api.request("abort", input)).status).toBe(202)
  expect(old.cancelled).toBe(true)
  expect(old.groupAbort).toBe(true)
  await run(ActorExecution.Service.use((svc) => svc.release(old)))
  const next = await run(ActorExecution.Service.use((svc) => svc.reserve(sessionID, "worker")))
  try {
    expect((await api.wait("stop-reserved")).status).toBe("completed")
    expect((await api.request("abort", input)).status).toBe(202)
    expect(next.cancelled).toBe(false)
    expect(next.groupAbort).toBeUndefined()
  } finally {
    await run(ActorExecution.Service.use((svc) => svc.release(next)))
  }
}, 30_000)

// [TP-RUN-R13-02][TP-RUN-R13-06][TP-RUN-R13-07][TP-RUN-R13-08]
test("HTTP Stop retry cannot cancel a successor and old incarnation cannot replay abort", async () => {
  await using tmp = await tmpdir({ git: true })
  const sessionID = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(Session.Service.use((svc) => svc.create({ title: "stop ownership" }))).then((s) => s.id),
  })
  const api = client(tmp.path, sessionID)
  const { runtimeID } = (await (await api.request("request")).json()) as { runtimeID: string }
  expect((await api.request("resume", { runtimeID, requestID: "empty-session" })).status).toBe(202)
  const empty = await api.wait("empty-session")
  expect(empty.status).toBe("failed")
  expect(empty.assistantMessageIDs).toBeUndefined()
  expect(
    (await api.request("resume", { runtimeID, requestID: "empty-session", assistantMessageID: MessageID.ascending() }))
      .status,
  ).toBe(409)
  const user = await Instance.provide({
    directory: tmp.path,
    fn: () =>
      AppRuntime.runPromise(
        Session.Service.use((svc) =>
          svc.updateMessage({
            id: MessageID.ascending(),
            sessionID,
            role: "user",
            agent: "build",
            model,
            time: { created: Date.now() },
          }),
        ),
      ),
  })
  ResumeTestHooks.beforeAdmissionRecheck = () => Effect.never
  expect((await api.request("resume", { runtimeID, requestID: "first", userMessageID: user.id })).status).toBe(202)
  await api.wait("first", (r) => r.status === "handed-off")
  const stop = { runtimeID, requestID: "stop" }
  expect((await api.request("abort", stop)).status).toBe(202)
  const stopped = await api.wait("stop")
  expect(stopped.status).toBe("completed")
  expect(stopped.executionRefs).toHaveLength(1)
  expect((await api.wait("first")).status).toBe("cancelled")
  expect((await api.request("resume", { runtimeID, requestID: "second", userMessageID: user.id })).status).toBe(202)
  await api.wait("second", (r) => r.status === "handed-off")
  expect((await api.request("abort", stop)).status).toBe(202)
  expect(await api.get("stop")).toEqual(stopped)
  expect((await api.get("second")).status).toBe("handed-off")
  expect((await api.request("abort", { runtimeID, requestID: "stop-second" })).status).toBe(202)
  await api.wait("stop-second")
  await Instance.provide({ directory: tmp.path, fn: () => Instance.dispose() })
  const fresh = (await (await api.request("request")).json()) as { runtimeID: string; requests: unknown[] }
  expect(fresh.runtimeID).not.toBe(runtimeID)
  expect(fresh.requests).toEqual([])
  expect((await api.request("abort", stop)).status).toBe(410)
  expect((await api.request("request/first", undefined, `&runtimeID=${runtimeID}`)).status).toBe(410)
  expect((await api.request("request/first")).status).toBe(404)
  expect((await api.request("prompt_async", { requestID: "missing-runtime", parts: [] })).status).toBe(400)
}, 30_000)
