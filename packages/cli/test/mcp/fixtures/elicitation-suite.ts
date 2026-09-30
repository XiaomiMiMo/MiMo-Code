import { expect } from "bun:test"
import { Effect, Layer } from "effect"
import { ManagedClient } from "../../../src/mcp/managed-client"
import { Server } from "@modelcontextprotocol/sdk/server/index.js"
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js"
import { ElicitResultSchema, CallToolRequestSchema } from "@modelcontextprotocol/sdk/types.js"
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
    const request = (properties = {}) =>
      server.request(
        {
          method: "elicitation/create",
          params: {
            message: "Allow recording?",
            _meta: { subtitle: "Clicks, text and windows; up to 30 minutes." },
            requestedSchema: { type: "object", properties },
          },
        },
        ElicitResultSchema,
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
for (const reason of ["tool ends", "task aborts", "overlap", "disconnect"]) {
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
        if (reason === "overlap") McpElicitation.beginCall(f.client, "ses_second")()
        if (reason === "disconnect") yield* Effect.promise(() => f.client.close())
        expect((yield* Effect.promise(() => result)).action).toBe("cancel")
        yield* Effect.sleep("10 millis")
        expect(yield* question.list()).toEqual([])
        finish()
      }),
    ),
  )
}
it.live("unsolicited requests and nonempty forms fail closed [TP-R25-01]", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      expect((yield* Effect.promise(() => f.request())).action).toBe("cancel")
      const finish = McpElicitation.beginCall(f.client, "ses_recording")
      const error = yield* Effect.promise(() =>
        f.request({ name: { type: "string" } }).then(
          () => "unexpected accept",
          (e) => e.message,
        ),
      )
      expect(error).toContain("Only empty confirmation forms")
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
        expect((yield* Effect.promise(() => f.request())).action).toBe("cancel")
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

it.live("overlap stays untrusted until both calls finish", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const f = yield* fixture()
      const first = McpElicitation.beginCall(f.client, "ses_first")
      const second = McpElicitation.beginCall(f.client, "ses_second")
      second()
      expect((yield* Effect.promise(() => f.request())).action).toBe("cancel")
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
