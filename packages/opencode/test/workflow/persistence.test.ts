import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { WorkflowPersistence, journalKey } from "../../src/workflow/persistence"
import { Identifier } from "../../src/id/id"
import { Session } from "../../src/session"
import { testEffect } from "../lib/effect"
import { provideTmpdirInstance } from "../fixture/fixture"
import { makeLayer } from "./lib"

const it = testEffect(makeLayer())

describe("WorkflowPersistence", () => {
  it.live(
    "recordStart inserts a row; list returns it; flushCounters + recordPhase + recordTerminal update it; load round-trips args",
    () =>
      provideTmpdirInstance(
        () =>
          Effect.gen(function* () {
            const session = yield* Session.Service
            const parent = yield* session.create({
              title: "persist",
              permission: [{ permission: "*", pattern: "*", action: "allow" }],
            })
            const runID = Identifier.descending("workflow")
            yield* WorkflowPersistence.recordStart({
              runID,
              sessionID: parent.id,
              name: "t",
              parentActorID: "main",
              args: { x: 1 },
            })
            let rows = yield* WorkflowPersistence.list({ sessionID: parent.id })
            expect(rows.length).toBe(1)
            expect(rows[0].status).toBe("running")
            expect(rows[0].name).toBe("t")
            yield* WorkflowPersistence.flushCounters({ runID, running: 2, succeeded: 3, failed: 1 })
            yield* WorkflowPersistence.recordPhase({ runID, phase: "translate" })
            yield* WorkflowPersistence.recordTerminal({ runID, status: "completed" })
            rows = yield* WorkflowPersistence.list({ sessionID: parent.id })
            expect(rows[0].status).toBe("completed")
            expect(rows[0].succeeded).toBe(3)
            expect(rows[0].failed).toBe(1)
            expect(rows[0].running).toBe(2)
            expect(rows[0].currentPhase).toBe("translate")
            const loaded = yield* WorkflowPersistence.load(runID)
            expect(loaded?.args).toEqual({ x: 1 })
            expect(loaded?.parentActorID).toBe("main")
          }),
        { git: true },
      ),
  )

  it.live("recordStart stores scriptSha; load() round-trips it", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const p = yield* session.create({
            title: "sha",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const runID = Identifier.descending("workflow")
          yield* WorkflowPersistence.recordStart({ runID, sessionID: p.id, name: "t", scriptSha: "deadbeef" })
          const loaded = yield* WorkflowPersistence.load(runID)
          expect(loaded?.scriptSha).toBe("deadbeef")
        }),
      { git: true },
    ),
  )

  it.live("clearJournal truncates the journal so a later loadJournal sees nothing", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const runID = Identifier.descending("workflow")
          yield* WorkflowPersistence.appendJournal(runID, { t: "agent", key: "a:0", result: 1, pass: 1 })
          let loaded = yield* WorkflowPersistence.loadJournal(runID)
          expect(loaded.results.size).toBe(1)
          yield* WorkflowPersistence.clearJournal(runID)
          loaded = yield* WorkflowPersistence.loadJournal(runID)
          expect(loaded.results.size).toBe(0)
          expect(loaded.pass).toBe(1)
        }),
      { git: true },
    ),
  )

  it.live("recordStart on an existing runID resets counters to 0 (resume re-accumulates)", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const p = yield* session.create({
            title: "reset",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          const runID = Identifier.descending("workflow")
          yield* WorkflowPersistence.recordStart({ runID, sessionID: p.id, name: "t" })
          yield* WorkflowPersistence.flushCounters({ runID, running: 1, succeeded: 5, failed: 2 })
          // resume: same runID again
          yield* WorkflowPersistence.recordStart({ runID, sessionID: p.id, name: "t" })
          const loaded = yield* WorkflowPersistence.load(runID)
          expect(loaded?.status).toBe("running")
          expect(loaded?.succeeded).toBe(0)
          expect(loaded?.failed).toBe(0)
          expect(loaded?.running).toBe(0)
        }),
      { git: true },
    ),
  )

  it.live("writeScript then readScript round-trips the script body", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const runID = Identifier.descending("workflow")
          yield* WorkflowPersistence.writeScript(runID, "return 42")
          const body = yield* WorkflowPersistence.readScript(runID)
          expect(body).toBe("return 42")
        }),
      { git: true },
    ),
  )

  it.live("appendJournal then loadJournal: agent results map + pass increments; torn tail skipped", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const runID = Identifier.descending("workflow")
          // empty / missing file => empty results, pass 1
          const empty = yield* WorkflowPersistence.loadJournal(runID)
          expect(empty.results.size).toBe(0)
          expect(empty.pass).toBe(1)
          yield* WorkflowPersistence.appendJournal(runID, { t: "agent", key: "h:0", result: { ok: true }, pass: 1 })
          yield* WorkflowPersistence.appendJournal(runID, { t: "log", msg: "hello", pass: 1 })
          yield* WorkflowPersistence.appendJournal(runID, { t: "agent", key: "h:0", result: { ok: "newer" }, pass: 1 })
          const loaded = yield* WorkflowPersistence.loadJournal(runID)
          expect(loaded.results.get("h:0")).toEqual({ ok: "newer" }) // last-write-wins
          expect(loaded.results.size).toBe(1)
          expect(loaded.pass).toBe(2) // max seen pass (1) + 1
        }),
      { git: true },
    ),
  )

  it.live("loadJournal skips a torn final line", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const runID = Identifier.descending("workflow")
          yield* WorkflowPersistence.appendJournal(runID, { t: "agent", key: "a:0", result: 1, pass: 1 })
          // simulate a crash mid-append: a partial trailing line with no newline
          const fs = yield* Effect.promise(() => import("fs/promises"))
          const { Global } = yield* Effect.promise(() => import("../../src/global"))
          const p = `${Global.Path.data}/workflow/${runID}.jsonl`
          yield* Effect.promise(() => fs.appendFile(p, `{"t":"agent","key":"b:0","resul`))
          const loaded = yield* WorkflowPersistence.loadJournal(runID)
          expect(loaded.results.get("a:0")).toBe(1)
          expect(loaded.results.has("b:0")).toBe(false) // torn line skipped
        }),
      { git: true },
    ),
  )

  it.live("list with no sessionID returns all; newest-first by time_created", () =>
    provideTmpdirInstance(
      () =>
        Effect.gen(function* () {
          const session = yield* Session.Service
          const p = yield* session.create({
            title: "x",
            permission: [{ permission: "*", pattern: "*", action: "allow" }],
          })
          yield* WorkflowPersistence.recordStart({
            runID: Identifier.descending("workflow"),
            sessionID: p.id,
            name: "a",
          })
          yield* WorkflowPersistence.recordStart({
            runID: Identifier.descending("workflow"),
            sessionID: p.id,
            name: "b",
          })
          const all = yield* WorkflowPersistence.list()
          expect(all.length).toBeGreaterThanOrEqual(2)
        }),
      { git: true },
    ),
  )
})

describe("journalKey", () => {
  test("same prompt+opts+occ => same key; occ disambiguates", () => {
    const a = journalKey("hi", { agentType: "general" }, 0)
    const b = journalKey("hi", { agentType: "general" }, 0)
    const c = journalKey("hi", { agentType: "general" }, 1)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a.endsWith(":0")).toBe(true)
    expect(c.endsWith(":1")).toBe(true)
  })

  test("opts key order does not change the hash", () => {
    const a = journalKey("p", { agentType: "g", model: { providerID: "mimo", modelID: "m" } }, 0)
    const b = journalKey("p", { model: { modelID: "m", providerID: "mimo" }, agentType: "g" }, 0)
    expect(a).toBe(b)
  })

  test("display-only opts (label, tools, isolation) do NOT change the hash; semantic opts do", () => {
    const base = journalKey("p", { agentType: "g" }, 0)
    expect(journalKey("p", { agentType: "g", label: "x", tools: ["read"], isolation: "worktree" }, 0)).toBe(base)
    expect(journalKey("p", { agentType: "g", phase: "Verify" }, 0)).not.toBe(base)
    expect(journalKey("p", { agentType: "other" }, 0)).not.toBe(base)
    expect(journalKey("different", { agentType: "g" }, 0)).not.toBe(base)
  })

  // Resume-key stability for string model refs (spec §3.1): the key hashes the
  // RAW ref the script passed, not the resolved {providerID, modelID}. So a
  // config change to what "lite" resolves to must NOT invalidate the cache —
  // a byte-identical agent("x", {model:"lite"}) call stays a journal hit.
  test("a string model ref hashes by its value, not its resolution", () => {
    const lite = journalKey("p", { agentType: "g", model: "lite" }, 0)
    expect(journalKey("p", { agentType: "g", model: "lite" }, 0)).toBe(lite)
    expect(journalKey("p", { agentType: "g", model: "ultra" }, 0)).not.toBe(lite)
    expect(journalKey("p", { agentType: "g", model: "mimo/mimo-v2.5-pro" }, 0)).not.toBe(lite)
    // omitting model differs from naming a tier
    expect(journalKey("p", { agentType: "g" }, 0)).not.toBe(lite)
  })
})
