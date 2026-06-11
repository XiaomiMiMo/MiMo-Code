import { Effect } from "effect"
import path from "path"
import { createHash } from "node:crypto"
import { appendFileSync, mkdirSync } from "node:fs"
import { Database, eq, desc } from "../storage"
import { WorkflowRunTable } from "./workflow.sql"
import { Global } from "../global"
import type { SessionID } from "../session/schema"

// Recursively sort object keys so JSON.stringify is canonical (key order in the
// guest's opts object must not change the content key).
function canonical(value: unknown): unknown {
  if (value === null || typeof value !== "object") return value
  if (Array.isArray(value)) return value.map(canonical)
  return Object.fromEntries(
    Object.keys(value as Record<string, unknown>)
      .sort()
      .map((k) => [k, canonical((value as Record<string, unknown>)[k])]),
  )
}

// Content hash for one agent() call: sha256 over the SEMANTIC fields only
// (prompt + agentType/model/schema/phase). label/tools/isolation are
// display/dispatch only and are excluded so they never bust the cache.
export function journalKeyBase(prompt: string, opts: {
  agentType?: string
  model?: unknown
  schema?: unknown
  phase?: string
  [k: string]: unknown
}): string {
  const material = canonical({
    prompt,
    agentType: opts.agentType ?? null,
    model: opts.model ?? null,
    schema: opts.schema ?? null,
    phase: opts.phase ?? null,
  })
  return createHash("sha256").update(JSON.stringify(material)).digest("hex")
}

// Full journal key = content hash + ":" + occurrence index, to disambiguate
// byte-identical calls (e.g. N identical refuters) into distinct journal slots.
export function journalKey(
  prompt: string,
  opts: { agentType?: string; model?: unknown; schema?: unknown; phase?: string; [k: string]: unknown },
  occ: number,
): string {
  return journalKeyBase(prompt, opts) + ":" + occ
}

export type JournalEvent =
  | { t: "agent"; key: string; result: unknown; pass: number }
  | { t: "log"; msg: string; pass: number }
  | { t: "phase"; title: string; pass: number }

export type JournalLoad = { results: Map<string, unknown>; pass: number }

export type RunSummary = {
  runID: string
  sessionID: SessionID
  name: string
  status: "running" | "completed" | "failed" | "cancelled"
  running: number
  succeeded: number
  failed: number
  currentPhase?: string
  parentActorID?: string
  args?: unknown
  scriptSha?: string
  /** The per-agent timeout this run was originally launched with (ms). Persisted
   * so a resume that doesn't supply its own override picks the same value, instead
   * of silently defaulting to unbounded. Undefined means the launch had no timeout. */
  agentTimeoutMs?: number
  error?: string
  createdAt: number
  updatedAt: number
}

const scriptDir = () => path.join(Global.Path.data, "workflow")

// Defense in depth: persistence path functions must not trust their caller. runID
// is interpolated directly into a filename, so a value containing a path separator
// or dot-dot (`../../../etc/passwd`, `wf_../x`, an absolute path) would escape
// scriptDir. The HTTP route already rejects these, but resume()/journal IO are also
// reachable from the workflow tool and the TUI, so we re-enforce the minted shape
// here (`wf_` + base62 — a charset with no `.` or `/`). A throw here surfaces as an
// Effect defect: on the async IO paths (readScript/loadJournal) resume() captures it
// via Effect.exit and treats it as not-resumable; on the synchronous journal appends
// it fails as a defect BEFORE any appendFileSync (the caller Effect.ignore's it), so
// a malformed runID can never touch the filesystem.
// The `+` form (not the route's fixed `{26}`) is deliberate: this in-depth guard only
// needs the traversal-proof property (no `.`/`/`), so it stays correct even if the
// minted ID length changes; the strict length check lives at the route trust boundary.
const RUN_ID = /^wf_[0-9A-Za-z]+$/
const safeRunID = (runID: string) => {
  if (!RUN_ID.test(runID)) throw new Error(`invalid workflow runID: ${JSON.stringify(runID)}`)
  return runID
}
const scriptPath = (runID: string) => path.join(scriptDir(), `${safeRunID(runID)}.js`)
const journalPath = (runID: string) => path.join(scriptDir(), `${safeRunID(runID)}.jsonl`)

function toSummary(row: typeof WorkflowRunTable.$inferSelect): RunSummary {
  return {
    runID: row.id,
    sessionID: row.session_id,
    name: row.name,
    status: row.status,
    running: row.running,
    succeeded: row.succeeded,
    failed: row.failed,
    ...(row.current_phase ? { currentPhase: row.current_phase } : {}),
    ...(row.parent_actor_id ? { parentActorID: row.parent_actor_id } : {}),
    ...(row.args !== null && row.args !== undefined ? { args: row.args } : {}),
    ...(row.script_sha ? { scriptSha: row.script_sha } : {}),
    ...(row.agent_timeout_ms !== null && row.agent_timeout_ms !== undefined ? { agentTimeoutMs: row.agent_timeout_ms } : {}),
    ...(row.error ? { error: row.error } : {}),
    createdAt: row.time_created,
    updatedAt: row.time_updated,
  }
}

const recordStart = (input: {
  runID: string
  sessionID: SessionID
  name: string
  parentActorID?: string
  args?: unknown
  scriptSha?: string
  /** The per-agent timeout for this run, persisted so a subsequent resume
   * (especially via TUI / API where the caller doesn't know the original
   * launch parameters) can read it back instead of silently defaulting to
   * unbounded — which would let a wedged mimo TTFT stall the run forever. */
  agentTimeoutMs?: number
}) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .insert(WorkflowRunTable)
        .values({
          id: input.runID,
          session_id: input.sessionID,
          name: input.name,
          status: "running",
          running: 0,
          succeeded: 0,
          failed: 0,
          parent_actor_id: input.parentActorID ?? null,
          args: input.args ?? null,
          script_sha: input.scriptSha ?? null,
          agent_timeout_ms: input.agentTimeoutMs ?? null,
        })
        // On resume the row already exists. We reset the counters AND re-stamp the
        // script_sha: launch passes the CURRENT script's sha, so a same-script
        // resume re-writes the identical sha (no-op) while a changed-script relaunch
        // (the P1-2 mismatch path) overwrites the stale sha with the new one — so a
        // SUBSEQUENT resume of the now-current script replays correctly. The sha
        // COMPARISON happens in resume() against load()'s pre-launch value, before
        // this overwrite runs, so re-stamping here never hides the mismatch.
        // agent_timeout_ms is overwritten ONLY when the caller passes one (i.e. an
        // explicit override on resume); undefined input preserves the persisted
        // value via the COALESCE-style guard below.
        .onConflictDoUpdate({
          target: WorkflowRunTable.id,
          set: {
            status: "running",
            running: 0,
            succeeded: 0,
            failed: 0,
            script_sha: input.scriptSha ?? null,
            ...(input.agentTimeoutMs !== undefined ? { agent_timeout_ms: input.agentTimeoutMs } : {}),
          },
        })
        .run(),
    ),
  )

const recordPhase = (input: { runID: string; phase: string }) =>
  Effect.sync(() =>
    Database.use((db) =>
      db.update(WorkflowRunTable).set({ current_phase: input.phase }).where(eq(WorkflowRunTable.id, input.runID)).run(),
    ),
  )

const flushCounters = (input: { runID: string; running: number; succeeded: number; failed: number }) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(WorkflowRunTable)
        .set({ running: input.running, succeeded: input.succeeded, failed: input.failed })
        .where(eq(WorkflowRunTable.id, input.runID))
        .run(),
    ),
  )

const recordTerminal = (input: { runID: string; status: "completed" | "failed" | "cancelled"; error?: string }) =>
  Effect.sync(() =>
    Database.use((db) =>
      db
        .update(WorkflowRunTable)
        .set({ status: input.status, ...(input.error ? { error: input.error } : {}) })
        .where(eq(WorkflowRunTable.id, input.runID))
        .run(),
    ),
  )

const list = (input?: { sessionID?: SessionID }) =>
  Effect.sync(() =>
    Database.use((db) => {
      const rows = input?.sessionID
        ? db
            .select()
            .from(WorkflowRunTable)
            .where(eq(WorkflowRunTable.session_id, input.sessionID))
            .orderBy(desc(WorkflowRunTable.time_created))
            .all()
        : db.select().from(WorkflowRunTable).orderBy(desc(WorkflowRunTable.time_created)).all()
      return rows.map(toSummary)
    }),
  )

const load = (runID: string) =>
  Effect.sync(() =>
    Database.use((db) => {
      const row = db.select().from(WorkflowRunTable).where(eq(WorkflowRunTable.id, runID)).get()
      return row ? toSummary(row) : undefined
    }),
  )

const writeScript = (runID: string, body: string) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await Bun.write(scriptPath(runID), body)
  })

const readScript = (runID: string) => Effect.promise(() => Bun.file(scriptPath(runID)).text())

const appendJournal = (runID: string, event: JournalEvent) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await fs.appendFile(journalPath(runID), JSON.stringify(event) + "\n")
  })

// Synchronous append (one or a batch of events). Called PER-AGENT from the
// agent() hook the instant a spawn succeeds, so each result is durable on disk
// immediately — a mid-run process exit / SIGKILL / deadline leaves a journal
// containing every completed agent, which is what makes resume replay them
// (durability does NOT wait for run completion). It is SYNCHRONOUS on purpose:
// an Effect.promise(async fs) append suspends the calling fiber on a macrotask,
// which empirically starves the quickjs sandbox pump (the guest's own promise
// stops being driven); a sync write completes in one scheduler slice and never
// yields the pump. Empty batch is a no-op (no mkdir/open). Errors propagate as a
// defect for Effect.ignore.
const appendJournalSync = (runID: string, events: JournalEvent[]) =>
  Effect.sync(() => {
    if (events.length === 0) return
    mkdirSync(scriptDir(), { recursive: true })
    appendFileSync(journalPath(runID), events.map((e) => JSON.stringify(e) + "\n").join(""))
  })

const loadJournal = (runID: string): Effect.Effect<JournalLoad> =>
  Effect.promise(async () => {
    const file = Bun.file(journalPath(runID))
    if (!(await file.exists())) return { results: new Map(), pass: 1 }
    const text = await file.text()
    const results = new Map<string, unknown>()
    let maxPass = 0
    for (const line of text.split("\n")) {
      if (!line) continue
      let ev: JournalEvent
      try {
        ev = JSON.parse(line) as JournalEvent
      } catch {
        continue // torn/partial line (crash mid-append) — skip
      }
      if (typeof ev.pass === "number" && ev.pass > maxPass) maxPass = ev.pass
      if (ev.t === "agent") results.set(ev.key, ev.result)
    }
    return { results, pass: maxPass + 1 }
  })

// Truncate the journal to empty (MR104 P1-2). Called on the resume sha-mismatch
// path BEFORE the fresh relaunch appends: replaying the OLD journal onto an EDITED
// script is silent divergence, so the stale lines must not survive — and a fresh
// run must not interleave its appends with them (a LATER resume's loadJournal would
// otherwise read both old + new → wrong replay). We truncate (write "") rather than
// delete so the file always exists for a concurrent reader; loadJournal treats an
// empty file as "no results, pass 1" exactly like a missing one. mkdir first so the
// truncate cannot fail on a never-written run (no journal yet → still ends empty).
const clearJournal = (runID: string) =>
  Effect.promise(async () => {
    const fs = await import("fs/promises")
    await fs.mkdir(scriptDir(), { recursive: true })
    await Bun.write(journalPath(runID), "")
  })

export const WorkflowPersistence = {
  recordStart,
  recordPhase,
  flushCounters,
  recordTerminal,
  list,
  load,
  writeScript,
  readScript,
  appendJournal,
  appendJournalSync,
  loadJournal,
  clearJournal,
}
