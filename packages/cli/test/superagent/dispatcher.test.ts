import { expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import * as D from "../../src/superagent/dispatcher"
import { Database, eq } from "../../src/storage"
import { ActionTable, TicketTable } from "../../src/superagent/superagent.sql"
const source = (eventId: string, threadId = "example-thread") => ({
  channel: "example",
  eventId,
  threadId,
  senderId: "user",
})
function create(dir: string, key: string) {
  const input = D.request(dir, source(key), key)
  return D.create(dir, input.id, key)
}

test("requests are durable and idempotent; a shared thread delivers feedback to every owner exactly once", async () => {
  await using tmp = await tmpdir()
  const a = create(tmp.path, "a"),
    b = create(tmp.path, "b")
  expect(D.request(tmp.path, source("a"), "a").ticket_id).toBe(a.id)
  expect(() => D.request(tmp.path, source("a"), "different")).toThrow("different content")
  D.ingest(tmp.path, source("follow"), "Fix review", true, false)
  D.ingest(tmp.path, source("follow"), "Fix review", true, false)
  expect(D.get(tmp.path, a.id).revision).toBe(1)
  expect(D.get(tmp.path, b.id).revision).toBe(1)
  const row = D.pending(tmp.path).find((x) => x.ticket_id === b.id && x.payload.revision === 1)!
  D.report(D.get(tmp.path, b.id), 1, { state: "ready", summary: "Checked", replyTo: row.payload.inputId })
  expect(D.get(tmp.path, b.id).phase).toBe("completed")
  expect(() => D.report(D.get(tmp.path, a.id), 0, { state: "ready", summary: "Old" })).toThrow("stale")
})

test("human questions are actionable and follow-up clears them; PR delivery stays open until its actual thread closes", async () => {
  await using tmp = await tmpdir()
  let t = create(tmp.path, "question")
  D.report(t, 0, { state: "blocked", summary: "Need a destination", humanAction: "Which repository?" })
  expect(D.get(tmp.path, t.id).attention).toBe("Which repository?")
  D.ingest(tmp.path, source("bot"), "CI completed", false, false)
  expect(D.get(tmp.path, t.id).revision).toBe(0)
  t = D.follow(tmp.path, t.id, source("answer"), "Use the example repository")
  expect(t.attention).toBeUndefined()
  D.subscribe(tmp.path, t.id, { channel: "example", threadId: "pr-1", kind: "deliverable" })
  D.report(D.get(tmp.path, t.id), 1, { state: "ready", summary: "Tests pass; PR opened", humanAction: null })
  expect(D.get(tmp.path, t.id).phase).toBe("awaiting_review")
  D.threadClosed(tmp.path, "example", "pr-1", "merged")
  expect(D.get(tmp.path, t.id).phase).toBe("completed")
})

test("stop is idempotent and only explicit resume reopens a stopped task", async () => {
  await using tmp = await tmpdir()
  const t = create(tmp.path, "stop")
  D.action(tmp.path, t.id, "cancel", "stop-1")
  D.action(tmp.path, t.id, "cancel", "stop-1")
  expect(D.get(tmp.path, t.id).revision).toBe(1)
  expect(() => D.follow(tmp.path, t.id, source("later"), "Continue")).toThrow("explicitly resume")
  D.ingest(tmp.path, source("bot"), "CI failed", false, false)
  expect(D.get(tmp.path, t.id).phase).toBe("cancelled")
  D.action(tmp.path, t.id, "resume", "resume-1")
  expect(D.get(tmp.path, t.id).phase).toBe("queued")
})

test("recovery retries safe delivery in scope, retains legacy history and holds uncertain non-idempotent replies", async () => {
  await using tmp = await tmpdir()
  const t = create(tmp.path, "recover")
  const own = D.pending(tmp.path).find((x) => x.kind === "deliver")!
  D.claim(own.id)
  D.queue(tmp.path, "reply", "unsafe-reply", { source: source("reply"), text: "Result" }, t.id)
  const reply = D.pending(tmp.path).find((x) => x.kind === "reply")!
  D.claim(reply.id)
  Database.use((db) =>
    db
      .insert(ActionTable)
      .values({
        id: "legacy-action",
        key: "legacy",
        directory: tmp.path,
        kind: "route",
        payload: {},
        state: "pending",
        time_created: 0,
      })
      .run(),
  )
  Database.use((db) =>
    db
      .update(TicketTable)
      .set({ data: { ...t, version: 1, phase: "working" } })
      .where(eq(TicketTable.id, t.id))
      .run(),
  )
  D.recover(() => false, tmp.path)
  expect(D.pending(tmp.path).some((x) => x.id === own.id)).toBe(true)
  expect(D.pending(tmp.path).some((x) => x.id === reply.id || x.id === "legacy-action")).toBe(false)
  expect(D.get(tmp.path, t.id).phase).toBe("waiting")
  expect(() => D.retry(tmp.path, "legacy-action")).toThrow("Historical")
})

test("a reply to Router clarification is accepted in the same Channel thread without another mention", async () => {
  await using tmp = await tmpdir()
  const first = D.ingest(tmp.path, source("clarify"), "Please fix this", true, true)!
  D.reply(tmp.path, first.id, "Which project?")
  const answer = D.ingest(tmp.path, source("answer"), "The example project", true, false)
  expect(answer?.text).toBe("The example project")
  D.resolved(tmp.path, first.id)
  D.resolved(tmp.path, answer!.id)
  expect(D.ingest(tmp.path, source("unaddressed"), "Unrelated thread chatter", true, false)).toBeUndefined()
})
