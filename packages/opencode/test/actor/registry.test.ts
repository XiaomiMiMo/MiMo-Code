import { afterEach, beforeEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { ActorRegistry } from "../../src/actor/registry"
import { ActorRegistryTable } from "../../src/actor/actor.sql"
import { SessionID } from "../../src/session/schema"
import { Database, eq, and } from "../../src/storage"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

void Log.init({ print: false })

// Combined layer for tests: Session + ActorRegistry both using the same Bus/DB
const testLayer = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer)

afterEach(async () => {
  await Instance.disposeAll()
})

// Database.Client is a process-level singleton so rows survive across tmpdirs.
// orphan recovery only touches rows whose instance_id differs, and same-process
// tests share the same PROCESS_INSTANCE_ID — so wipe leftover rows before each test.
beforeEach(() => {
  Database.use((db) => db.delete(ActorRegistryTable).run())
})

/**
 * Run test body with a single runtime instance per `Instance.provide` scope.
 * This ensures orphan recovery and the stuck-detection fiber are started only
 * once, and all reads/writes share the same layer state.
 */
async function withRegistry(directory: string, fn: (rt: ManagedRuntime.ManagedRuntime<Session.Service | ActorRegistry.Service, never>) => Promise<void>) {
  return Instance.provide({
    directory,
    fn: async () => {
      const rt = ManagedRuntime.make(testLayer)
      try {
        await fn(rt)
      } finally {
        await rt.dispose()
      }
    },
  })
}

describe("ActorRegistry", () => {
  describe("register", () => {
    test("registers a new task and returns a Actor", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))

        const taskId = SessionID.descending()
        const entry = await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Research authentication",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        expect(entry.actorID).toBe(taskId)
        expect(entry.sessionID).toBe(parent.id)
        expect(entry.status).toBe("pending")
        expect(entry.agent).toBe("explore")
        expect(entry.description).toBe("Research authentication")
        expect(entry.contextMode).toBe("none")
        expect(entry.background).toBe(false)
        expect(entry.turnCount).toBe(0)
        expect(typeof entry.time.created).toBe("number")
        expect(typeof entry.time.updated).toBe("number")
        expect(entry.time.completed).toBeUndefined()
      })
    })

    test("registers a background task", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        const entry = await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "build",
              description: "Build project",
              contextMode: "state",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )

        expect(entry.background).toBe(true)
        expect(entry.contextMode).toBe("state")
      })
    })
  })

  describe("get", () => {
    test("retrieves a registered task by id", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Test task",
              contextMode: "full",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        const found = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(found).toBeDefined()
        expect(found!.actorID).toBe(taskId)
        expect(found!.description).toBe("Test task")
      })
    })

    test("returns undefined for unknown id", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const unknown = SessionID.descending()
        const result = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, unknown)))
        expect(result).toBeUndefined()
      })
    })
  })

  describe("updateStatus", () => {
    test("updates task status to running", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Status test",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        await rt.runPromise(ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, taskId, { status: "running" })))

        const updated = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(updated!.status).toBe("running")
        expect(updated!.time.completed).toBeUndefined()
      })
    })

    test("sets completed time for terminal status (idle + success outcome)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Terminal status test",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, taskId, { status: "idle", lastOutcome: "success" })),
        )

        const updated = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(updated!.status).toBe("idle")
        expect(updated!.lastOutcome).toBe("success")
        expect(typeof updated!.time.completed).toBe("number")
      })
    })

    test("stores error message for failed status (idle + failure outcome)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Error test",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.updateStatus(parent.id, taskId, { status: "idle", lastOutcome: "failure", lastError: "something went wrong" }),
          ),
        )

        const updated = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(updated!.status).toBe("idle")
        expect(updated!.lastOutcome).toBe("failure")
        expect(updated!.lastError).toBe("something went wrong")
        expect(typeof updated!.time.completed).toBe("number")
      })
    })
  })

  describe("updateTurn", () => {
    test("increments turn count and updates last_turn_time", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Turn count test",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        const before = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(before!.turnCount).toBe(0)

        await rt.runPromise(ActorRegistry.Service.use((svc) => svc.updateTurn(parent.id, taskId)))
        await rt.runPromise(ActorRegistry.Service.use((svc) => svc.updateTurn(parent.id, taskId)))

        const after = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(after!.turnCount).toBe(2)
      })
    })
  })

  describe("listBySession", () => {
    test("returns all actors registered under a session", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const other = await rt.runPromise(Session.Service.use((svc) => svc.create()))

        const id1 = SessionID.descending()
        const id2 = SessionID.descending()
        const id3 = SessionID.descending()

        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: id1,
              mode: "subagent",
              agent: "explore",
              description: "Task 1",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: id2,
              mode: "subagent",
              agent: "build",
              description: "Task 2",
              contextMode: "state",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: other.id,
              actorID: id3,
              mode: "subagent",
              agent: "explore",
              description: "Other parent task",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )

        const tasks = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.listBySession(parent.id)))
        expect(tasks.length).toBe(3) // "main" (auto-registered) + id1 + id2
        const ids = tasks.map((t) => t.actorID)
        expect(ids).toContain("main")
        expect(ids).toContain(id1)
        expect(ids).toContain(id2)
        expect(ids).not.toContain(id3)
      })
    })
  })

  describe("listActive", () => {
    test("returns tasks with pending or running status", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))

        const idPending = SessionID.descending()
        const idRunning = SessionID.descending()
        const idCompleted = SessionID.descending()

        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: idPending,
              mode: "subagent",
              agent: "explore",
              description: "Pending task",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: idRunning,
              mode: "subagent",
              agent: "build",
              description: "Running task",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: idCompleted,
              mode: "subagent",
              agent: "explore",
              description: "Completed task",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )

        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, idRunning, { status: "running" })),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, idCompleted, { status: "idle", lastOutcome: "success" })),
        )

        const active = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.listActive()))
        const activeIds = active.map((t) => t.actorID)

        expect(activeIds).toContain(idPending)
        expect(activeIds).toContain(idRunning)
        expect(activeIds).not.toContain(idCompleted)
      })
    })

    test("returns empty list when no active tasks", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const active = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.listActive()))
        expect(active).toHaveLength(0)
      })
    })
  })

  describe("orphan recovery", () => {
    test("marks previously pending/running tasks as idle+failure on new layer init", async () => {
      // First, create a task in "running" state
      await using tmp = await tmpdir({ git: true })

      let taskId: SessionID
      let parentId: SessionID

      // First runtime: register and set running
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        parentId = parent.id
        taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Orphan test task",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, taskId, { status: "running" })),
        )

        const before = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(before!.status).toBe("running")
      })

      // Simulate a different process by manually setting a different instance_id
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Database.use((db) =>
            db
              .update(ActorRegistryTable)
              .set({ instance_id: "old-process-id" })
              .where(
                and(
                  eq(ActorRegistryTable.session_id, parentId!),
                  eq(ActorRegistryTable.actor_id, taskId!),
                ),
              )
              .run(),
          )
        },
      })

      // Second runtime (simulates restart): orphan recovery should mark it idle+failure
      await withRegistry(tmp.path, async (rt) => {
        const recovered = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.get(parentId!, taskId!)),
        )
        expect(recovered!.status).toBe("idle")
        expect(recovered!.lastOutcome).toBe("failure")
        expect(recovered!.lastError).toBe("orphaned: process restarted")
      })
    })

    test("does NOT orphan actors registered in the same registry instance", async () => {
      await using tmp = await tmpdir({ git: true })

      // Register an actor and set it to running within the same runtime
      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parent.id,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Current instance task",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parent.id, taskId, { status: "running" })),
        )

        // Actor should still be running — not orphaned
        const actor = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parent.id, taskId)))
        expect(actor!.status).toBe("running")
        expect(actor!.lastOutcome).toBeUndefined()
        expect(actor!.lastError).toBeUndefined()
      })
    })

    test("same-process layer rebuild does NOT orphan running children (singleton instanceID)", async () => {
      await using tmp = await tmpdir({ git: true })
      // Use Instance.provide to share the same directory across multiple layer constructions
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const taskId = SessionID.descending()
          let parentId: SessionID

          // First layer construction: register and set running
          const rt1 = ManagedRuntime.make(testLayer)
          try {
            const parent = await rt1.runPromise(Session.Service.use((svc) => svc.create()))
            parentId = parent.id
            await rt1.runPromise(
              ActorRegistry.Service.use((svc) =>
                svc.register({
                  sessionID: parentId,
                  actorID: taskId,
                  mode: "subagent",
                  agent: "explore",
                  description: "Layer rebuild test task",
                  contextMode: "none",
                  background: false,
                  lifecycle: "ephemeral",
                }),
              ),
            )
            await rt1.runPromise(
              ActorRegistry.Service.use((svc) => svc.updateStatus(parentId, taskId, { status: "running" })),
            )
          } finally {
            await rt1.dispose()
          }

          // Second layer construction (simulates layer rebuild): should NOT orphan
          const rt2 = ManagedRuntime.make(testLayer)
          try {
            const actor = await rt2.runPromise(
              ActorRegistry.Service.use((svc) => svc.get(parentId, taskId)),
            )
            expect(actor!.status).toBe("running")
            expect(actor!.lastOutcome).toBeUndefined()
            expect(actor!.lastError).toBeUndefined()
          } finally {
            await rt2.dispose()
          }
        },
      })
    })

    test("row from a different instanceID IS orphaned", async () => {
      await using tmp = await tmpdir({ git: true })

      // First runtime: register an actor
      let taskId: SessionID
      let parentId: SessionID

      await withRegistry(tmp.path, async (rt) => {
        const parent = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        parentId = parent.id
        taskId = SessionID.descending()
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: parentId,
              actorID: taskId,
              mode: "subagent",
              agent: "explore",
              description: "Different instance test task",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.updateStatus(parentId, taskId, { status: "running" })),
        )

        // Verify it's running
        const before = await rt.runPromise(ActorRegistry.Service.use((svc) => svc.get(parentId, taskId)))
        expect(before!.status).toBe("running")
      })

      // Manually update the instance_id to simulate a different process
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await Database.use((db) =>
            db
              .update(ActorRegistryTable)
              .set({ instance_id: "different-process-id" })
              .where(
                and(
                  eq(ActorRegistryTable.session_id, parentId!),
                  eq(ActorRegistryTable.actor_id, taskId!),
                ),
              )
              .run(),
          )
        },
      })

      // Second runtime: should orphan the row with different instance_id
      await withRegistry(tmp.path, async (rt) => {
        const recovered = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.get(parentId!, taskId!)),
        )
        expect(recovered!.status).toBe("idle")
        expect(recovered!.lastOutcome).toBe("failure")
        expect(recovered!.lastError).toBe("orphaned: process restarted")
      })
    })
  })

  describe("agentTypeFor", () => {
    test("returns 'main' when actorID is 'main'", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.agentTypeFor(session.id, "main")),
        )
        expect(result).toBe("main")
      })
    })

    test("returns the agent type for a registered actor", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "writer-1",
              mode: "subagent",
              agent: "checkpoint-writer",
              description: "test",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.agentTypeFor(session.id, "writer-1")),
        )
        expect(result).toBe("checkpoint-writer")
      })
    })
  })

  describe("isSystemSpawned", () => {
    test("true for checkpoint-writer", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "writer-1",
              mode: "subagent",
              agent: "checkpoint-writer",
              description: "x",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.isSystemSpawned(session.id, "writer-1")),
        )
        expect(result).toBe(true)
      })
    })

    test("false for explorer (model-spawned)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "explorer-1",
              mode: "subagent",
              agent: "explorer",
              description: "x",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.isSystemSpawned(session.id, "explorer-1")),
        )
        expect(result).toBe(false)
      })
    })

    test("false for 'main' actorID", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.isSystemSpawned(session.id, "main")),
        )
        expect(result).toBe(false)
      })
    })
  })

  describe("servesCheckpoint", () => {
    test("true for undefined actorID (main runLoop)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, undefined)),
        )
        expect(result).toBe(true)
      })
    })

    test("true for 'main' actorID", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, "main")),
        )
        expect(result).toBe(true)
      })
    })

    test("true for peer (agentID is child.id, mode peer)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "child-session-1",
              mode: "peer",
              agent: "build",
              description: "x",
              contextMode: "none",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, "child-session-1")),
        )
        expect(result).toBe(true)
      })
    })

    test("false for subagent (explorer) — uses per-actor compaction", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "explorer-1",
              mode: "subagent",
              agent: "explorer",
              description: "x",
              contextMode: "none",
              background: false,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, "explorer-1")),
        )
        expect(result).toBe(false)
      })
    })

    test("false for checkpoint-writer (system-spawned)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "writer-1",
              mode: "subagent",
              agent: "checkpoint-writer",
              description: "x",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, "writer-1")),
        )
        expect(result).toBe(false)
      })
    })

    test("true for unregistered actorID (fail open)", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.servesCheckpoint(session.id, "ghost-9")),
        )
        expect(result).toBe(true)
      })
    })
  })

  describe("allocateActorID", () => {
    test("returns sequential <type>-<n>", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const session = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const first = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.allocateActorID(session.id, "writer")),
        )
        expect(first).toBe("writer-1")
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: session.id,
              actorID: "writer-1",
              mode: "subagent",
              agent: "writer",
              description: "x",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const second = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.allocateActorID(session.id, "writer")),
        )
        expect(second).toBe("writer-2")
        const explorer = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.allocateActorID(session.id, "explorer")),
        )
        expect(explorer).toBe("explorer-1")
      })
    })

    test("is scoped per session", async () => {
      await using tmp = await tmpdir({ git: true })
      await withRegistry(tmp.path, async (rt) => {
        const sessionA = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        const sessionB = await rt.runPromise(Session.Service.use((svc) => svc.create()))
        await rt.runPromise(
          ActorRegistry.Service.use((svc) =>
            svc.register({
              sessionID: sessionA.id,
              actorID: "writer-1",
              mode: "subagent",
              agent: "writer",
              description: "x",
              contextMode: "full",
              background: true,
              lifecycle: "ephemeral",
            }),
          ),
        )
        const result = await rt.runPromise(
          ActorRegistry.Service.use((svc) => svc.allocateActorID(sessionB.id, "writer")),
        )
        expect(result).toBe("writer-1")
      })
    })
  })
})
