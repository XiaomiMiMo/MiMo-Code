import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Fiber } from "effect"
import { createOpencodeClient } from "@mimo-ai/sdk/v2"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { ResumeTestHooks } from "../../src/session/resume-test-hooks"
import { MessageID, PartID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Log } from "../../src/util"
import { Bus } from "../../src/bus"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

describe("session turn recovery routes", () => {
  test("lists the latest incomplete assistant and accepts resume without a new prompt", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "recovery route" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now() },
        })
        const app = Server.Default().app
        const errors: unknown[] = []
        let resolveError!: () => void
        const errorSeen = new Promise<void>((resolve) => {
          resolveError = resolve
        })
        const unsubscribe = Bus.subscribe(Session.Event.Error, (event) => {
          if (event.properties.sessionID === session.id) {
            errors.push(event.properties.error)
            resolveError()
          }
        })
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const resumeQuery = `${query}&titleLocale=fr-FR`
        const listed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/recovery${query}`)))
        const candidates = yield* Effect.promise(() =>
          listed.json() as Promise<
            Array<{ kind: "assistant"; assistantMessageID: string; parentMessageID: string; created: number }>
          >,
        )
        const missing = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/turn/${MessageID.ascending()}/resume${resumeQuery}`, { method: "POST" })),
        )
        const resumed = yield* Effect.promise(() => Promise.resolve(app.request(`/session/${session.id}/turn/${assistant.id}/resume${resumeQuery}`, { method: "POST" })))
        yield* Effect.promise(() =>
          Promise.race([errorSeen, new Promise((resolve) => setTimeout(resolve, 10_000))]),
        )
        // post-resume observable signals (not pre-resume candidates)
        yield* Effect.sleep("150 millis")
        const afterListed = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/recovery${query}`)),
        )
        const afterCandidates = yield* Effect.promise(() =>
          afterListed.json() as Promise<Array<{ assistantMessageID: string }>>,
        )
        unsubscribe()
        const after = yield* sessions.messages({ sessionID: session.id, agentID: "main" })
        const abandoned = after.find((item) => item.info.id === assistant.id)?.info
        const abandonedAssistant = abandoned?.role === "assistant" ? abandoned : undefined
        return {
          listed: listed.status,
          candidates,
          resumed: resumed.status,
          missing: missing.status,
          userID: user.id,
          errors,
          abandoned: abandonedAssistant,
          shellRemoved: abandoned === undefined,
          afterNoLongerListsShell: !afterCandidates.some((c) => c.assistantMessageID === assistant.id),
          afterMessageCount: after.length,
          afterMessages: after.map((m) => ({ info: { role: m.info.role, id: m.info.id } })),
        }
      })),
    })

    expect(result.listed).toBe(200)
    expect(result.candidates).toEqual([
      {
        kind: "assistant",
        assistantMessageID: expect.any(String),
        parentMessageID: result.userID,
        created: expect.any(Number),
      },
    ])
    // [TP-SR-R21-16] HTTP resume admitted (202) and empty residue shell cleaned
    expect(result.resumed).toBe(202)
    expect(result.missing).toBe(404)
    expect(result.shellRemoved).toBe(true)
    // Both must hold for empty-tail resume; not an OR against pre-resume candidates.
    expect(result.afterNoLongerListsShell).toBe(true)
    // Work proof independent of shellRemoved: session error bus fired (runLoop without provider)
    // OR a new assistant message appeared after cleanup.
    const newAssistants = result.afterMessages.filter(
      (m: { info: { role: string; id: string } }) => m.info.role === "assistant",
    )
    expect(result.errors.length > 0 || newAssistants.length > 0).toBe(true)
    if (result.abandoned?.error) {
      const err = result.abandoned.error as { data?: { message?: string } }
      const abandonMsg = err.data?.message ?? ""
      expect(abandonMsg).not.toContain("Abandoned: resumed as a new assistant turn")
    }
  })
})

test("SDK serializes resume titleLocale in the query string", async () => {
  let captured: Request | undefined
  const fetchMock = Object.assign(
    async (request: RequestInfo | URL) => {
      captured = request instanceof Request ? request : new Request(request)
      return new Response(null, { status: 202 })
    },
    { preconnect: () => {} },
  )
  const client = createOpencodeClient({
    baseUrl: "http://example.test",
    fetch: fetchMock,
  })

  await client.session.resume({
    sessionID: "ses_test",
    assistantMessageID: "msg_test",
    titleLocale: "fr-FR",
  })

  expect(captured).toBeDefined()
  const url = new URL(captured!.url)
  expect(url.pathname).toBe("/session/ses_test/turn/msg_test/resume")
  expect(url.searchParams.get("titleLocale")).toBe("fr-FR")
  expect(captured!.body).toBeNull()
})

// [TP-SR-R21-07] Recovery predicate: completed+tool-calls / completed+length / no completed are candidates;
// completed+stop / completed+other are not.
describe("recovery candidate predicate", () => {
  async function setupAssistant(overrides: Partial<{ finish: string; completed: boolean; error: boolean }>) {
    await using tmp = await tmpdir({ git: true })
    return Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "predicate" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const assistant = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: overrides.completed
            ? { created: Date.now(), completed: Date.now() }
            : { created: Date.now() },
          ...(overrides.finish ? { finish: overrides.finish as "stop" | "length" | "tool-calls" | "other" } : {}),
          ...(overrides.error ? { error: { name: "APIError", data: { message: "model unavailable", statusCode: 503, isRetryable: true } } } : {}),
        } as Parameters<typeof sessions.updateMessage>[0])
        const candidates = yield* SessionPrompt.Service.use((svc) =>
          svc.recovery({ sessionID: session.id, agentID: "main" }),
        )
        return { candidates, assistantId: assistant.id }
      })),
    })
  }

  test("completed + tool-calls → candidate", async () => {
    const result = await setupAssistant({ completed: true, finish: "tool-calls" })
    expect(result.candidates.length).toBe(1)
    const c0 = result.candidates[0]!;
    expect(c0.kind).toBe("assistant");
    if (c0.kind === "assistant") expect(c0.assistantMessageID).toBe(result.assistantId)
  })

  test("completed + length → candidate", async () => {
    const result = await setupAssistant({ completed: true, finish: "length" })
    expect(result.candidates.length).toBe(1)
  })

  test("no completed → candidate", async () => {
    const result = await setupAssistant({ completed: false })
    expect(result.candidates.length).toBe(1)
  })

  test("completed + stop → NOT candidate", async () => {
    const result = await setupAssistant({ completed: true, finish: "stop" })
    expect(result.candidates.length).toBe(0)
  })

  test("completed + other → NOT candidate", async () => {
    const result = await setupAssistant({ completed: true, finish: "other" })
    expect(result.candidates.length).toBe(0)
  })

  // [Finding #1 regression] finish=stop but error set: processor does not write completed on error => recoverable.
  test("finish=stop + error → candidate (error means not completed)", async () => {
    const result = await setupAssistant({ completed: false, finish: "stop", error: true })
    expect(result.candidates.length).toBe(1)
  })

  // error + no completed: any finish is a candidate (error means not finished).
  test("error + no completed → candidate", async () => {
    const result = await setupAssistant({ completed: false, error: true })
    expect(result.candidates.length).toBe(1)
  })
})

// [TP-SR-R21-08] model params: modelProviderID / modelID must be provided together.
test("resume with only modelProviderID returns 400", async () => {
  await using tmp = await tmpdir({ git: true })
  const result = await Instance.provide({
    directory: tmp.path,
    fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "model-param" })
      const app = Server.Default().app
      const res = yield* Effect.promise(() =>
        Promise.resolve(app.request(`/session/${session.id}/turn/msg_test/resume?directory=${encodeURIComponent(tmp.path)}&modelProviderID=test`, { method: "POST" })),
      )
      return res.status
    })),
  })
  expect(result).toBe(400)
})

// [TP-SR-R21-17][D16f] Trailing user is a recovery target when it is the slice tail.
describe("trailing user recovery target", () => {
  test("last message is user → parent-user candidate", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "trailing user" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const candidates = yield* prompt.recovery({ sessionID: session.id, agentID: "main" })
        expect(candidates).toEqual([
          { kind: "parent-user", userMessageID: user.id, created: user.time.created },
        ])
      })),
    })
  })

  test("tool-calls assistant then trailing user → only parent-user (assistant disqualified)", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "notify after tool-calls" })
        const user1 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "assistant",
          parentID: user1.id,
          sessionID: session.id,
          mode: "build",
          agent: "build",
          path: { cwd: tmp.path, root: tmp.path },
          cost: 0,
          tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
          modelID: ModelID.make("test-model"),
          providerID: ProviderID.make("test"),
          time: { created: Date.now(), completed: Date.now() },
          finish: "tool-calls",
        } as Parameters<typeof sessions.updateMessage>[0])
        const user2 = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() + 1 },
        })
        const candidates = yield* prompt.recovery({ sessionID: session.id, agentID: "main" })
        expect(candidates).toEqual([
          { kind: "parent-user", userMessageID: user2.id, created: user2.time.created },
        ])
      })),
    })
  })

  // [TP-SR-R21-02][closed-loop][R004] Clients may pass only sessionID; engine picks latest recovery candidate.
  // Asserts the *actual plan target* (via ResumeTestHooks.onPlanResolved) matches the recovery tail —
  // not just HTTP 202, and not a pre-route independent recovery() read.
  test("POST /resume with empty body resumes latest recovery candidate", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        // trailing user only → latest is parent-user
        const session = yield* sessions.create({ title: "empty-body user" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        // Capture the plan that /resume actually resolves (R004)
        let resolvedPlan: { action: string; assistantMessageID?: string; parentMessageID?: string } | undefined
        ResumeTestHooks.onPlanResolved = (plan) => { resolvedPlan = plan }
        // no recovery candidates → 404
        const empty = yield* sessions.create({ title: "empty-body none" })
        const app = Server.Default().app
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const ok = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/resume${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })),
        )
        const none = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${empty.id}/resume${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({}),
          })),
        )
        // also accept no body at all
        const noBody = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/resume${query}`, {
            method: "POST",
          })),
        )
        return {
          ok: ok.status,
          none: none.status,
          noBody: noBody.status,
          planAction: resolvedPlan?.action,
          planParent: resolvedPlan?.parentMessageID,
          userParentId: user.id,
        }
      })),
    })
    // R004: the plan /resume actually resolved must target the trailing user (parent-user resume)
    expect(result.planAction).toBe("user-resume")
    expect(result.planParent).toBe(result.userParentId)
    expect(result.ok).toBe(202)
    expect(result.none).toBe(404)
    // second resume on already-busy session after first 202 → 409
    expect(result.noBody === 202 || result.noBody === 409).toBe(true)
  })

  // [TP-SR-R21-10] resumeUser 202=完成准入；缺失目标 404（非 false 202）。
  test("POST /resume with userMessageID validates trailing user", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () => AppRuntime.runPromise(Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "resume user route" })
        const user = yield* sessions.updateMessage({
          id: MessageID.ascending(),
          role: "user",
          sessionID: session.id,
          agent: "build",
          model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
          time: { created: Date.now() },
        })
        const session2 = yield* sessions.create({ title: "resume user missing" })
        const app = Server.Default().app
        const query = `?directory=${encodeURIComponent(tmp.path)}`
        const ok = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session.id}/resume${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userMessageID: user.id }),
          })),
        )
        // fresh session with no trailing user → 404 (not busy)
        const missing = yield* Effect.promise(() =>
          Promise.resolve(app.request(`/session/${session2.id}/resume${query}`, {
            method: "POST",
            headers: { "Content-Type": "application/json" },
            body: JSON.stringify({ userMessageID: MessageID.ascending() }),
          })),
        )
        return { ok: ok.status, missing: missing.status }
      })),
    })
    expect(result.ok).toBe(202)
    expect(result.missing).toBe(404)
  })

  // [TP-SR-R21-10][C001] admission 失败必须 404，不得 false 202（resumeUser 准入契约）。
  test("POST /resume returns 404 when admission re-check sees a later user (not false 202)", async () => {
    await using tmp = await tmpdir({ git: true })
    const result = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const session = yield* sessions.create({ title: "c001-http-admission" })
            const user = yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() },
            })
            yield* sessions.updatePart({
              id: PartID.ascending(),
              messageID: user.id,
              sessionID: session.id,
              type: "text",
              text: "trailing",
            })
            let markReached!: () => void
            const reached = new Promise<void>((done) => {
              markReached = done
            })
            let release!: () => void
            const released = new Promise<void>((done) => {
              release = done
            })
            ResumeTestHooks.beforeAdmissionRecheck = () =>
              Effect.sync(() => markReached()).pipe(Effect.flatMap(() => Effect.promise(() => released)))
            const app = Server.Default().app
            const query = `?directory=${encodeURIComponent(tmp.path)}`
            const fiber = yield* Effect.promise(() =>
              Promise.resolve(
                app.request(`/session/${session.id}/resume${query}`, {
                  method: "POST",
                  headers: { "Content-Type": "application/json" },
                  body: JSON.stringify({ userMessageID: user.id }),
                }),
              ),
            ).pipe(Effect.forkChild)
            yield* Effect.promise(() => reached)
            yield* sessions.updateMessage({
              id: MessageID.ascending(),
              role: "user",
              sessionID: session.id,
              agent: "build",
              model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
              time: { created: Date.now() + 5 },
            })
            release()
            const response = yield* Fiber.join(fiber)
            const body = (yield* Effect.promise(() => response.json())) as {
              data?: { name?: string; data?: { message?: string } }
            }
            ResumeTestHooks.reset()
            return { status: response.status, name: body?.data?.name, message: body?.data?.data?.message ?? "" }
          }),
        ),
    })
    expect(result.status).toBe(404)
    expect(result.name).toBe("NotFoundError")
    expect(result.message).toContain("stale at runner admission")
  })
})

// [R002] SDK contract: recovery union + resumeUser serialization
test("SDK recovery response is union and resumeUser posts body userMessageID", async () => {
  const calls: Array<{ url: string; method: string; body: unknown }> = []
  const fetchMock = Object.assign(
    async (input: RequestInfo | URL, init?: RequestInit) => {
      const url = typeof input === "string" ? input : input instanceof URL ? input.href : input.url
      const method = init?.method ?? (input instanceof Request ? input.method : "GET")
      let body: unknown = undefined
      const raw = init?.body ?? (input instanceof Request ? undefined : undefined)
      if (typeof raw === "string") body = JSON.parse(raw)
      else if (input instanceof Request && input.method !== "GET") {
        try { body = await input.clone().json() } catch { body = undefined }
      }
      calls.push({ url, method, body })
      if (url.includes("/recovery")) {
        return new Response(
          JSON.stringify([
            { kind: "assistant", assistantMessageID: "msg_a", parentMessageID: "msg_u", created: 1 },
            { kind: "parent-user", userMessageID: "msg_u2", created: 2 },
          ]),
          { status: 200, headers: { "Content-Type": "application/json" } },
        )
      }
      return new Response(null, { status: 202 })
    },
    { preconnect: () => {} },
  )
  const client = createOpencodeClient({ baseUrl: "http://example.test", fetch: fetchMock })
  const listed = await client.session.recovery({ sessionID: "ses_test" })
  expect(listed.data).toEqual([
    { kind: "assistant", assistantMessageID: "msg_a", parentMessageID: "msg_u", created: 1 },
    { kind: "parent-user", userMessageID: "msg_u2", created: 2 },
  ])
  await client.session.resumeUser({ sessionID: "ses_test", userMessageID: "msg_u2", titleLocale: "fr-FR" })
  const resumeCall = calls.find((c) => c.url.includes("/session/ses_test/resume") && !c.url.includes("/recovery"))
  expect(resumeCall).toBeDefined()
  expect(resumeCall!.method).toBe("POST")
  expect(resumeCall!.body).toEqual({ userMessageID: "msg_u2" })
  expect(resumeCall!.url).toContain("titleLocale=fr-FR")
})
