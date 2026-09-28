import z from "zod"
import { Hono } from "hono"
import { describeRoute, validator, resolver } from "hono-openapi"
import { SyncEvent } from "@/sync"
import { Database, asc, and, not, or, lte, eq } from "@/storage"
import { EventTable } from "@/sync/event.sql"
import { lazy } from "@/util/lazy"
import { Log } from "@/util"
import { startWorkspaceSyncing } from "@/control-plane/workspace"
import { Instance } from "@/project/instance"
import { errors } from "../../error"
import { AppRuntime } from "@/effect/app-runtime"
import { Effect } from "effect"
import { InstanceState } from "@/effect"
import { SessionRunState } from "@/session/run-state"
import { ActorExecution } from "@/actor/execution"
import { SessionID } from "@/session/schema"
import { WorkspaceID } from "@/control-plane/schema"
import { QueueValidationError, SnapshotSchema } from "@/turn-queue/sync"
import { ReplayEventSchema, installRestore, RestoreConflict, RestorePayloadError } from "@/sync/restore"

const ReplayEvent = ReplayEventSchema

const log = Log.create({ service: "server.sync" })

export const SyncRoutes = lazy(() =>
  new Hono()
    .post(
      "/start",
      describeRoute({
        summary: "Start workspace sync",
        description: "Start sync loops for workspaces in the current project that have active sessions.",
        operationId: "sync.start",
        responses: {
          200: {
            description: "Workspace sync started",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) => {
        startWorkspaceSyncing(Instance.project.id)
        return c.json(true)
      },
    )
    .post(
      "/replay",
      describeRoute({
        summary: "Replay sync events",
        description: "Validate and replay a complete sync event history.",
        operationId: "sync.replay",
        responses: {
          200: {
            description: "Replayed sync events",
            content: {
              "application/json": {
                schema: resolver(
                  z.object({
                    sessionID: z.string(),
                  }),
                ),
              },
            },
          },
          ...errors(400, 409),
        },
      }),
      validator(
        "json",
        z.object({
          directory: z.string(),
          events: z.array(ReplayEvent).min(1),
          queueSnapshot: SnapshotSchema.optional(),
          finalSeq: z.number().int().nonnegative().optional(),
          workspaceID: WorkspaceID.zod.optional(),
        }).superRefine((value, ctx) => {
          if ((value.queueSnapshot || value.finalSeq !== undefined || value.workspaceID) &&
              (!value.queueSnapshot || value.finalSeq === undefined || !value.workspaceID))
            ctx.addIssue({ code: "custom", message: "Queue restore requires snapshot, finalSeq and workspaceID" })
        }),
      ),
      async (c) => {
        const body = c.req.valid("json")
        const events = body.events
        const source = events[0].aggregateID

        log.info("sync replay requested", {
          sessionID: source,
          events: events.length,
          first: events[0]?.seq,
          last: events.at(-1)?.seq,
          directory: body.directory,
        })
        if (body.queueSnapshot && body.workspaceID && body.finalSeq !== undefined) {
          const sessionID = SessionID.make(source)
          const target = await AppRuntime.runPromise(Effect.gen(function* () {
            const workspaceID = yield* InstanceState.workspaceID
            const runs = yield* SessionRunState.Service
            const executions = yield* ActorExecution.Service
            const snapshot = yield* runs.sessionExecutionSnapshot(sessionID)
            return { workspaceID, isIdle: () => snapshot.isIdle() && !executions.hasActiveUnsafe(sessionID) }
          }))
          if (target.workspaceID !== body.workspaceID)
            return c.json({ name: "RestoreConflict", message: "Server is not the requested workspace owner" }, 409)
          try {
            installRestore({
              events,
              queueSnapshot: body.queueSnapshot,
              finalSeq: body.finalSeq,
              workspaceID: body.workspaceID,
              isIdle: target.isIdle,
            })
          } catch (error) {
            if (error instanceof RestoreConflict)
              return c.json({ name: "RestoreConflict", message: error.message }, 409)
            if (error instanceof RestorePayloadError || error instanceof QueueValidationError || error instanceof SyncEvent.ReplayValidationError || error instanceof z.ZodError)
              return c.json({ name: "RestorePayloadError", message: error.message }, 400)
            throw error
          }
        } else {
          try {
            Database.transaction(() => SyncEvent.replayAll(events), { behavior: "immediate" })
          } catch (error) {
            if (error instanceof SyncEvent.ReplayValidationError || error instanceof QueueValidationError || error instanceof z.ZodError)
              return c.json({ name: "ReplayValidationError", message: error.message }, 400)
            throw error
          }
        }

        log.info("sync replay complete", {
          sessionID: source,
          events: events.length,
          first: events[0]?.seq,
          last: events.at(-1)?.seq,
        })

        return c.json({
          sessionID: source,
        })
      },
    )
    .post(
      "/history",
      describeRoute({
        summary: "List sync events",
        description:
          "List sync events for all aggregates. Keys are aggregate IDs the client already knows about, values are the last known sequence ID. Events with seq > value are returned for those aggregates. Aggregates not listed in the input get their full history.",
        operationId: "sync.history.list",
        responses: {
          200: {
            description: "Sync events",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      aggregate_id: z.string(),
                      seq: z.number(),
                      type: z.string(),
                      data: z.record(z.string(), z.unknown()),
                    }),
                  ),
                ),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.record(z.string(), z.number().int().min(0))),
      async (c) => {
        const body = c.req.valid("json")
        const exclude = Object.entries(body)
        const where =
          exclude.length > 0
            ? not(or(...exclude.map(([id, seq]) => and(eq(EventTable.aggregate_id, id), lte(EventTable.seq, seq))))!)
            : undefined
        const rows = Database.use((db) => db.select().from(EventTable).where(where).orderBy(asc(EventTable.seq)).all())
        return c.json(rows)
      },
    ),
)
