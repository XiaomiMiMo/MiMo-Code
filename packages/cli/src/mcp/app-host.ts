import { Cause, Effect, Exit } from "effect"
import z from "zod"
import { ContentBlockSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import * as Session from "@/session/session"
import { MessageID, SessionID } from "@/session/schema"
import { MessageV2 } from "@/session/message-v2"
import { Agent } from "@/agent/agent"
import { Permission } from "@/permission"
import { Plugin } from "@/plugin"
import { MCP } from "."
import { updateAppContext } from "./app-context"
import { appEventResult, mcpRequestTimeout } from "./apps"
import { appCallSnapshot, appCallStatus, appOutcome, readAppCall, settleAppCall, startAppCall } from "./app-calls"

export const AppRequest = z.object({
  sessionID: SessionID.zod,
  messageID: z.string(),
  callID: z.string(),
  action: z.enum(["prepare", "calls/status", "tools/list", "tools/call", "resources/read", "context"]),
  params: z.record(z.string(), z.unknown()).default({}),
})
const Fact = z.object({
  server: z.string(),
  tool: z.string(),
  resourceUri: z.string().startsWith("ui://"),
  sessionID: z.string(),
  messageID: z.string(),
  callID: z.string(),
})
const parse = <T>(fn: () => T) => Effect.try({ try: fn, catch: (error) => new Error(String(error)) })
const record = (value: unknown): Record<string, unknown> =>
  value && typeof value === "object" && !Array.isArray(value) ? (value as Record<string, unknown>) : {}

/** Only engine-owned tool metadata is considered, never arbitrary tool result contents. */
export function findAppFact(parts: unknown[], callID: string): z.infer<typeof Fact> | undefined {
  for (const raw of parts) {
    const part = record(raw)
    if (part.type !== "tool") continue
    const meta = record(record(part.state).metadata)
    const parsed = Fact.safeParse(meta.mcpApp)
    if (parsed.success && parsed.data.callID === callID) return parsed.data
    if (meta.exec_schema === 1 && Array.isArray(meta.sub_parts)) {
      const child = findAppFact(meta.sub_parts, callID)
      if (child) return child
    }
  }
}
export const handleAppRequest = Effect.fn("MCP.appRequest")(function* (
  input: z.infer<typeof AppRequest>,
  signal?: AbortSignal,
) {
  const sessions = yield* Session.Service
  const session = yield* sessions.get(input.sessionID)
  // Look up the one owning message by id: no full-session scan, and subagent slices resolve too.
  const message = yield* parse((): MessageV2.WithParts | undefined =>
    MessageV2.get({ sessionID: input.sessionID, messageID: MessageID.make(input.messageID) }),
  ).pipe(Effect.orElseSucceed(() => undefined))
  const fact = findAppFact(message?.parts ?? [], input.callID)
  if (!fact || fact.sessionID !== input.sessionID || fact.messageID !== input.messageID)
    return yield* Effect.fail(new Error("MCP App invocation not found"))
  const mcp = yield* MCP.Service
  if (!mcp.appTools || !mcp.callAppTool) return yield* Effect.fail(new Error("MCP Apps runtime unavailable"))
  if (input.action === "calls/status") {
    const ref = yield* parse(() => z.object({ server: z.string(), messageID: z.string(), callID: z.string(), callOrder: z.number() }).parse(input.params))
    return yield* appCallStatus(input.sessionID, ref)
  }
  if (input.action === "context") {
    const value = yield* parse(() =>
      z
        .object({
          content: z.array(ContentBlockSchema).optional(),
          structuredContent: z.record(z.string(), z.unknown()).optional(),
        })
        .parse(input.params),
    )
    yield* updateAppContext(input.sessionID, fact.server, value)
    return {}
  }
  if (input.action === "prepare") {
    // Snapshot in-flight calls before reading the slot: a call leaves the set only after its slot write.
    const { watermark, inflight } = appCallSnapshot(input.sessionID)
    const slot = yield* readAppCall(input.sessionID, fact.server)
    if (!slot) return yield* Effect.fail(new Error("MCP App state unavailable"))
    const resource = yield* mcp.readResource(fact.server, slot.resourceUri)
    if (!resource) return yield* Effect.fail(new Error("MCP resource unavailable"))
    return {
      // The restored pair is the slot's latest call; its identity stays the entry row.
      fact: { ...slot.call, resourceUri: slot.resourceUri, messageID: slot.anchor.messageID, callID: slot.anchor.callID },
      restoreOrder: slot.call.callOrder,
      timeoutMs: mcp.appTimeout ? yield* mcp.appTimeout(fact.server) : mcpRequestTimeout(),
      watermark,
      inflight,
      resource,
      owner:
        message?.info.role === "assistant"
          ? { model: `${message.info.providerID}/${message.info.modelID}`, agent: message.info.agent }
          : {},
    }
  }
  if (input.action === "resources/read") {
    const resource = yield* mcp.readResource(fact.server, yield* parse(() => z.string().parse(input.params.uri)))
    if (!resource) return yield* Effect.fail(new Error("MCP resource unavailable"))
    return resource
  }
  if (input.action === "tools/list") return { tools: yield* mcp.appTools(fact.server) }
  const params = yield* parse(() =>
    z.object({ name: z.string(), arguments: z.record(z.string(), z.unknown()).default({}) }).parse(input.params),
  )
  if (!(yield* mcp.appTools(fact.server)).some((tool) => tool.name === params.name))
    return yield* Effect.fail(new Error("MCP App tool unavailable"))
  const agents = yield* Agent.Service
  // Historical owner may since have been deleted or renamed; fall back like resumed sessions do.
  const agent = yield* Agent.resolveStoredAgent(
    agents,
    message?.info.role === "assistant" ? message.info.agent : yield* agents.defaultAgent(),
  )
  const name = `${fact.server}_${params.name}`.replace(/[^a-zA-Z0-9_-]/g, "_")
  const permission = yield* Permission.Service
  yield* permission.ask(
    {
      sessionID: input.sessionID,
      permission: name,
      patterns: ["*"],
      always: ["*"],
      metadata: {},
      ruleset: Agent.runtimePermission(agent, session.permission),
    },
    signal,
  )
  const plugin = yield* Plugin.Service
  const callID = `app-${crypto.randomUUID()}`
  const before: { args: Record<string, unknown>; cancel?: boolean; cancelReason?: string } = { args: params.arguments }
  yield* plugin.trigger("tool.execute.before", { tool: name, sessionID: input.sessionID, callID }, before)
  if (before.cancel) return yield* Effect.fail(new Error(before.cancelReason ?? "Tool cancelled"))
  const call = yield* startAppCall({
    server: fact.server,
    tool: params.name,
    sessionID: input.sessionID,
    messageID: input.messageID,
    callID,
    arguments: before.args,
    timeoutMs: mcp.appTimeout ? yield* mcp.appTimeout(fact.server) : mcpRequestTimeout(),
  })
  // Settle on the Server outcome itself, so after-hook failures cannot drop or duplicate it.
  const result = yield* mcp
    .callAppTool(fact.server, params.name, before.args, { sessionId: input.sessionID, turnId: callID }, signal)
    .pipe(
      Effect.onExit((exit) =>
        settleAppCall(
          call,
          Exit.isSuccess(exit)
            ? { result: appEventResult(exit.value as CallToolResult) }
            : appOutcome(Cause.squash(exit.cause), !!signal?.aborted || Cause.hasInterrupts(exit.cause)),
          "page",
        ),
      ),
    )
  yield* plugin.trigger("tool.execute.after", { tool: name, sessionID: input.sessionID, callID, args: before.args }, result)
  return result
})
