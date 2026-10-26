import { expect, spyOn } from "bun:test"
import type { SQLQueryBindings } from "bun:sqlite"
import { Cause, Effect, Exit, Layer } from "effect"
import { AppLayer } from "../../src/effect/app-runtime"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { MessageTable, PartTable } from "../../src/session/session.sql"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Database, NotFoundError, eq, sql } from "../../src/storage"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

const it = testEffect(AppLayer.pipe(Layer.provideMerge(CrossSpawnSpawner.defaultLayer)))

function insertMessage<T extends MessageV2.Info>(info: T, storedTime = info.time.created): T {
  const { id, sessionID, agentID = "main", ...data } = info
  Database.use((db) =>
    db
      .insert(MessageTable)
      .values({
        id,
        session_id: sessionID,
        agent_id: agentID,
        time_created: storedTime,
        time_updated: storedTime,
        data,
      })
      .run(),
  )
  return info
}

function user(sessionID: SessionID, overrides: Partial<Omit<MessageV2.User, "sessionID" | "role">> = {}) {
  return insertMessage({
    id: MessageID.ascending(),
    sessionID,
    role: "user" as const,
    agentID: "main",
    agent: "build",
    time: { created: 1 },
    model: { providerID: ProviderID.make("test"), modelID: ModelID.make("model") },
    ...overrides,
  })
}

function assistant(
  sessionID: SessionID,
  parentID: MessageID,
  overrides: Partial<Omit<MessageV2.Assistant, "sessionID" | "parentID" | "role">> = {},
) {
  return insertMessage({
    id: MessageID.ascending(),
    sessionID,
    parentID,
    role: "assistant" as const,
    agentID: "main",
    agent: "build",
    mode: "primary",
    modelID: ModelID.make("model"),
    providerID: ProviderID.make("test"),
    time: { created: 2, completed: 2 },
    path: { cwd: "/tmp/example", root: "/tmp/example" },
    cost: 0,
    finish: "tool-calls",
    tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    ...overrides,
  })
}

function part(input: MessageV2.Part) {
  const { id, sessionID, messageID, ...data } = input
  Database.use((db) =>
    db
      .insert(PartTable)
      .values({
        id,
        session_id: sessionID,
        message_id: messageID,
        time_created: 1,
        time_updated: 1,
        data,
      })
      .run(),
  )
}

function traceReads(marker: string) {
  // Observe real driver results as well as JSON decoding: a raw SQL projection can bypass a column mapper.
  const client = Database.Client().$client
  const prepare = client.prepare.bind(client)
  const restore: (() => void)[] = []
  const seen = new WeakSet<object>()
  const observation = { payloads: 0, messageHydrations: 0, partHydrations: 0 }
  const inspect = (value: unknown): void => {
    if (typeof value === "string") {
      if (value.includes(marker)) observation.payloads++
      return
    }
    if (Array.isArray(value)) {
      for (const item of value) inspect(item)
      return
    }
    if (value && typeof value === "object") for (const item of Object.values(value)) inspect(item)
  }
  const trace = spyOn(client, "prepare").mockImplementation(
    <Result, Params extends SQLQueryBindings | SQLQueryBindings[]>(query: string, params?: Params) => {
      const statement = prepare<Result, Params>(query, params)
      if (seen.has(statement)) return statement
      seen.add(statement)
      const values = statement.values.bind(statement)
      const all = statement.all.bind(statement)
      const get = statement.get.bind(statement)
      const captureValues = spyOn(statement, "values").mockImplementation((...bindings) => {
        const result = values(...bindings)
        inspect(result)
        return result
      })
      const captureAll = spyOn(statement, "all").mockImplementation((...bindings) => {
        const result = all(...bindings)
        inspect(result)
        return result
      })
      const captureGet = spyOn(statement, "get").mockImplementation((...bindings) => {
        const result = get(...bindings)
        inspect(result)
        return result
      })
      restore.push(() => {
        captureValues.mockRestore()
        captureAll.mockRestore()
        captureGet.mockRestore()
      })
      return statement
    },
  )
  const messageMap = MessageTable.data.mapFromDriverValue.bind(MessageTable.data)
  const partMap = PartTable.data.mapFromDriverValue.bind(PartTable.data)
  const messageMapper = spyOn(MessageTable.data, "mapFromDriverValue").mockImplementation((value) => {
    observation.messageHydrations++
    return messageMap(value)
  })
  const partMapper = spyOn(PartTable.data, "mapFromDriverValue").mockImplementation((value) => {
    observation.partHydrations++
    return partMap(value)
  })
  return {
    observation,
    restore() {
      trace.mockRestore()
      for (const stop of restore) stop()
      messageMapper.mockRestore()
      partMapper.mockRestore()
    },
  }
}

it.live(
  "recovery does not hydrate historical or tail attachment payloads",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "large recovery history" })
          const marker = "YXR0YWNobWVudF9wYXlsb2Fk"
          const payload = marker.repeat(Math.ceil((2 * 1024 * 1024) / marker.length))
          let parentID: MessageID | undefined
          for (let turn = 0; turn < 100; turn++) {
            const parent = user(session.id, {
              time: { created: turn * 2 },
              ...(turn === 0
                ? {
                    summary: {
                      title: "historical",
                      body: "retained",
                      diffs: [{ file: "example.txt", patch: payload, additions: 1, deletions: 0 }],
                    },
                  }
                : {}),
            })
            parentID = parent.id
            if (turn < 2)
              part({
                id: PartID.ascending(),
                sessionID: session.id,
                messageID: parent.id,
                type: "file",
                mime: "image/png",
                filename: "example.png",
                url: `data:image/png;base64,${payload}`,
              })
            const answer = assistant(session.id, parent.id, {
              time: { created: turn * 2 + 1, completed: turn * 2 + 1 },
              finish: "stop",
            })
            part({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: answer.id,
              type: "text",
              text: "finished answer",
            })
          }
          if (!parentID) throw new Error("Synthetic history has no parent")
          const tail = assistant(session.id, parentID, {
            time: { created: 201, completed: 201 },
            structured: { retained: payload },
          })
          part({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: tail.id,
            type: "tool",
            tool: "example",
            callID: "call_example",
            state: {
              status: "completed",
              input: { retained: payload },
              output: payload,
              title: "example",
              metadata: { retained: payload },
              time: { start: 200, end: 201 },
              attachments: [
                {
                  id: PartID.ascending(),
                  sessionID: session.id,
                  messageID: tail.id,
                  type: "file",
                  mime: "image/png",
                  url: `data:image/png;base64,${payload}`,
                },
              ],
            },
          })
          const trace = traceReads(marker)
          yield* Effect.addFinalizer(() => Effect.sync(() => trace.restore()))
          expect(yield* prompt.recovery({ sessionID: session.id })).toEqual([
            { kind: "assistant", assistantMessageID: tail.id, parentMessageID: parentID, created: 201 },
          ])
          expect(trace.observation).toEqual({ payloads: 0, messageHydrations: 0, partHydrations: 0 })
        }),
      { git: true },
    ),
  60_000,
)

it.live(
  "a stop with useful tool content reads no tool inputs, outputs, metadata, or attachments",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const session = yield* sessions.create({ title: "tool content projection" })
          const parent = user(session.id)
          const tail = assistant(session.id, parent.id, { finish: "stop" })
          const marker = "YXR0YWNobWVudF9wYXlsb2Fk"
          const payload = marker.repeat(64 * 1024)
          part({
            id: PartID.ascending(),
            sessionID: session.id,
            messageID: tail.id,
            type: "tool",
            tool: "example",
            callID: "call_example",
            metadata: { retained: payload },
            state: {
              status: "completed",
              input: { retained: payload },
              output: payload,
              title: "example",
              metadata: { retained: payload },
              time: { start: 1, end: 2 },
              attachments: [
                {
                  id: PartID.ascending(),
                  sessionID: session.id,
                  messageID: tail.id,
                  type: "file",
                  mime: "image/png",
                  url: `data:image/png;base64,${payload}`,
                },
              ],
            },
          })
          const trace = traceReads(marker)
          yield* Effect.addFinalizer(() => Effect.sync(() => trace.restore()))
          expect(yield* prompt.recovery({ sessionID: session.id })).toEqual([])
          expect(trace.observation).toEqual({ payloads: 0, messageHydrations: 0, partHydrations: 0 })
        }),
      { git: true },
    ),
  30_000,
)

it.live("recovery preserves the default, explicit actor, and all-agent slices", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "recovery slices" })
        const mainParent = user(session.id)
        const mainTail = assistant(session.id, mainParent.id)
        const actorParent = user(session.id, { agentID: "actor_example", time: { created: 3 } })
        const actorTail = assistant(session.id, actorParent.id, { agentID: "actor_example", time: { created: 4 } })
        const main = [
          { kind: "assistant" as const, assistantMessageID: mainTail.id, parentMessageID: mainParent.id, created: 2 },
        ]
        const actor = [
          { kind: "assistant" as const, assistantMessageID: actorTail.id, parentMessageID: actorParent.id, created: 4 },
        ]
        expect(yield* prompt.recovery({ sessionID: session.id })).toEqual(main)
        expect(yield* prompt.recovery({ sessionID: session.id, agentID: "main" })).toEqual(main)
        expect(yield* prompt.recovery({ sessionID: session.id, agentID: "actor_example" })).toEqual(actor)
        expect(yield* prompt.recovery({ sessionID: session.id, agentID: "*" })).toEqual(actor)
        expect(yield* prompt.recovery({ sessionID: session.id, agentID: "actor_missing" })).toEqual([])
      }),
    { git: true },
  ),
)

it.live("an assistant requires a user parent in the same selected session and agent slice", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        for (const scope of ["missing", "other-session", "other-agent", "assistant"] as const) {
          const session = yield* sessions.create({ title: `parent ${scope}` })
          let parentID = MessageID.ascending()
          if (scope === "other-session") {
            const other = yield* sessions.create({ title: "other parent session" })
            parentID = user(other.id).id
          }
          if (scope === "other-agent") parentID = user(session.id, { agentID: "actor_example" }).id
          if (scope === "assistant") {
            const parent = user(session.id, { time: { created: 0 } })
            parentID = assistant(session.id, parent.id, { time: { created: 1 } }).id
          }
          const tail = assistant(session.id, parentID)
          expect(yield* prompt.recovery({ sessionID: session.id }), scope).toEqual([])
          if (scope === "other-agent") {
            expect(yield* prompt.recovery({ sessionID: session.id, agentID: "*" })).toEqual([
              { kind: "assistant", assistantMessageID: tail.id, parentMessageID: parentID, created: 2 },
            ])
          }
        }
      }),
    { git: true },
  ),
)

it.live("recovery orders by stored time and id while reporting the JSON creation time", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const tied = yield* sessions.create({ title: "timestamp tie" })
        const parent = user(tied.id, { time: { created: 0 } })
        const older = assistant(tied.id, parent.id, {
          id: MessageID.make("msg_recovery_tied_a"),
          time: { created: 900 },
        })
        const newer = user(tied.id, {
          id: MessageID.make("msg_recovery_tied_z"),
          time: { created: 5 },
        })
        Database.use((db) =>
          db.update(MessageTable).set({ time_created: 10 }).where(eq(MessageTable.id, older.id)).run(),
        )
        Database.use((db) =>
          db.update(MessageTable).set({ time_created: 10 }).where(eq(MessageTable.id, newer.id)).run(),
        )
        expect(yield* prompt.recovery({ sessionID: tied.id })).toEqual([
          { kind: "parent-user", userMessageID: newer.id, created: 5 },
        ])

        const ordered = yield* sessions.create({ title: "stored time order" })
        const first = user(ordered.id, { time: { created: 0 } })
        const last = assistant(ordered.id, first.id, { time: { created: 1 } })
        const misleading = user(ordered.id, { time: { created: 1000 } })
        Database.use((db) =>
          db.update(MessageTable).set({ time_created: 10 }).where(eq(MessageTable.id, last.id)).run(),
        )
        Database.use((db) =>
          db.update(MessageTable).set({ time_created: 9 }).where(eq(MessageTable.id, misleading.id)).run(),
        )
        expect(yield* prompt.recovery({ sessionID: ordered.id })).toEqual([
          { kind: "assistant", assistantMessageID: last.id, parentMessageID: first.id, created: 1 },
        ])
      }),
    { git: true },
  ),
)

it.live("recovery skips more than one page of checkpoint users without reviving older assistants", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        for (const trailing of ["user", "assistant"] as const) {
          const session = yield* sessions.create({ title: `checkpoint tail after ${trailing}` })
          const parent = user(session.id, { time: { created: 0 } })
          if (trailing === "assistant") assistant(session.id, parent.id, { time: { created: 1 } })
          for (let index = 0; index < 61; index++) {
            const checkpoint = user(session.id, { time: { created: index + 2 } })
            part({
              id: PartID.ascending(),
              sessionID: session.id,
              messageID: checkpoint.id,
              type: "checkpoint",
              checkpointDir: "/tmp/example/checkpoint",
              checkpointNumber: index,
              coveredUpTo: parent.id,
            })
          }
          expect(yield* prompt.recovery({ sessionID: session.id }), trailing).toEqual(
            trailing === "user" ? [{ kind: "parent-user", userMessageID: parent.id, created: 0 }] : [],
          )
        }
      }),
    { git: true },
  ),
)

it.live("compaction users remain recovery targets and existing empty sessions remain empty", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const prompt = yield* SessionPrompt.Service
        const session = yield* sessions.create({ title: "compaction user" })
        const parent = user(session.id)
        assistant(session.id, parent.id)
        const compaction = user(session.id, { time: { created: 3 } })
        part({
          id: PartID.ascending(),
          sessionID: session.id,
          messageID: compaction.id,
          type: "compaction",
          auto: true,
        })
        expect(yield* prompt.recovery({ sessionID: session.id })).toEqual([
          { kind: "parent-user", userMessageID: compaction.id, created: 3 },
        ])
        const empty = yield* sessions.create({ title: "empty recovery" })
        expect(yield* prompt.recovery({ sessionID: empty.id })).toEqual([])
        const missing = yield* Effect.exit(prompt.recovery({ sessionID: SessionID.make("ses_missing_recovery_tail") }))
        expect(Exit.isFailure(missing)).toBe(true)
        if (Exit.isFailure(missing)) expect(Cause.squash(missing.cause)).toBeInstanceOf(NotFoundError)
      }),
    { git: true },
  ),
)

type Content =
  | { type: "text"; text: string; synthetic?: boolean; ignored?: boolean }
  | { type: "reasoning"; text: string }
  | { type: "tool" | "file" }

type PredicateCase = {
  name: string
  recover: boolean
  finish?: string
  completed?: number
  summary?: boolean
  structured?: unknown
  error?: boolean
  content?: Content[]
}

it.live("recovery facts normalize absent and null flags without losing field presence", () =>
  provideTmpdirInstance(
    () =>
      Effect.gen(function* () {
        const sessions = yield* Session.Service
        const session = yield* sessions.create({ title: "recovery flag projection" })
        const parent = user(session.id)
        const tail = assistant(session.id, parent.id, { finish: "stop", time: { created: 2 } })
        const textID = PartID.ascending()
        part({ id: textID, sessionID: session.id, messageID: tail.id, type: "text", text: " \n" })
        const expected = {
          role: "assistant",
          id: tail.id,
          parentID: parent.id,
          created: 2,
          finish: "stop",
          completed: false,
          error: false,
          summary: false,
          structured: false,
          parentExists: true,
          parts: [{ type: "text", text: " \n", synthetic: false, ignored: false }],
        } satisfies MessageV2.RecoveryTail
        expect(MessageV2.readRecoveryTail({ sessionID: session.id })).toEqual(expected)

        Database.use((db) => {
          db.update(MessageTable)
            .set({ data: sql`json_set(${MessageTable.data}, '$.error', null, '$.summary', null)` })
            .where(eq(MessageTable.id, tail.id))
            .run()
          db.update(PartTable)
            .set({ data: sql`json_set(${PartTable.data}, '$.synthetic', null, '$.ignored', null)` })
            .where(eq(PartTable.id, textID))
            .run()
        })
        expect(MessageV2.readRecoveryTail({ sessionID: session.id })).toEqual(expected)

        Database.use((db) =>
          db
            .update(MessageTable)
            .set({ data: sql`json_set(${MessageTable.data}, '$.structured', null, '$.time.completed', null)` })
            .where(eq(MessageTable.id, tail.id))
            .run(),
        )
        expect(MessageV2.readRecoveryTail({ sessionID: session.id })).toEqual({
          ...expected,
          completed: true,
          structured: true,
          parts: [],
        })
      }),
    { git: true },
  ),
)

it.live(
  "recovery preserves field presence, finish flags, and JavaScript whitespace semantics",
  () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const sessions = yield* Session.Service
          const prompt = yield* SessionPrompt.Service
          const whitespace =
            " \t\n\v\f\r\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff"
          const cases: PredicateCase[] = [
            { name: "empty stop", finish: "stop", recover: true },
            { name: "completed empty stop", finish: "stop", completed: 0, recover: true },
            { name: "ordinary stop", finish: "stop", recover: false, content: [{ type: "text", text: "answer" }] },
            {
              name: "completed ordinary stop",
              finish: "stop",
              completed: 0,
              recover: false,
              content: [{ type: "text", text: "answer" }],
            },
            {
              name: "Unicode whitespace",
              finish: "stop",
              recover: true,
              content: [{ type: "text", text: whitespace }],
            },
            {
              name: "synthetic text",
              finish: "stop",
              recover: true,
              content: [{ type: "text", text: "reminder", synthetic: true }],
            },
            {
              name: "ignored text",
              finish: "stop",
              recover: true,
              content: [{ type: "text", text: "ignored", ignored: true }],
            },
            {
              name: "reasoning whitespace",
              finish: "stop",
              recover: true,
              content: [{ type: "reasoning", text: whitespace }],
            },
            {
              name: "reasoning answer",
              finish: "stop",
              recover: false,
              content: [{ type: "reasoning", text: "answer" }],
            },
            { name: "tool content", finish: "stop", recover: false, content: [{ type: "tool" }] },
            { name: "file only", finish: "stop", recover: true, content: [{ type: "file" }] },
            { name: "true summary", finish: "stop", summary: true, recover: false },
            { name: "false summary", finish: "stop", summary: false, recover: true },
            {
              name: "errored stop",
              finish: "stop",
              completed: 0,
              error: true,
              recover: true,
              content: [{ type: "text", text: "partial answer" }],
            },
            { name: "completed other", finish: "other", completed: 0, recover: false },
            { name: "incomplete other", finish: "other", recover: true },
            { name: "completed tool calls", finish: "tool-calls", completed: 0, recover: true },
            { name: "completed length", finish: "length", completed: 0, recover: true },
            { name: "missing finish", completed: 0, recover: true },
            ...[null, false, 0, "", {}, []].map(
              (structured): PredicateCase => ({
                name: `structured ${JSON.stringify(structured)}`,
                finish: "stop",
                structured,
                recover: false,
              }),
            ),
            ...["\u0085", "\u180e", "\u200b", "\0", `${whitespace}例${whitespace}`].map(
              (text): PredicateCase => ({
                name: `non-whitespace ${JSON.stringify(text)}`,
                finish: "stop",
                recover: false,
                content: [{ type: "text", text }],
              }),
            ),
          ]
          for (const entry of cases) {
            const session = yield* sessions.create({ title: entry.name })
            const parent = user(session.id)
            const tail = assistant(session.id, parent.id, {
              finish: entry.finish,
              time: { created: 2, ...(entry.completed == null ? {} : { completed: entry.completed }) },
              ...(Object.hasOwn(entry, "structured") ? { structured: entry.structured } : {}),
              ...(entry.summary == null ? {} : { summary: entry.summary }),
              ...(entry.error
                ? { error: { name: "APIError", data: { message: "test error", isRetryable: true } } }
                : {}),
            })
            for (const content of entry.content ?? []) {
              const base = { id: PartID.ascending(), sessionID: session.id, messageID: tail.id }
              if (content.type === "text") part({ ...base, ...content })
              if (content.type === "reasoning") part({ ...base, ...content, time: { start: 1, end: 2 } })
              if (content.type === "tool")
                part({
                  ...base,
                  type: "tool",
                  tool: "example",
                  callID: "call_example",
                  state: { status: "pending", input: {}, raw: "" },
                })
              if (content.type === "file")
                part({ ...base, type: "file", mime: "image/png", url: "data:image/png;base64,AAAA" })
            }
            expect(yield* prompt.recovery({ sessionID: session.id }), entry.name).toEqual(
              entry.recover
                ? [{ kind: "assistant", assistantMessageID: tail.id, parentMessageID: parent.id, created: 2 }]
                : [],
            )
          }

          const legacy = yield* sessions.create({ title: "present null completion" })
          const parent = user(legacy.id)
          const tail = assistant(legacy.id, parent.id, { finish: "other", time: { created: 2 } })
          Database.use((db) =>
            db
              .update(MessageTable)
              .set({
                data: sql`json_set(${MessageTable.data}, '$.time.completed', null)`,
              })
              .where(eq(MessageTable.id, tail.id))
              .run(),
          )
          expect(MessageV2.readRecoveryTail({ sessionID: legacy.id })).toMatchObject({
            role: "assistant",
            completed: true,
          })
          expect(yield* prompt.recovery({ sessionID: legacy.id })).toEqual([])
        }),
      { git: true },
    ),
  30_000,
)
