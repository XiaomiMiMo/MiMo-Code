import { expect, test } from "bun:test"
import { Effect } from "effect"
import { Session } from "../../src/session"
import { MessageID } from "../../src/session/schema"
import { Flag } from "../../src/flag/flag"
import * as ToolRegistry from "../../src/tool/registry"
import * as Tool from "../../src/tool/tool"
import { Instance } from "../../src/project/instance"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

test("session set-title preserves ownership and gates other operations", async () => {
  await using tmp = await tmpdir({ git: true })
  await Instance.provide({ directory: tmp.path, fn: () => AppRuntime.runPromise(Effect.gen(function* () {
    const sessions = yield* Session.Service
    const registry = yield* ToolRegistry.Service
    expect(yield* registry.ids()).toContain("session")
    expect(yield* registry.ids()).not.toContain("set_thread_title")
    const session = yield* sessions.create()
    const registered = (yield* registry.all()).filter(tool => tool.id === "session")
    expect(registered).toHaveLength(1)
    const tool = registered[0]!
    expect(tool.parameters.safeParse({ operation: { action: "create", task: "Not a title operation" } }).success).toBe(Flag.MIMOCODE_EXPERIMENTAL_ORCHESTRATOR)
    expect(tool.parameters.safeParse({ operation: { action: "setTitle", title: "Wrong action" } }).success).toBe(false)
    const ctx: Tool.Context = { sessionID: session.id, messageID: MessageID.ascending(), agent: "build", actorID: "main", abort: new AbortController().signal, messages: [], metadata: () => Effect.void, ask: () => Effect.void }
    expect((yield* tool.execute({ operation: { action: "set-title", title: "Attachment semantics" } }, ctx)).metadata.changed).toBe(true)
    expect((yield* sessions.get(session.id)).titleSource).toBe("generated")
    expect((yield* tool.execute({ operation: { action: "set-title", title: "New substantive task" } }, ctx)).metadata.changed).toBe(true)
    yield* sessions.setTitle({ sessionID: session.id, title: "Human title", expectedRevision: 0 })
    expect((yield* tool.execute({ operation: { action: "set-title", title: "Must not overwrite" } }, ctx)).metadata.changed).toBe(false)
    expect((yield* sessions.get(session.id)).title).toBe("Human title")
    const child = yield* sessions.fork({ sessionID: session.id })
    expect((yield* tool.execute({ operation: { action: "set-title", title: "Child" } }, { ...ctx, sessionID: child.id })).metadata.changed).toBe(false)
    expect((yield* tool.execute({ operation: { action: "set-title", title: "Actor" } }, { ...ctx, actorID: "worker" })).metadata.changed).toBe(false)
  })) })
})
