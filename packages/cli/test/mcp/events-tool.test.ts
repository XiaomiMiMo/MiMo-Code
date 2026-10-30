import { describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import { fileURLToPath } from "node:url"
import { McpEventsTool } from "../../src/tool/mcp-events"
import { Config } from "../../src/config"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { Bus } from "../../src/bus"
import { SessionID, MessageID } from "../../src/session/schema"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"

const it = testEffect(Layer.mergeAll(Config.defaultLayer, Agent.defaultLayer, Truncate.defaultLayer, Bus.layer, CrossSpawnSpawner.defaultLayer))
const fixture = fileURLToPath(new URL("./fixtures/events-stdio-server.mjs", import.meta.url))
const config = { mcp: { fixture: { type: "local" as const, command: [process.execPath, fixture, "silent"] } } }

describe("MCP event subscription tool", () => {
  it.live("requires a session-bound approval and allows revocation", provideTmpdirInstance(() => Effect.gen(function* () {
    const tool = yield* (yield* McpEventsTool).init()
    const asked: string[] = []
    const ctx = {
      sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"), agent: "build",
      abort: new AbortController().signal, messages: [], metadata: () => Effect.void,
      ask: (request: { permission: string; patterns: readonly string[] }) => Effect.sync(() => { asked.push(`${request.permission}:${request.patterns[0]}`) }),
    }
    const args = { server: "fixture", event: "mail.created", arguments: { tag: "authorization" } }
    const result = yield* tool.execute({ operation: "subscribe", ...args }, ctx)
    expect(result.output).toContain("Subscription active")
    expect(asked).toEqual(["mcp_events:fixture:mail.created:ses_test"])
    const stopped = yield* tool.execute({ operation: "unsubscribe", ...args }, ctx)
    expect(stopped.output).toContain("stopped")
  }), { git: true, config }), 15_000)

  it.live("rejects a refused grant before starting a server", provideTmpdirInstance(() => Effect.gen(function* () {
    const tool = yield* (yield* McpEventsTool).init()
    const ctx = {
      sessionID: SessionID.make("ses_test"), messageID: MessageID.make("msg_test"), agent: "build",
      abort: new AbortController().signal, messages: [], metadata: () => Effect.void,
      ask: () => Effect.die(new Error("rejected")),
    }
    const result = yield* tool.execute({ operation: "subscribe", server: "fixture", event: "mail.created" }, ctx).pipe(Effect.exit)
    expect(result._tag).toBe("Failure")
  }), { git: true, config }), 15_000)
})
