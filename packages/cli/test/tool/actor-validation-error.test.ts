import { expect } from "bun:test"
import { Cause, Effect, Exit, Layer } from "effect"
import z from "zod"
import { Agent } from "../../src/agent/agent"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { ActorWaiter } from "../../src/actor/waiter"
import { Config } from "../../src/config"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Provider } from "../../src/provider"
import { Session } from "../../src/session"
import { MessageID, type SessionID } from "../../src/session/schema"
import { MessageTable } from "../../src/session/session.sql"
import { Database, eq } from "../../src/storage"
import { TaskRegistry } from "../../src/task/registry"
import { Truncate } from "../../src/tool"
import { ActorTool } from "../../src/tool/actor"
import { RecoverableError } from "../../src/tool/recoverable"
import { validationErrorMessage, type Context as ToolContext } from "../../src/tool/tool"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(
  Layer.mergeAll(
    Agent.defaultLayer,
    Config.defaultLayer,
    Provider.defaultLayer,
    Session.defaultLayer,
    ActorRegistry.defaultLayer,
    ActorWaiter.defaultLayer,
    TaskRegistry.defaultLayer,
    Truncate.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
  ),
)

function rows(sessionID: SessionID) {
  return Database.use((db) => ({
    actors: db
      .select({ id: ActorRegistryTable.actor_id })
      .from(ActorRegistryTable)
      .where(eq(ActorRegistryTable.session_id, sessionID))
      .orderBy(ActorRegistryTable.actor_id)
      .all(),
    inbox: db
      .select({ id: InboxTable.id })
      .from(InboxTable)
      .where(eq(InboxTable.receiver_session_id, sessionID))
      .orderBy(InboxTable.id)
      .all(),
    messages: db
      .select({ id: MessageTable.id })
      .from(MessageTable)
      .where(eq(MessageTable.session_id, sessionID))
      .orderBy(MessageTable.id)
      .all(),
  }))
}

function context(sessionID: SessionID, observed: { asks: number; metadata: number }): ToolContext {
  return {
    sessionID,
    messageID: MessageID.ascending(),
    agent: "build",
    abort: new AbortController().signal,
    messages: [],
    ask: () =>
      Effect.sync(() => {
        observed.asks++
      }),
    metadata: () =>
      Effect.sync(() => {
        observed.metadata++
      }),
  }
}

const cases = [
  {
    action: "spawn",
    field: "subagent_type",
    input: {
      operation: { action: "spawn", description: "Inspect example", prompt: "Inspect the example" },
      subagent_type: "general",
    },
    correct: {
      operation: {
        action: "spawn",
        description: "Inspect example",
        prompt: "Inspect the example",
        subagent_type: "general",
      },
    },
    payload: "Inspect the example",
    hint: 'For actor spawn, move "subagent_type" from the top level to "operation.subagent_type".',
  },
  {
    action: "send",
    field: "to_actor_id",
    input: { operation: { action: "send", content: "Example progress" }, to_actor_id: "main" },
    correct: { operation: { action: "send", content: "Example progress", to_actor_id: "main" } },
    payload: "Example progress",
    hint: 'For actor send, move "to_actor_id" from the top level to "operation.to_actor_id".',
  },
]

for (const entry of cases) {
  it.live(`actor ${entry.action} explains a misplaced top-level ${entry.field} without executing`, () =>
    provideTmpdirInstance(() =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Actor validation" })
        const def = yield* (yield* ActorTool).init()
        const original = structuredClone(entry.input)
        expect(def.parameters.safeParse(entry.input).success).toBe(false)
        expect(def.parameters.safeParse(entry.correct).success).toBe(true)
        const before = yield* Effect.sync(() => rows(session.id))
        const observed = { asks: 0, metadata: 0 }

        const exit = yield* def
          .execute(
            // @ts-expect-error Exercise runtime validation with a missing nested field.
            entry.input,
            context(session.id, observed),
          )
          .pipe(Effect.exit)

        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) throw new Error("Invalid actor arguments executed")
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(RecoverableError)
        if (!(error instanceof RecoverableError)) throw new Error("Validation error was not recoverable")
        expect(error.recoverable).toBe(true)
        expect(error.cause).toBeInstanceOf(z.ZodError)
        if (!(error.cause instanceof z.ZodError)) throw new Error("Validation cause was not preserved")
        const originalMessage = validationErrorMessage("actor", error.cause)
        expect(error.message).toBe(`${originalMessage}\n\n${entry.hint}`)
        expect(originalMessage).toStartWith("Invalid arguments for the actor tool:")
        expect(originalMessage).toContain(`operation.${entry.field}`)
        expect(error.message).not.toContain(entry.payload)
        expect(entry.input).toEqual(original)
        expect(observed).toEqual({ asks: 0, metadata: 0 })
        expect(yield* Effect.sync(() => rows(session.id))).toEqual(before)
      }),
    ),
  )
}

it.live("actor validation keeps unrelated and ambiguous errors unchanged", () =>
  provideTmpdirInstance(() =>
    Effect.gen(function* () {
      const sessions = yield* Session.Service
      const session = yield* sessions.create({ title: "Unchanged actor validation" })
      const def = yield* (yield* ActorTool).init()
      const spawn = { action: "spawn", description: "Inspect example", prompt: "Inspect the example" }
      const send = { action: "send", content: "Example progress" }
      const inputs: { name: string; input: unknown }[] = [
        {
          name: "duplicate spawn field",
          input: { operation: { ...spawn, subagent_type: "general" }, subagent_type: "general" },
        },
        { name: "duplicate send field", input: { operation: { ...send, to_actor_id: "main" }, to_actor_id: "main" } },
        {
          name: "invalid nested enum",
          input: { operation: { ...spawn, subagent_type: "not-configured" }, subagent_type: "general" },
        },
        { name: "invalid nested type", input: { operation: { ...send, to_actor_id: 7 }, to_actor_id: "main" } },
        { name: "missing field only", input: { operation: spawn } },
        { name: "invalid root enum", input: { operation: spawn, subagent_type: "not-configured" } },
        { name: "invalid root type", input: { operation: spawn, subagent_type: 7 } },
        { name: "empty root receiver", input: { operation: send, to_actor_id: "" } },
        { name: "null root receiver", input: { operation: send, to_actor_id: null } },
        { name: "unrelated root field", input: { operation: { ...spawn, subagent_type: "general" }, unrelated: true } },
        { name: "run action", input: { operation: { ...spawn, action: "run" }, subagent_type: "general" } },
        {
          name: "status action",
          input: { operation: { action: "status", actor_id: "general-1" }, to_actor_id: "main" },
        },
        { name: "unknown action", input: { operation: { action: "unknown" }, subagent_type: "general" } },
        { name: "missing action", input: { operation: {}, subagent_type: "general" } },
        { name: "stringified operation", input: { operation: JSON.stringify(spawn), subagent_type: "general" } },
        { name: "missing operation", input: { ...spawn, subagent_type: "general" } },
        { name: "null input", input: null },
      ]
      const observed = { asks: 0, metadata: 0 }
      const before = yield* Effect.sync(() => rows(session.id))
      for (const entry of inputs) {
        const original = structuredClone(entry.input)
        expect(def.parameters.safeParse(entry.input).success, entry.name).toBe(false)
        const exit = yield* def
          // @ts-expect-error Exercise runtime validation with intentionally invalid arguments.
          .execute(entry.input, context(session.id, observed))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit), entry.name).toBe(true)
        if (!Exit.isFailure(exit)) throw new Error("Invalid actor arguments executed")
        const error = Cause.squash(exit.cause)
        expect(error, entry.name).toBeInstanceOf(RecoverableError)
        if (!(error instanceof RecoverableError)) throw new Error("Validation error was not recoverable")
        expect(error.cause, entry.name).toBeInstanceOf(z.ZodError)
        if (!(error.cause instanceof z.ZodError)) throw new Error("Validation cause was not preserved")
        expect(error.message, entry.name).toBe(validationErrorMessage("actor", error.cause))
        expect(error.message, entry.name).not.toContain(spawn.prompt)
        expect(error.message, entry.name).not.toContain(send.content)
        expect(entry.input, entry.name).toEqual(original)
      }
      expect(observed).toEqual({ asks: 0, metadata: 0 })
      expect(yield* Effect.sync(() => rows(session.id))).toEqual(before)
    }),
  ),
)

it.live("actor spawn placement advice follows the configured subagent enum", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "Configured actor validation" })
        const def = yield* (yield* ActorTool).init()
        const operation = { action: "spawn", description: "Inspect example", prompt: "Inspect the example" }
        const input = { operation, subagent_type: "example_agent" }
        const original = structuredClone(input)
        expect(def.parameters.safeParse(input).success).toBe(false)
        expect(def.parameters.safeParse({ operation: { ...operation, subagent_type: "example_agent" } }).success).toBe(
          true,
        )
        const observed = { asks: 0, metadata: 0 }
        const before = yield* Effect.sync(() => rows(session.id))
        const exit = yield* def
          // @ts-expect-error Exercise runtime validation with a missing nested subagent_type.
          .execute(input, context(session.id, observed))
          .pipe(Effect.exit)
        expect(Exit.isFailure(exit)).toBe(true)
        if (!Exit.isFailure(exit)) throw new Error("Invalid actor arguments executed")
        const error = Cause.squash(exit.cause)
        expect(error).toBeInstanceOf(RecoverableError)
        if (!(error instanceof RecoverableError)) throw new Error("Validation error was not recoverable")
        expect(error.cause).toBeInstanceOf(z.ZodError)
        if (!(error.cause instanceof z.ZodError)) throw new Error("Validation cause was not preserved")
        const originalMessage = validationErrorMessage("actor", error.cause)
        expect(originalMessage).toContain("example_agent")
        expect(error.message).toBe(`${originalMessage}\n\n${cases[0].hint}`)
        expect(error.message).not.toContain(operation.prompt)
        expect(input).toEqual(original)
        expect(observed).toEqual({ asks: 0, metadata: 0 })
        expect(yield* Effect.sync(() => rows(session.id))).toEqual(before)
      }),
    { config: { agent: { example_agent: { description: "Example agent", mode: "subagent" } } } },
  ),
)
