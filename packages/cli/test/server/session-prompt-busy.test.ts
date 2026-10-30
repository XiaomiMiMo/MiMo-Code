import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import path from "path"
import { Effect, Layer } from "effect"
import { Hono } from "hono"
import { ErrorMiddleware } from "../../src/server/middleware"
import { Server } from "../../src/server/server"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { inboxServiceRef } from "../../src/inbox/inbox-ref"
import * as Inbox from "../../src/inbox/inbox"
import { Actor } from "../../src/actor/spawn"
import { ActorRegistry } from "../../src/actor/registry"
import { SessionRunState } from "../../src/session/run-state"
import { AppRuntime } from "../../src/effect/app-runtime"
import { schedulerRef } from "../../src/inbox/scheduler"
import { MessageID, type SessionID } from "../../src/session/schema"
import { MessageTable } from "../../src/session/session.sql"
import type { MessageV2 } from "../../src/session/message-v2"
import { Database, eq } from "../../src/storage"
import { InboxTable, InboxSessionEpochTable } from "../../src/inbox/inbox.sql"
import { PublicReceipt, type Receipt } from "../../src/inbox/schema"
import { GlobalBus, type GlobalEvent } from "../../src/bus/global"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { TestLLMServer } from "../lib/llm-server"

void Log.init({ print: false })

const model = { providerID: "alibaba", modelID: "qwen-plus" }

async function until<T>(read: () => Promise<T>, ready: (value: T) => boolean): Promise<T> {
  const deadline = Date.now() + 15_000
  while (true) {
    const value = await read()
    if (ready(value)) return value
    if (Date.now() >= deadline) throw new Error(`HTTP contract timed out: ${JSON.stringify(value)}`)
    await Bun.sleep(10)
  }
}

function fixture(run: (http: ReturnType<typeof client>, llm: TestLLMServer["Service"]) => Promise<void>) {
  // Only the LLM fixture has its own runtime; HTTP must use the production AppRuntime graph.
  return Effect.runPromise(
    Effect.gen(function* () {
      const llm = yield* TestLLMServer
      yield* Effect.promise(async () => {
        await using tmp = await tmpdir({
          git: true,
          config: {
            enabled_providers: ["alibaba"],
            provider: { alibaba: { options: { apiKey: "test-key", baseURL: llm.url } } },
            model: "alibaba/qwen-plus",
            small_model: "alibaba/qwen-plus",
            agent: { build: { model: "alibaba/qwen-plus" } },
          },
        })
        try {
          await run(client(tmp.path), llm)
        } finally {
          await Instance.disposeAll()
        }
      })
    }).pipe(Effect.provide(TestLLMServer.layer), Effect.scoped),
  )
}

function client(directory: string) {
  const app = Server.Default().app
  const request = (route: string, init?: RequestInit) =>
    app.request(`${route}?directory=${encodeURIComponent(directory)}`, init)
  const post = (route: string, body?: unknown, signal?: AbortSignal) =>
    request(route, {
      method: "POST",
      ...(body === undefined ? {} : { headers: { "Content-Type": "application/json" }, body: JSON.stringify(body) }),
      signal,
    })
  return {
    directory,
    request,
    post,
    async session() {
      const response = await post("/session", { title: "HTTP inbox contract" })
      expect(response.status).toBe(200)
      return (await response.json()) as Session.Info
    },
    async receipt(sessionID: SessionID, receiptId: string) {
      const response = await request(`/session/${sessionID}/receipt/${receiptId}`)
      expect(response.status).toBe(200)
      return (await response.json()) as Receipt
    },
    async publicReceipt(sessionID: SessionID, receiptId: string) {
      const response = await request(`/session/${sessionID}/receipt/${receiptId}`)
      expect(response.status).toBe(200)
      const raw = (await response.json()) as Record<string, unknown>
      return { raw, parsed: PublicReceipt.parse(raw) }
    },
    async messages(sessionID: SessionID) {
      const response = await request(`/session/${sessionID}/message`)
      expect(response.status).toBe(200)
      return (await response.json()) as MessageV2.WithParts[]
    },
  }
}

type Http = ReturnType<typeof client>

function rows(sessionID: SessionID) {
  return Database.use((db) =>
    db.select().from(InboxTable).where(eq(InboxTable.receiver_session_id, sessionID)).all(),
  )
}

function epoch(sessionID: SessionID) {
  return (
    Database.use((db) =>
      db.select().from(InboxSessionEpochTable).where(eq(InboxSessionEpochTable.session_id, sessionID)).get(),
    )?.epoch ?? 0
  )
}

async function accepted(http: Http, sessionID: SessionID, response: Response, messageID: MessageID) {
  expect(response.status).toBe(202)
  // Check SQLite without yielding after the response: background admission must not repair a premature 202.
  const persisted = rows(sessionID).filter((row) => row.input_message_id === messageID)
  expect(persisted).toHaveLength(1)
  const message = Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get())
  expect(message?.session_id).toBe(sessionID)
  expect(message?.data.role).toBe("user")
  const body = (await response.json()) as { receiptId: string }
  expect(body.receiptId).toEqual(expect.any(String))
  expect(body.receiptId.length).toBeGreaterThan(0)
  expect(persisted[0].id).toBe(body.receiptId)
  const receipt = await http.receipt(sessionID, body.receiptId)
  expect(receipt.id).toBe(body.receiptId)
  expect(receipt.lane).toEqual({ sessionID, agentID: "main" })
  expect(receipt.inputMessageID).toBe(messageID)
  expect(receipt.type).toBe("prompt")
  return receipt
}

async function settled(http: Http, sessionID: SessionID, receiptId: string) {
  const receipt = await until(
    () => http.receipt(sessionID, receiptId),
    (value) => value.state === "settled",
  )
  expect(receipt.outcome).toBe("success")
  expect(receipt.consumed).toBe(true)
  return receipt
}

async function started(llm: TestLLMServer["Service"], text: string) {
  await until(
    () => Effect.runPromise(llm.inputs),
    (inputs) => inputs.some((input) => JSON.stringify(input).includes(text)),
  )
}

function answered(messages: MessageV2.WithParts[], text: string) {
  return messages.find((message) =>
    message.parts.some((part) => part.type === "text" && part.text === text),
  )
}

async function controlled(
  http: Http,
  llm: TestLLMServer["Service"],
  sessionID: SessionID,
  signal?: AbortSignal,
  answer = "controlled first answer",
) {
  const gate = Promise.withResolvers<void>()
  await Effect.runPromise(llm.hold(answer, gate.promise))
  const messageID = MessageID.ascending()
  const text = `controlled first ${messageID}`
  const response = await http.post(
    `/session/${sessionID}/message`,
    {
      messageID,
      model,
      parts: [{ type: "text", text }],
    },
    signal,
  )
  expect([200, 202]).toContain(response.status)
  await started(llm, text)
  const persisted = rows(sessionID).filter((row) => row.input_message_id === messageID)
  expect(persisted).toHaveLength(1)
  expect(persisted[0].state).toBe("claimed")
  return { response, release: () => gate.resolve(), receiptId: persisted[0].id, messageID }
}

async function child(http: Http, sessionID: SessionID) {
  const finish = Promise.withResolvers<void>()
  const message = (await http.messages(sessionID))[0]
  const snapshot = await Instance.provide({
    directory: http.directory,
    fn: () =>
      AppRuntime.runPromise(
        Effect.gen(function* () {
          const registry = yield* ActorRegistry.Service
          const state = yield* SessionRunState.Service
          yield* registry.register({
            sessionID,
            actorID: "isolation-child",
            mode: "subagent",
            agent: "explore",
            description: "isolation child",
            contextMode: "none",
            background: true,
            lifecycle: "ephemeral",
            tools: [],
          })
          yield* registry.updateStatus(sessionID, "isolation-child", { status: "running" })
          yield* state.start(
            sessionID,
            "isolation-child",
            Effect.never,
            Effect.promise(() => finish.promise).pipe(
              Effect.as(message),
              Effect.ensuring(registry.updateStatus(sessionID, "isolation-child", { status: "idle" })),
            ),
          )
          return yield* state.executionSnapshot(sessionID, "isolation-child")
        }),
      ),
  })
  return { ...snapshot, release: () => finish.resolve() }
}

describe("ErrorMiddleware → BusyError mapping", () => {
  test("BusyError still maps to HTTP 409 for non-admitting operations", async () => {
    const app = new Hono()
    app.get("/throw-busy", () => {
      throw new Session.BusyError("ses_test_busy")
    })
    app.onError(ErrorMiddleware)
    const res = await app.request("/throw-busy")
    expect(res.status).toBe(409)
    const body = (await res.json()) as { data: { message: string } }
    expect(body.data.message).toContain("ses_test_busy")
  })
})

describe("HTTP Inbox admission", () => {
  test("a seedless inbox remains pending until a real HTTP input wakes and consumes it", () => fixture(async (http, llm) => {
    const session = await http.session()
    const input = await Instance.provide({ directory: http.directory, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
      yield* Actor.Service
      const inbox = inboxServiceRef.current
      if (!inbox) throw new Error("Inbox service missing")
      yield* Inbox.Service.use(scoped => Effect.sync(() => {
        expect(scoped).not.toBe(inbox)
        expect(inboxServiceRef.current).toBe(scoped)
      })).pipe(Effect.provide(Layer.fresh(Inbox.defaultLayer)), Effect.scoped)
      expect(inboxServiceRef.current).toBe(inbox)
      const input = yield* inbox.accept({ receiverSessionID: session.id, receiverActorID: "main", content: "HTTP-SEEDLESS-INBOX" })
      const scheduler = schedulerRef.current
      if (!scheduler) throw new Error("Inbox scheduler missing")
      yield* scheduler.kick({ sessionID: session.id, agentID: "main" })
      return input
    })) })
    await Bun.sleep(100)
    expect((await http.receipt(session.id, input.inboxID)).state).toBe("accepted")
    expect(await Effect.runPromise(llm.calls)).toBe(0)
    await Effect.runPromise(llm.text("HTTP-SEED-RESPONSE"))
    const response = await http.post(`/session/${session.id}/prompt_async`, { agent: "build", model,
      parts: [{ type: "text", text: "HTTP-VALID-SEED" }] })
    expect(response.status).toBe(202)
    const receipt = await response.json() as { receiptId: string }
    await until(() => http.receipt(session.id, receipt.receiptId), value => value.state === "settled")
    expect(await http.receipt(session.id, input.inboxID)).toMatchObject({ state: "settled", outcome: "success", consumed: true })
    expect(await Effect.runPromise(llm.calls)).toBe(1)
    const inputs = await Effect.runPromise(llm.inputs)
    expect(JSON.stringify(inputs[0].messages)).toContain("HTTP-SEEDLESS-INBOX")
    expect(JSON.stringify(inputs[0].messages)).toContain("HTTP-VALID-SEED")
  }), 30_000)
  for (const content of [
    { name: "whitespace-only", part: { type: "text", text: " \t\n  " } },
    { name: "ignored-only", part: { type: "text", text: "ignored scaffolding", ignored: true } },
  ]) {
    test(
      `prompt_async ${content.name} returns 204 without a user message, receipt or model call`,
      () =>
        fixture(async (http, llm) => {
          const session = await http.session()
          const messageID = MessageID.ascending()
          const response = await http.post(`/session/${session.id}/prompt_async`, {
            messageID,
            model,
            noReply: false,
            parts: [content.part],
          })
          expect(response.status).toBe(204)
          expect(rows(session.id)).toHaveLength(0)
          expect(
            Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.session_id, session.id)).all()),
          ).toHaveLength(0)
          expect(await response.text()).toBe("")
          expect(await http.messages(session.id)).toEqual([])
          expect(await Effect.runPromise(llm.calls)).toBe(0)
        }),
      30_000,
    )

    test(
      `busy /message ${content.name} returns 204 without adding messages, receipts or model calls`,
      () =>
        fixture(async (http, llm) => {
          const session = await http.session()
          const first = await controlled(http, llm, session.id)
          try {
            const beforeMessages = await http.messages(session.id)
            const beforeReceipts = rows(session.id)
            const beforeCalls = await Effect.runPromise(llm.calls)
            const messageID = MessageID.ascending()
            const response = await http.post(`/session/${session.id}/message`, {
              messageID,
              model,
              noReply: false,
              parts: [content.part],
            })
            expect(response.status).toBe(204)
            expect(rows(session.id)).toEqual(beforeReceipts)
            expect(
              Database.use((db) => db.select().from(MessageTable).where(eq(MessageTable.id, messageID)).get()),
            ).toBeUndefined()
            expect(await response.text()).toBe("")
            const messages = await http.messages(session.id)
            expect(messages.map((message) => message.info.id)).toEqual(beforeMessages.map((message) => message.info.id))
            expect(await Effect.runPromise(llm.calls)).toBe(beforeCalls)
            expect((await http.receipt(session.id, first.receiptId)).state).toBe("claimed")
            first.release()
            await settled(http, session.id, first.receiptId)
            await first.response.text()
            expect(rows(session.id).map((receipt) => receipt.id)).toEqual(beforeReceipts.map((receipt) => receipt.id))
            expect(await Effect.runPromise(llm.calls)).toBe(beforeCalls)
          } finally {
            first.release()
          }
        }),
      30_000,
    )
  }

  test(
    "prompt_async noReply:true returns 204 and writes plain history with no receipt or model call",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const messageID = MessageID.ascending()
        const response = await http.post(`/session/${session.id}/prompt_async`, {
          messageID,
          model,
          noReply: true,
          parts: [{ type: "text", text: "persist without model reply" }],
        })
        expect(response.status).toBe(204)
        expect(await response.text()).toBe("")
        expect(rows(session.id)).toHaveLength(0)
        const messages = await http.messages(session.id)
        expect(messages.map((message) => message.info.id)).toEqual([messageID])
        expect(messages[0].info.role).toBe("user")
        expect(await Effect.runPromise(llm.calls)).toBe(0)
      }),
    30_000,
  )

  test(
    "prompt_async returns a durable GET-able receipt before 202; receipts are session-scoped",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const other = await http.session()
        const messageID = MessageID.ascending()
        await Effect.runPromise(llm.text("scoped receipt answer"))
        const response = await http.post(`/session/${session.id}/prompt_async`, {
          messageID,
          model,
          parts: [{ type: "text", text: "scoped receipt prompt" }],
        })
        const receipt = await accepted(http, session.id, response, messageID)
        const foreign = await http.request(`/session/${other.id}/receipt/${receipt.id}`)
        expect(foreign.status).toBe(404)
        const missing = await http.request(`/session/${session.id}/receipt/receipt-does-not-exist`)
        expect(missing.status).toBe(404)
        expect((await http.receipt(session.id, receipt.id)).id).toBe(receipt.id)
        await settled(http, session.id, receipt.id)
      }),
    30_000,
  )

  test(
    "prompt_async noReply:false actually starts the model and settles its durable receipt",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const messageID = MessageID.ascending()
        const text = `async executable ${messageID}`
        await Effect.runPromise(llm.text("async HTTP answer"))
        const response = await http.post(`/session/${session.id}/prompt_async`, {
          messageID,
          model,
          noReply: false,
          parts: [{ type: "text", text }],
        })
        const receipt = await accepted(http, session.id, response, messageID)
        await started(llm, text)
        await settled(http, session.id, receipt.id)
        const messages = await http.messages(session.id)
        expect(messages.filter((message) => message.info.id === messageID)).toHaveLength(1)
        expect(
          messages
            .flatMap((message) => message.parts)
            .some((part) => part.type === "text" && part.text === "async HTTP answer"),
        ).toBe(true)
        expect(rows(session.id).filter((row) => row.input_message_id === messageID)).toHaveLength(1)
      }),
    30_000,
  )

  test(
    "busy /message returns 202 with a durable receipt that is consumed without another request",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const first = await controlled(http, llm, session.id)
        try {
          const messageID = MessageID.ascending()
          const text = `queued while model busy ${messageID}`
          await Effect.runPromise(llm.text("queued HTTP answer"))
          const response = await http.post(`/session/${session.id}/message`, {
            messageID,
            model,
            parts: [{ type: "text", text }],
          })
          const receipt = await accepted(http, session.id, response, messageID)
          expect(receipt.state).toBe("accepted")
          first.release()
          await started(llm, text)
          await settled(http, session.id, receipt.id)
          await settled(http, session.id, first.receiptId)
          await first.response.text()
          const messages = await http.messages(session.id)
          expect(messages.filter((message) => message.info.id === messageID)).toHaveLength(1)
          expect(
            messages
              .flatMap((message) => message.parts)
              .some((part) => part.type === "text" && part.text === "queued HTTP answer"),
          ).toBe(true)
          expect(rows(session.id).filter((row) => row.input_message_id === messageID)).toHaveLength(1)
        } finally {
          first.release()
        }
      }),
    30_000,
  )

  test(
    "interjected prompt delivered to the model publishes deliveryMessageID and exposes it on the public GET receipt",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const events: Array<{ deliveryMessageID?: string; receiptId: string; state: string }> = []
        const listener = (event: GlobalEvent) => {
          const payload = event.payload
          if (payload.type !== "session.receipt.updated") return
          if (payload.properties?.sessionID !== session.id) return
          events.push({
            receiptId: payload.properties.receiptId,
            state: payload.properties.state,
            deliveryMessageID: payload.properties.deliveryMessageID,
          })
        }
        GlobalBus.on("event", listener)
        try {
          const first = await controlled(http, llm, session.id)
          try {
            const messageID = MessageID.ascending()
            const text = `interjected delivery ${messageID}`
            await Effect.runPromise(llm.text("interjected HTTP answer"))
            const response = await http.post(`/session/${session.id}/message`, {
              messageID,
              model,
              parts: [{ type: "text", text }],
            })
            const queued = await accepted(http, session.id, response, messageID)
            expect(queued.deliveryMessageID).toBeUndefined()
            first.release()
            await started(llm, text)
            // Wait for the answering assistant step to land before reading the anchor.
            const answer = await until(
              () => http.messages(session.id),
              (messages) => answered(messages, "interjected HTTP answer") !== undefined,
            ).then((messages) => answered(messages, "interjected HTTP answer")!)
            const delivered = await until(
              () => http.receipt(session.id, queued.id),
              (value) => value.deliveryMessageID !== undefined,
            )
            // deliveryMessageID is the first assistant step that read this input.
            expect(delivered.deliveryMessageID).toBe(answer.info.id)
            const { raw, parsed } = await http.publicReceipt(session.id, queued.id)
            expect(parsed.deliveryMessageID).toBe(answer.info.id)
            for (const internal of ["runId", "claimFrontier", "idempotencyKey", "time"] as const)
              expect(raw).not.toHaveProperty(internal)
            await settled(http, session.id, queued.id)
            await settled(http, session.id, first.receiptId)
            const anchor = await until(
              async () => events.find((event) => event.receiptId === queued.id && event.deliveryMessageID !== undefined),
              (value) => value !== undefined,
            )
            expect(anchor!.deliveryMessageID).toBe(answer.info.id)
            expect(anchor!.state).toBe("claimed")
          } finally {
            first.release()
          }
        } finally {
          GlobalBus.off("event", listener)
        }
      }),
    30_000,
  )
})

describe("HTTP abort and transport ownership", () => {
  for (const policy of [undefined, "drop"] as const) {
    test(
      `abort ${policy ?? "bodyless default"} increments epoch exactly once and retains fenced receipts correctly`,
      () =>
        fixture(async (http, llm) => {
          const session = await http.session()
          const first = await controlled(http, llm, session.id)
          try {
            const messageID = MessageID.ascending()
            const text = `must not restart after abort ${messageID}`
            const response = await http.post(`/session/${session.id}/message`, {
              messageID,
              model,
              parts: [{ type: "text", text }],
            })
            const receipt = await accepted(http, session.id, response, messageID)
            expect(receipt.state).toBe("accepted")
            const before = epoch(session.id)
            const abort = await http.post(
              `/session/${session.id}/abort`,
              policy === undefined ? undefined : { queuedPolicy: policy },
            )
            expect(abort.status).toBe(200)
            const body = (await abort.json()) as { epoch: number }
            expect(body.epoch).toBe(before + 1)
            expect(epoch(session.id)).toBe(body.epoch)
            const cancelled = await http.receipt(session.id, receipt.id)
            expect(cancelled.state).toBe("cancelled")
            expect(cancelled.outcome).toBe("never_ran")
            expect(cancelled.consumed).toBe(false)
            expect(cancelled.epoch).toBe(before)
            const interrupted = await http.receipt(session.id, first.receiptId)
            expect(interrupted.state).toBe("cancelled")
            expect(interrupted.epoch).toBe(before)
            first.release()
            await first.response.text()
            const nextID = MessageID.ascending()
            await Effect.runPromise(llm.text("fresh epoch answer"))
            const next = await http.post(`/session/${session.id}/prompt_async`, {
              messageID: nextID,
              model,
              parts: [{ type: "text", text: `fresh epoch ${nextID}` }],
            })
            const current = await accepted(http, session.id, next, nextID)
            expect(current.epoch).toBe(body.epoch)
            await settled(http, session.id, current.id)
            // A later successful turn must not claim or unsuspend an old-epoch receipt.
            expect(await http.receipt(session.id, receipt.id)).toEqual(cancelled)
            expect(rows(session.id).filter((row) => row.input_message_id === messageID)).toHaveLength(1)
          } finally {
            first.release()
          }
        }),
      30_000,
    )
  }

  for (const mode of ["same directory", "linked worktrees", "pending refresh"] as const) {
    const linked = mode === "linked worktrees"
    test(
      `aborting an active session preserves another active session and its queued input (${mode})`,
      () =>
        fixture(async (http, llm) => {
          await using worktree = await tmpdir({
            init: async (directory) => {
              if (!linked) return
              await $`git worktree add --detach ${directory} HEAD`.cwd(http.directory).quiet()
              await Bun.write(
                path.join(directory, "mimocode.json"),
                await Bun.file(path.join(http.directory, "mimocode.json")).text(),
              )
            },
          })
          const otherHttp = linked ? client(worktree.path) : http
          const a = await http.session()
          const b = await otherHttp.session()
          const first = await controlled(http, llm, a.id, undefined, "cancelled answer")
          const second = await controlled(otherHttp, llm, b.id, undefined, "uninterrupted answer")
          const childA = await child(http, a.id)
          const childB = await child(otherHttp, b.id)
          try {
            const beforeA = epoch(a.id)
            const beforeB = epoch(b.id)
            const queuedID = MessageID.ascending()
            await Effect.runPromise(llm.text("queued answer"))
            const queued = await accepted(
              otherHttp,
              b.id,
              await otherHttp.post(`/session/${b.id}/prompt_async`, {
                messageID: queuedID,
                model,
                parts: [{ type: "text", text: `queued input ${queuedID}` }],
              }),
              queuedID,
            )
            const original = await otherHttp.receipt(b.id, second.receiptId)
            expect(original.state).toBe("claimed")

            for (const increment of [1, 2]) {
              const response = await http.post(`/session/${a.id}/abort`)
              expect(response.status).toBe(200)
              expect(await response.json()).toMatchObject({ epoch: beforeA + increment })
              expect(epoch(b.id)).toBe(beforeB)
              expect(await otherHttp.receipt(b.id, second.receiptId)).toEqual(original)
              expect((await otherHttp.receipt(b.id, queued.id)).state).toBe("accepted")
            }
            expect(childA.isCurrent()).toBe(false)
            expect(childB.isCurrent()).toBe(true)
            expect(childB.fiber?.pollUnsafe()).toBeUndefined()
            if (mode === "pending refresh") {
              await Instance.disposeAll()
              expect(Instance.refreshStatus(otherHttp.directory).state).toBe("pending")
              expect(childB.fiber?.pollUnsafe()).toBeUndefined()
            }
            expect((await http.receipt(a.id, first.receiptId)).state).toBe("cancelled")
            first.release()
            await first.response.text()
            childB.release()
            second.release()
            await second.response.text()
            await settled(otherHttp, b.id, second.receiptId)
            await settled(otherHttp, b.id, queued.id)
            expect(answered(await otherHttp.messages(b.id), "uninterrupted answer")).toBeDefined()
            expect(answered(await otherHttp.messages(b.id), "queued answer")).toBeDefined()
            await otherHttp.post(`/session/${b.id}/abort`)
            if (mode === "pending refresh") {
              await until(
                async () => Instance.refreshStatus(http.directory).state,
                (state) => state === "applied",
              )
            }

            await Effect.runPromise(llm.text("replacement answer"))
            const nextID = MessageID.ascending()
            const next = await accepted(
              http,
              a.id,
              await http.post(`/session/${a.id}/prompt_async`, {
                messageID: nextID,
                model,
                parts: [{ type: "text", text: `replacement ${nextID}` }],
              }),
              nextID,
            )
            await settled(http, a.id, next.id)
            expect(epoch(a.id)).toBe(beforeA + 2)
            expect(epoch(b.id)).toBe(beforeB + 1)
          } finally {
            first.release()
            second.release()
            childA.release()
            childB.release()
            await http.post(`/session/${a.id}/abort`)
            await otherHttp.post(`/session/${b.id}/abort`)
            await Instance.disposeAll()
          }
        }),
      30_000,
    )
  }

  test(
    "each idle abort increments the persisted epoch exactly once without affecting another session",
    () =>
      fixture(async (http) => {
        const session = await http.session()
        const other = await http.session()
        const before = epoch(session.id)
        const otherEpoch = epoch(other.id)
        for (const increment of [1, 2]) {
          const response = await http.post(`/session/${session.id}/abort`)
          expect(response.status).toBe(200)
          const body = (await response.json()) as { epoch: number }
          expect(body.epoch).toBe(before + increment)
          expect(epoch(session.id)).toBe(body.epoch)
          expect(epoch(other.id)).toBe(otherEpoch)
        }
      }),
    30_000,
  )

  test(
    "disconnecting an admitted /message stream does not cancel model work or advance epoch",
    () =>
      fixture(async (http, llm) => {
        const session = await http.session()
        const controller = new AbortController()
        const first = await controlled(http, llm, session.id, controller.signal)
        try {
          expect(first.response.status).toBe(200)
          const before = epoch(session.id)
          controller.abort()
          await first.response.body?.cancel()
          first.release()
          await settled(http, session.id, first.receiptId)
          expect(epoch(session.id)).toBe(before)
          const messages = await http.messages(session.id)
          expect(messages.filter((message) => message.info.id === first.messageID)).toHaveLength(1)
          expect(
            messages
              .flatMap((message) => message.parts)
              .some((part) => part.type === "text" && part.text === "controlled first answer"),
          ).toBe(true)
        } finally {
          first.release()
        }
      }),
    30_000,
  )
})
