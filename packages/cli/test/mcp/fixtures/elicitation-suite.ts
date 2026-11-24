import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ManagedClient } from "../../../src/mcp/managed-client"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ElicitResultSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
import type { McpElicitationRecord } from "../../../src/mcp/tool-context"
import { Question } from "../../../src/question"
import { EffectBridge } from "../../../src/effect"
import { McpElicitation } from "../../../src/mcp/elicitation"
import { MCP } from "../../../src/mcp"
import { provideTmpdirInstance } from "../../fixture/fixture"
import { testEffect } from "../../lib/effect"

import * as CrossSpawnSpawner from "../../../src/effect/cross-spawn-spawner"
const it = testEffect(Layer.mergeAll(Question.defaultLayer, MCP.defaultLayer, CrossSpawnSpawner.defaultLayer))
function fixture() {
  return Effect.gen(function* () {
    const client = new ManagedClient({ name: "mimocode", version: "test" }, MCP.CLIENT_OPTIONS)
    const server = new Server({ name: "recorder", version: "test" }, { capabilities: { tools: {} } })
    const [a, b] = InMemoryTransport.createLinkedPair()
    McpElicitation.serve("recorder", client, yield* EffectBridge.make())
    yield* Effect.promise(async () => {
      await server.connect(b)
      await client.connect(a)
    })
    yield* Effect.addFinalizer(() =>
      Effect.promise(async () => {
        await client.close()
        await server.close()
      }),
    )
    const request = (
      properties: Record<string, unknown> = {},
      extra: { required?: string[]; meta?: Record<string, unknown>; signal?: AbortSignal } = {},
    ) =>
      server.request(
        {
          method: "elicitation/create",
          params: {
            message: "Allow recording?",
            _meta: { subtitle: "Clicks, text and windows; up to 30 minutes.", ...extra.meta },
            requestedSchema: { type: "object", properties, ...(extra.required ? { required: extra.required } : {}) },
          },
        },
        ElicitResultSchema,
        extra.signal ? { signal: extra.signal } : undefined,
      )
    return { client, server, request }
  })
}
function waitForQuestion() {
  return Effect.gen(function* () {
    const svc = yield* Question.Service
    for (let i = 0; i < 200; i++) {
      const pending = yield* svc.list()
      if (pending.length) return pending[0]
      yield* Effect.sleep("5 millis")
    }
    throw new Error("No confirmation was raised")
  })
}
for (const [label, action] of [
  ["Accept", "accept"],
  ["Decline", "decline"],
  ["Cancel", "cancel"],
  ["arbitrary", "cancel"],
] as const) {
  it.live(`MCP confirmation ${label} [TP-R24-01]`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const question = yield* Question.Service
        yield* question.setNeverAsk(true)
        const finish = McpElicitation.beginCall(f.client, "ses_recording")
        try {
          const result = f.request()
          const pending = yield* waitForQuestion()
          expect(String(pending.sessionID)).toBe("ses_recording")
          expect(pending.questions[0].question).toContain("up to 30 minutes")
          expect(pending.questions[0].custom).toBe(false)
          yield* question.reply({ requestID: pending.id, answers: [[label]] })
          expect((yield* Effect.promise(() => result)).action).toBe(action)
          expect(yield* question.list()).toEqual([])
        } finally {
          finish()
        }
      }),
    ),
  )
}
it.live("dismissal returns cancel [TP-R24-01]", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const finish = McpElicitation.beginCall(f.client, "ses_recording")
      const result = f.request()
      const pending = yield* waitForQuestion()
      yield* question.reject(pending.id)
      expect((yield* Effect.promise(() => result)).action).toBe("cancel")
      finish()
    }),
  ),
)
for (const reason of ["tool ends", "task aborts", "disconnect"]) {
  it.live(`cancellation: ${reason} [TP-R25-01]`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const question = yield* Question.Service
        const controller = new AbortController()
        const finish = McpElicitation.beginCall(f.client, "ses_first", controller.signal)
        const result = f.request().catch(() => ({ action: "cancel" }))
        yield* waitForQuestion()
        if (reason === "tool ends") finish()
        if (reason === "task aborts") controller.abort()
        if (reason === "disconnect") yield* Effect.promise(() => f.client.close())
        expect((yield* Effect.promise(() => result)).action).toBe("cancel")
        yield* Effect.sleep("10 millis")
        expect(yield* question.list()).toEqual([])
        finish()
      }),
    ),
  )
}
const rejection = (promise: Promise<unknown>) =>
  promise.then(
    () => "unexpected answer",
    (e: { code?: number; message: string }) => `${e.code} ${e.message}`,
  )

it.live("unassociated requests and unsupported forms are invalid params", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const unsolicited = yield* Effect.promise(() => rejection(f.request()))
      expect(unsolicited).toContain("-32602")
      expect(unsolicited).toContain("in-flight tool call")
      const finish = McpElicitation.beginCall(f.client, "ses_recording")
      // Passes the SDK's schema shape but requires a property that does not exist.
      const broken = yield* Effect.promise(() => rejection(f.request({}, { required: ["missing"] })))
      expect(broken).toContain("-32602")
      expect(broken).toContain("required names a property")
      const question = yield* Question.Service
      expect(yield* question.list()).toEqual([])
      finish()
    }),
  ),
)

// Real nested tools/call -> elicitation/create -> Question -> reply -> tool result.
for (const label of ["Accept", "Decline"]) {
  it.live(`nested recorder call ${label} [TP-R24-01]`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const f = yield* fixture()
        const question = yield* Question.Service
        let started = false
        f.server.setRequestHandler(CallToolRequestSchema, async () => {
          const approval = await f.request()
          started = approval.action === "accept"
          return { content: [{ type: "text", text: approval.action }] }
        })
        const tool = MCP.convertMcpTool(
          { name: "event_stream_start", inputSchema: { type: "object" } },
          f.client,
          5000,
          { sessionId: "ses_nested", turnId: "turn_1" },
        )
        const result = tool.execute!({}, { toolCallId: "call_1", messages: [] })
        const pending = yield* waitForQuestion()
        expect(String(pending.sessionID)).toBe("ses_nested")
        expect(started).toBe(false)
        yield* question.reply({ requestID: pending.id, answers: [[label]] })
        yield* Effect.promise(() => Promise.resolve(result))
        expect(started).toBe(label === "Accept")
        expect(yield* Effect.promise(() => rejection(f.request()))).toContain("-32602")
      }),
    ),
  )
}

it.live("production MCP service over stdio [TP-R24-01]", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const mcp = yield* MCP.Service
      const question = yield* Question.Service
      yield* mcp.add("recorder", {
        type: "local",
        command: [process.execPath, `${import.meta.dir}/elicitation-server.ts`],
      })
      const tools = yield* mcp.tools({ sessionId: "ses_stdio", turnId: "turn_stdio" })
      expect(tools.recorder_event_stream_start).toBeDefined()
      const result = tools.recorder_event_stream_start.execute!({}, { toolCallId: "call_stdio", messages: [] })
      const pending = yield* waitForQuestion()
      expect(String(pending.sessionID)).toBe("ses_stdio")
      yield* question.reply({ requestID: pending.id, answers: [["Accept"]] })
      expect(yield* Effect.promise(() => Promise.resolve(result))).toMatchObject({
        content: [{ type: "text", text: "accept" }],
      })
      yield* mcp.disconnect("recorder")
    }),
  ),
)

it.live("overlap stays ambiguous without a call identity until both calls finish", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = McpElicitation.beginCall(f.client, "ses_first")
      const second = McpElicitation.beginCall(f.client, "ses_second")
      second()
      expect(yield* Effect.promise(() => rejection(f.request()))).toContain("-32602")
      first()
      const finish = McpElicitation.beginCall(f.client, "ses_fresh")
      const result = f.request()
      const pending = yield* waitForQuestion()
      expect(String(pending.sessionID)).toBe("ses_fresh")
      const question = yield* Question.Service
      yield* question.reply({ requestID: pending.id, answers: [["Accept"]] })
      expect((yield* Effect.promise(() => result)).action).toBe("accept")
      finish()
    }),
  ),
)

it.live("already aborted calls cannot request confirmation", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const finish = McpElicitation.beginCall(f.client, "ses_aborted", AbortSignal.abort())
      expect((yield* Effect.promise(() => f.request())).action).toBe("cancel")
      const question = yield* Question.Service
      expect(yield* question.list()).toEqual([])
      finish()
    }),
  ),
)

const decision = {
  decision: {
    type: "string",
    title: "Allow",
    oneOf: [
      { const: "once", title: "Only this time" },
      { const: "session", title: "For this task" },
    ],
  },
}

function recorder() {
  const writes: McpElicitationRecord[] = []
  return { writes, record: async (item: McpElicitationRecord) => void writes.push(structuredClone(item)) }
}

it.live("form choices are answered, exposed on the question and recorded", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const log = recorder()
      const finish = McpElicitation.beginCall(f.client, "ses_form", undefined, {
        turnID: "turn_1",
        callID: "call_1",
        messageID: "msg_1",
        record: log.record,
      })
      const result = f.request(decision, { required: ["decision"], meta: { "example.com/target": { site: "a" } } })
      const pending = yield* waitForQuestion()
      expect(pending.questions[0].options.map((option) => option.label)).toEqual(["Only this time", "For this task", "Decline"])
      expect(pending.tool).toMatchObject({ messageID: "msg_1", callID: "call_1" })
      expect(pending.elicitation).toMatchObject({
        server: "recorder",
        mode: "form",
        message: "Allow recording?",
        requestedSchema: { type: "object", properties: decision, required: ["decision"] },
        meta: { "example.com/target": { site: "a" } },
      })
      yield* question.reply({ requestID: pending.id, answers: [["For this task"]], source: "user", reason: "asked" })
      expect(yield* Effect.promise(() => result)).toMatchObject({ action: "accept", content: { decision: "session" } })
      finish()
      expect(log.writes.length).toBeGreaterThanOrEqual(2)
      expect(log.writes[0]).toMatchObject({ server: "recorder", callID: "call_1", mode: "form", message: "Allow recording?" })
      expect(log.writes[0].action).toBeUndefined()
      const last = log.writes.at(-1)!
      expect(last).toMatchObject({ action: "accept", content: { decision: "session" }, source: "user", reason: "asked" })
      expect(last.id).toBe(log.writes[0].id)
      expect(last.requestID).toBe(pending.elicitation!.requestID)
      expect(last.time.completed).toBeGreaterThanOrEqual(last.time.created)
    }),
  ),
)

it.live("structured replies are validated against the schema", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const log = recorder()
      const finish = McpElicitation.beginCall(f.client, "ses_structured", undefined, { callID: "call_s", record: log.record })
      const accepted = f.request(decision, { required: ["decision"] })
      let pending = yield* waitForQuestion()
      yield* question.reply({
        requestID: pending.id,
        answers: [],
        source: "policy",
        elicitation: { action: "accept", content: { decision: "once" } },
      })
      expect(yield* Effect.promise(() => accepted)).toMatchObject({ action: "accept", content: { decision: "once" } })
      expect(log.writes.at(-1)).toMatchObject({ action: "accept", source: "policy" })

      const invalid = f.request(decision, { required: ["decision"] })
      pending = yield* waitForQuestion()
      yield* question.reply({ requestID: pending.id, answers: [], elicitation: { action: "accept", content: { decision: "always" } } })
      expect((yield* Effect.promise(() => invalid)).action).toBe("cancel")
      expect(log.writes.at(-1)).toMatchObject({ action: "cancel", error: '"decision" is not one of the allowed values' })

      const declined = f.request(decision, { required: ["decision"] })
      pending = yield* waitForQuestion()
      yield* question.reply({ requestID: pending.id, answers: [], elicitation: { action: "decline" } })
      expect((yield* Effect.promise(() => declined)).action).toBe("decline")
      finish()
    }),
  ),
)

it.live("an echoed call identity associates requests while calls overlap", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const first = McpElicitation.beginCall(f.client, "ses_a", undefined, { turnID: "turn_a", callID: "call_a" })
      const second = McpElicitation.beginCall(f.client, "ses_b", undefined, { turnID: "turn_b", callID: "call_b" })
      const lifecycle = (value: Record<string, string>) => ({ "com.xiaomi.mimo/turn-lifecycle": value })

      const byCall = f.request({}, { meta: lifecycle({ sessionId: "ses_b", turnId: "turn_b", callId: "call_b" }) })
      let pending = yield* waitForQuestion()
      expect(String(pending.sessionID)).toBe("ses_b")
      yield* question.reply({ requestID: pending.id, answers: [["Accept"]] })
      expect((yield* Effect.promise(() => byCall)).action).toBe("accept")

      const byTurn = f.request({}, { meta: lifecycle({ sessionId: "ses_a", turnId: "turn_a" }) })
      pending = yield* waitForQuestion()
      expect(String(pending.sessionID)).toBe("ses_a")
      yield* question.reply({ requestID: pending.id, answers: [["Decline"]] })
      expect((yield* Effect.promise(() => byTurn)).action).toBe("decline")

      const wrong = yield* Effect.promise(() => rejection(f.request({}, { meta: lifecycle({ sessionId: "ses_a", callId: "call_b" }) })))
      expect(wrong).toContain("-32602")
      first()
      second()
    }),
  ),
)

it.live("a call that begins later does not withdraw an associated request", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const finish = McpElicitation.beginCall(f.client, "ses_first")
      const result = f.request()
      const pending = yield* waitForQuestion()
      const later = McpElicitation.beginCall(f.client, "ses_second")
      later()
      yield* Effect.sleep("10 millis")
      expect((yield* question.list()).map((item) => item.id)).toEqual([pending.id])
      yield* question.reply({ requestID: pending.id, answers: [["Accept"]] })
      expect((yield* Effect.promise(() => result)).action).toBe("accept")
      finish()
    }),
  ),
)

it.live("server cancellation of request id 0 withdraws the question", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const question = yield* Question.Service
      const log = recorder()
      const finish = McpElicitation.beginCall(f.client, "ses_cancel", undefined, { callID: "call_c", record: log.record })
      const controller = new AbortController()
      // The fixture server has sent nothing yet, so this request carries id 0.
      const result = f.request({}, { signal: controller.signal }).catch(() => "aborted")
      const pending = yield* waitForQuestion()
      expect(pending.elicitation?.requestID).toBe(0)
      controller.abort()
      expect(yield* Effect.promise(() => result)).toBe("aborted")
      for (let i = 0; i < 100 && (yield* question.list()).length; i++) yield* Effect.sleep("5 millis")
      expect(yield* question.list()).toEqual([])
      for (let i = 0; i < 100 && !log.writes.at(-1)?.action; i++) yield* Effect.sleep("5 millis")
      expect(log.writes.at(-1)).toMatchObject({ action: "cancel", error: "cancelled" })
      finish()
    }),
  ),
)

it.live("tools/call carries the call identity for association", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      let meta: unknown
      f.server.setRequestHandler(CallToolRequestSchema, async (request) => {
        meta = request.params._meta
        return { content: [{ type: "text", text: "ok" }] }
      })
      ;(f.client as unknown as { getServerCapabilities(): unknown }).getServerCapabilities = () => ({
        tools: {},
        experimental: { [MCP.TURN_LIFECYCLE_CAPABILITY]: { version: MCP.TURN_LIFECYCLE_VERSION } },
      })
      const tool = MCP.convertMcpTool({ name: "probe", inputSchema: { type: "object" } }, f.client, 5000, {
        sessionId: "ses_meta",
        turnId: "turn_meta",
      })
      yield* Effect.promise(() => Promise.resolve(tool.execute!({}, { toolCallId: "call_meta", messages: [] })))
      expect(meta).toMatchObject({
        [MCP.TURN_LIFECYCLE_CAPABILITY]: { sessionId: "ses_meta", turnId: "turn_meta", callId: "call_meta" },
      })
    }),
  ),
)
