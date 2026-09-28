import z from "zod"
import { setTimeout as sleep } from "node:timers/promises"
import { fn } from "@/util/fn"
import { Database, asc, eq, inArray } from "@/storage"
import { Project } from "@/project"
import { BusEvent } from "@/bus/bus-event"
import { GlobalBus } from "@/bus/global"
import { Auth } from "@/auth"
import { SyncEvent } from "@/sync"
import { EventSequenceTable, EventTable } from "@/sync/event.sql"
import { Flag } from "@/flag/flag"
import { Log } from "@/util"
import { Filesystem } from "@/util"
import { ProjectID } from "@/project/schema"
import { Slug } from "@mimo-ai/shared/util/slug"
import { WorkspaceTable } from "./workspace.sql"
import { getAdaptor } from "./adaptors"
import { WorkspaceInfo } from "./types"
import { WorkspaceID } from "./schema"
import { parseSSE } from "./sse"
import { Session } from "@/session"
import { SessionTable } from "@/session/session.sql"
import { SessionID } from "@/session/schema"
import { errorData } from "@/util/error"
import { AppRuntime } from "@/effect/app-runtime"
import { waitEvent } from "./util"
import { WorkspaceContext } from "./workspace-context"
import { Effect } from "effect"
import { Instance } from "@/project/instance"
import { SessionRunState } from "@/session/run-state"
import { ActorExecution } from "@/actor/execution"
import { ExecutionOwnership } from "@/session/execution-ownership"
import * as QueueSync from "@/turn-queue/sync"
import { TurnReceiptTable } from "@/turn-queue/turn-queue.sql"

export const Info = WorkspaceInfo.meta({
  ref: "Workspace",
})
export type Info = z.infer<typeof Info>

export const ConnectionStatus = z.object({
  workspaceID: WorkspaceID.zod,
  status: z.enum(["connected", "connecting", "disconnected", "error"]),
})
export type ConnectionStatus = z.infer<typeof ConnectionStatus>

const Restore = z.object({
  workspaceID: WorkspaceID.zod,
  sessionID: SessionID.zod,
  total: z.number().int().min(0),
  step: z.number().int().min(0),
})

export const Event = {
  Ready: BusEvent.define(
    "workspace.ready",
    z.object({
      name: z.string(),
    }),
  ),
  Failed: BusEvent.define(
    "workspace.failed",
    z.object({
      message: z.string(),
    }),
  ),
  Restore: BusEvent.define("workspace.restore", Restore),
  Status: BusEvent.define("workspace.status", ConnectionStatus),
}

function fromRow(row: typeof WorkspaceTable.$inferSelect): Info {
  return {
    id: row.id,
    type: row.type,
    branch: row.branch,
    name: row.name,
    directory: row.directory,
    extra: row.extra,
    projectID: row.project_id,
  }
}

const CreateInput = z.object({
  id: WorkspaceID.zod.optional(),
  type: Info.shape.type,
  branch: Info.shape.branch,
  projectID: ProjectID.zod,
  extra: Info.shape.extra,
})

export const create = fn(CreateInput, async (input) => {
  const id = WorkspaceID.ascending(input.id)
  const adaptor = await getAdaptor(input.projectID, input.type)

  const config = await adaptor.configure({ ...input, id, name: Slug.create(), directory: null })

  const info: Info = {
    id,
    type: config.type,
    branch: config.branch ?? null,
    name: config.name ?? null,
    directory: config.directory ?? null,
    extra: config.extra ?? null,
    projectID: input.projectID,
  }

  Database.use((db) => {
    db.insert(WorkspaceTable)
      .values({
        id: info.id,
        type: info.type,
        branch: info.branch,
        name: info.name,
        directory: info.directory,
        extra: info.extra,
        project_id: info.projectID,
      })
      .run()
  })

  const env = {
    MIMOCODE_AUTH_CONTENT: JSON.stringify(await AppRuntime.runPromise(Auth.Service.use((auth) => auth.all()))),
    MIMOCODE_WORKSPACE_ID: config.id,
    MIMOCODE_EXPERIMENTAL_WORKSPACES: "true",
    OTEL_EXPORTER_OTLP_HEADERS: process.env.OTEL_EXPORTER_OTLP_HEADERS,
    OTEL_EXPORTER_OTLP_ENDPOINT: process.env.OTEL_EXPORTER_OTLP_ENDPOINT,
    OTEL_RESOURCE_ATTRIBUTES: process.env.OTEL_RESOURCE_ATTRIBUTES,
  }
  await adaptor.create(config, env)

  startSync(info)

  await waitEvent({
    timeout: TIMEOUT,
    fn(event) {
      if (event.workspace === info.id && event.payload.type === Event.Status.type) {
        const { status } = event.payload.properties
        return status === "error" || status === "connected"
      }
      return false
    },
  })

  return info
})

const SessionRestoreInput = z.object({
  workspaceID: WorkspaceID.zod,
  sessionID: SessionID.zod,
})

export const sessionRestore = fn(SessionRestoreInput, async (input) => {
  log.info("session restore requested", {
    workspaceID: input.workspaceID,
    sessionID: input.sessionID,
  })
  try {
    const space = await get(input.workspaceID)
    if (!space) throw new Error(`Workspace not found: ${input.workspaceID}`)

    const adaptor = await getAdaptor(space.projectID, space.type)
    const target = await adaptor.target(space)

    const origin = Database.use((db) => db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get())
    if (!origin) throw new Error(`Session not found: ${input.sessionID}`)
    const retryRemote = origin.workspace_id === input.workspaceID && target.type === "remote"
    let sourceDirectory = origin.directory
    if (origin.workspace_id && !retryRemote) {
      const owner = await get(origin.workspace_id)
      if (!owner) throw new Error(`Source workspace not found: ${origin.workspace_id}`)
      const sourceAdaptor = await getAdaptor(owner.projectID, owner.type)
      const sourceTarget = await sourceAdaptor.target(owner)
      if (sourceTarget.type !== "local")
        throw new Error("Remote workspace transfer must be initiated by its execution owner; a mirror cannot transfer its lease")
      sourceDirectory = sourceTarget.directory
    }
    const source = retryRemote ? undefined : await WorkspaceContext.provide({
      workspaceID: origin.workspace_id ?? undefined,
      fn: () => Instance.provide({
        directory: sourceDirectory,
        fn: () => AppRuntime.runPromise(Effect.gen(function* () {
          const identity = yield* ExecutionOwnership.captureIdentity
          const runs = yield* SessionRunState.Service
          const executions = yield* ActorExecution.Service
          const snapshot = yield* runs.sessionExecutionSnapshot(input.sessionID)
          return { identity, isIdle: () => snapshot.isIdle() && !executions.hasActiveUnsafe(input.sessionID) }
        })),
      }),
    })
    const transfer = Database.transaction((db) => {
      if (source) {
        ExecutionOwnership.assertOwnership(db, input.sessionID, source.identity)
        if (!source.isIdle()) throw new Error("Cannot transfer a session with active execution")
      } else {
        const current = db.select().from(SessionTable).where(eq(SessionTable.id, input.sessionID)).get()
        if (current?.workspace_id !== input.workspaceID) throw new Error("Session owner changed before retry")
      }
      if (db.select().from(TurnReceiptTable).where(eq(TurnReceiptTable.session_id, input.sessionID)).all()
        .some((receipt) => receipt.state === "claimed")) throw new Error("Cannot transfer unresolved execution claims")
      if (source) {
        SyncEvent.run(Session.Event.Updated, { sessionID: input.sessionID, info: { workspaceID: input.workspaceID } })
        QueueSync.snapshot(input.sessionID)
      }
      const queueSnapshot = QueueSync.capture(input.sessionID, db)
      const events = db.select({
        id: EventTable.id,
        aggregateID: EventTable.aggregate_id,
        seq: EventTable.seq,
        type: EventTable.type,
        data: EventTable.data,
      }).from(EventTable).where(eq(EventTable.aggregate_id, input.sessionID)).orderBy(asc(EventTable.seq)).all()
      if (target.type === "remote" &&
          (events[0]?.seq !== 0 || !events.some((event) => event.type.startsWith("session.created."))))
        throw new Error("Remote restoration requires a complete recorded session history")
      return { events, queueSnapshot, finalSeq: events.at(-1)?.seq ?? -1 }
    }, { behavior: "immediate" })
    const all = transfer.events
    const total = 1
    log.info("session restore prepared", {
      workspaceID: input.workspaceID,
      sessionID: input.sessionID,
      workspaceType: space.type,
      directory: space.directory,
      target: target.type === "remote" ? String(route(target.url, "/sync/replay")) : target.directory,
      events: all.length,
      batches: total,
      first: all[0]?.seq,
      last: all.at(-1)?.seq,
    })
    GlobalBus.emit("event", {
      directory: "global",
      workspace: input.workspaceID,
      payload: {
        type: Event.Restore.type,
        properties: {
          workspaceID: input.workspaceID,
          sessionID: input.sessionID,
          total,
          step: 0,
        },
      },
    })
    if (target.type === "remote") {
      const url = route(target.url, "/sync/replay")
      const headers = new Headers(target.headers)
      headers.set("content-type", "application/json")
      const res = await fetch(url, {
        method: "POST",
        headers,
        body: JSON.stringify({
          directory: space.directory ?? "",
          workspaceID: input.workspaceID,
          events: transfer.events,
          queueSnapshot: transfer.queueSnapshot,
          finalSeq: transfer.finalSeq,
        }),
      })
      if (!res.ok) {
        const body = await res.text()
        // The target may have committed before its response was lost. Never reopen the old owner here.
        throw new Error(`Failed to restore session ${input.sessionID} into workspace ${input.workspaceID}: HTTP ${res.status} ${body}`)
      }
    }
    GlobalBus.emit("event", {
      directory: "global",
      workspace: input.workspaceID,
      payload: {
        type: Event.Restore.type,
        properties: { workspaceID: input.workspaceID, sessionID: input.sessionID, total, step: 1 },
      },
    })

    log.info("session restore complete", {
      workspaceID: input.workspaceID,
      sessionID: input.sessionID,
      batches: total,
    })

    return {
      total,
    }
  } catch (err) {
    log.error("session restore failed", {
      workspaceID: input.workspaceID,
      sessionID: input.sessionID,
      error: errorData(err),
    })
    throw err
  }
})

export function list(project: Project.Info) {
  const rows = Database.use((db) =>
    db.select().from(WorkspaceTable).where(eq(WorkspaceTable.project_id, project.id)).all(),
  )
  const spaces = rows.map(fromRow).sort((a, b) => a.id.localeCompare(b.id))
  return spaces
}

export const get = fn(WorkspaceID.zod, async (id) => {
  const row = Database.use((db) => db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())
  if (!row) return
  return fromRow(row)
})

export const remove = fn(WorkspaceID.zod, async (id) => {
  const sessions = Database.use((db) =>
    db.select({ id: SessionTable.id }).from(SessionTable).where(eq(SessionTable.workspace_id, id)).all(),
  )
  for (const session of sessions) {
    await AppRuntime.runPromise(Session.Service.use((svc) => svc.remove(session.id)))
  }

  const row = Database.use((db) => db.select().from(WorkspaceTable).where(eq(WorkspaceTable.id, id)).get())

  if (row) {
    stopSync(id)

    const info = fromRow(row)
    try {
      const adaptor = await getAdaptor(info.projectID, row.type)
      await adaptor.remove(info)
    } catch {
      log.error("adaptor not available when removing workspace", { type: row.type })
    }
    Database.use((db) => db.delete(WorkspaceTable).where(eq(WorkspaceTable.id, id)).run())
    return info
  }
})

const connections = new Map<WorkspaceID, ConnectionStatus>()
const aborts = new Map<WorkspaceID, AbortController>()
const TIMEOUT = 5000

function setStatus(id: WorkspaceID, status: ConnectionStatus["status"]) {
  const prev = connections.get(id)
  if (prev?.status === status) return
  const next = { workspaceID: id, status }
  connections.set(id, next)

  if (status === "error") {
    aborts.delete(id)
  }

  GlobalBus.emit("event", {
    directory: "global",
    workspace: id,
    payload: {
      type: Event.Status.type,
      properties: next,
    },
  })
}

export function status(): ConnectionStatus[] {
  return [...connections.values()]
}

function synced(state: Record<string, number>) {
  const ids = Object.keys(state)
  if (ids.length === 0) return true

  const done = Object.fromEntries(
    Database.use((db) =>
      db
        .select({
          id: EventSequenceTable.aggregate_id,
          seq: EventSequenceTable.seq,
        })
        .from(EventSequenceTable)
        .where(inArray(EventSequenceTable.aggregate_id, ids))
        .all(),
    ).map((row) => [row.id, row.seq]),
  ) as Record<string, number>

  return ids.every((id) => {
    return (done[id] ?? -1) >= state[id]
  })
}

export async function isSyncing(workspaceID: WorkspaceID) {
  return aborts.has(workspaceID)
}

export async function waitForSync(workspaceID: WorkspaceID, state: Record<string, number>, signal?: AbortSignal) {
  if (synced(state)) return

  try {
    await waitEvent({
      timeout: TIMEOUT,
      signal,
      fn(event) {
        if (event.workspace !== workspaceID && event.payload.type !== "sync") {
          return false
        }
        return synced(state)
      },
    })
  } catch {
    if (signal?.aborted) throw signal.reason ?? new Error("Request aborted")
    throw new Error(`Timed out waiting for sync fence: ${JSON.stringify(state)}`)
  }
}

const log = Log.create({ service: "workspace-sync" })

function route(url: string | URL, path: string) {
  const next = new URL(url)
  next.pathname = `${next.pathname.replace(/\/$/, "")}${path}`
  next.search = ""
  next.hash = ""
  return next
}

async function connectSSE(url: URL | string, headers: HeadersInit | undefined, signal: AbortSignal) {
  const res = await fetch(route(url, "/global/event"), {
    method: "GET",
    headers,
    signal,
  })

  if (!res.ok) throw new Error(`Workspace sync HTTP failure: ${res.status}`)
  if (!res.body) throw new Error("No response body from global sync")

  return res.body
}

async function syncHistory(space: Info, url: URL | string, headers: HeadersInit | undefined, signal: AbortSignal) {
  const sessionIDs = Database.use((db) =>
    db
      .select({ id: SessionTable.id })
      .from(SessionTable)
      .where(eq(SessionTable.workspace_id, space.id))
      .all()
      .map((row) => row.id),
  )
  const state = sessionIDs.length
    ? Object.fromEntries(
        Database.use((db) =>
          db.select().from(EventSequenceTable).where(inArray(EventSequenceTable.aggregate_id, sessionIDs)).all(),
        ).map((row) => [row.aggregate_id, row.seq]),
      )
    : {}

  log.info("syncing workspace history", {
    workspaceID: space.id,
    sessions: sessionIDs.length,
    known: Object.keys(state).length,
  })

  const requestHeaders = new Headers(headers)
  requestHeaders.set("content-type", "application/json")

  const res = await fetch(route(url, "/sync/history"), {
    method: "POST",
    headers: requestHeaders,
    body: JSON.stringify(state),
    signal,
  })

  if (!res.ok) {
    const body = await res.text()
    throw new Error(`Workspace history HTTP failure: ${res.status} ${body}`)
  }

  const events = await res.json()

  return WorkspaceContext.provide({
    workspaceID: space.id,
    fn: () => {
      for (const event of events) {
        SyncEvent.replay(
          {
            id: event.id,
            aggregateID: event.aggregate_id,
            seq: event.seq,
            type: event.type,
            data: event.data,
          },
          { publish: true },
        )
      }
    },
  })

  log.info("workspace history synced", {
    workspaceID: space.id,
    events: events.length,
  })
}

async function syncWorkspaceLoop(space: Info, signal: AbortSignal) {
  const adaptor = await getAdaptor(space.projectID, space.type)
  const target = await adaptor.target(space)

  if (target.type === "local") return null

  let attempt = 0

  while (!signal.aborted) {
    log.info("connecting to global sync", { workspace: space.name })
    setStatus(space.id, "connecting")

    let stream
    try {
      stream = await connectSSE(target.url, target.headers, signal)
      await syncHistory(space, target.url, target.headers, signal)
    } catch (err) {
      stream = null
      setStatus(space.id, "error")
      log.info("failed to connect to global sync", {
        workspace: space.name,
        err,
      })
    }

    if (stream) {
      attempt = 0

      log.info("global sync connected", { workspace: space.name })
      setStatus(space.id, "connected")

      await parseSSE(stream, signal, (evt: any) => {
        try {
          if (!("payload" in evt)) return
          if (evt.payload.type === "server.heartbeat") return

          if (evt.payload.type === "sync") {
            SyncEvent.replay(evt.payload.syncEvent as SyncEvent.SerializedEvent)
          }

          GlobalBus.emit("event", {
            directory: evt.directory,
            project: evt.project,
            workspace: space.id,
            payload: evt.payload,
          })
        } catch (err) {
          log.info("failed to replay global event", {
            workspaceID: space.id,
            error: err,
          })
        }
      })

      log.info("disconnected from global sync: " + space.id)
      setStatus(space.id, "disconnected")
    }

    // Back off reconnect attempts up to 2 minutes while the workspace
    // stays unavailable.
    await sleep(Math.min(120_000, 1_000 * 2 ** attempt))
    attempt += 1
  }
}

async function startSync(space: Info) {
  if (!Flag.MIMOCODE_EXPERIMENTAL_WORKSPACES) return

  const adaptor = await getAdaptor(space.projectID, space.type)
  const target = await adaptor.target(space)

  if (target.type === "local") {
    void Filesystem.exists(target.directory).then((exists) => {
      setStatus(space.id, exists ? "connected" : "error")
    })
    return
  }

  if (aborts.has(space.id)) return true

  setStatus(space.id, "disconnected")

  const abort = new AbortController()
  aborts.set(space.id, abort)

  void syncWorkspaceLoop(space, abort.signal).catch((error) => {
    aborts.delete(space.id)

    setStatus(space.id, "error")
    log.warn("workspace listener failed", {
      workspaceID: space.id,
      error,
    })
  })
}

function stopSync(id: WorkspaceID) {
  aborts.get(id)?.abort()
  aborts.delete(id)
  connections.delete(id)
}

export function startWorkspaceSyncing(projectID: ProjectID) {
  const spaces = Database.use((db) =>
    db
      .select({ workspace: WorkspaceTable })
      .from(WorkspaceTable)
      .innerJoin(SessionTable, eq(SessionTable.workspace_id, WorkspaceTable.id))
      .where(eq(WorkspaceTable.project_id, projectID))
      .all(),
  )

  for (const row of new Map(spaces.map((row) => [row.workspace.id, row.workspace])).values()) {
    void startSync(fromRow(row))
  }
}

export * as Workspace from "./workspace"
