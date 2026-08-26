import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { sessionPromptRef } from "../../src/inbox/inbox-ref"
import { WAKE_ATTEMPTS } from "../../src/inbox/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import { Database, eq, and } from "../../src/storage"
import { MessageV2 } from "../../src/session/message-v2"

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)
const testLayer = Inbox.layer.pipe(Layer.provide(base), Layer.provideMerge(base))

afterEach(async () => {
  await Instance.disposeAll()
})

async function withInbox(
  directory: string,
  fn: (rt: ManagedRuntime.ManagedRuntime<Inbox.Service | Session.Service | ActorRegistry.Service | Bus.Service, never>) => Promise<void>,
) {
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

describe("Inbox.send wake matrix (Plan 2 / Task 7)", () => {
  // Case 1: Missing receiver row → InboxReceiverNotFound (ESRCH)
  test("send to unregistered actor fails with InboxReceiverNotFound", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))

      const result = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox
            .send({
              receiverSessionID: session.id,
              receiverActorID: "nonexistent-actor",
              content: "should fail",
            })
            .pipe(
              Effect.map(() => ({ caught: false as const, tag: null as string | null })),
              Effect.catchTag("InboxReceiverNotFound", (e) =>
                Effect.succeed({ caught: true as const, tag: e._tag as string | null }),
              ),
            ),
        ),
      )

      expect(result.caught).toBe(true)
      expect(result.tag).toBe("InboxReceiverNotFound")
    })
  })

  // Case 2: send to idle receiver with lastOutcome: "cancelled" still wakes (B3 axiom)
  test("idle receiver with lastOutcome=cancelled still receives message", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "cancelled-actor",
            mode: "subagent",
            parentActorID: undefined,
            agent: "general",
            description: "test",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )

      // Set actor to idle + cancelled
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(session.id, "cancelled-actor", {
            status: "idle",
            lastOutcome: "cancelled",
          }),
        ),
      )

      // send should still succeed — B3 axiom: no ESRCH for idle/cancelled
      const result = await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "cancelled-actor",
            content: "wake after cancel",
          }),
        ),
      )

      expect(result.inboxID).toBeDefined()
      expect(typeof result.inboxID).toBe("string")
      expect(result.inboxID.length).toBe(26)
    })
  })

  // Case 3: error fields are passed through in InboxReceiverNotFound
  test("InboxReceiverNotFound carries receiverActorID and receiverSessionID", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))

      const result = (await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox
            .send({
              receiverSessionID: session.id,
              receiverActorID: "ghost",
              content: "lost",
            })
            .pipe(
              Effect.catchTag("InboxReceiverNotFound", (e) =>
                Effect.succeed({
                  actorID: e.receiverActorID,
                  sessionID: e.receiverSessionID,
                }),
              ),
            ),
        ),
      )) as { actorID: string; sessionID: string }

      expect(result.actorID).toBe("ghost")
      expect(result.sessionID).toBe(session.id)
    })
  })

  // The wake is allowed to be a no-op: SessionRunState.ensureRunning hands back a
  // busy runner's Deferred WITHOUT executing the turn we asked for, which happens
  // when the registry already reads `idle` but the receiver's Runner has not yet
  // flipped to Idle. A single-shot wake would leave the row queued forever and any
  // `wait` on it blocking to its timeout, so send drives further turns while the
  // row survives. Stubbing the loop ref is what makes "the turn did not run"
  // reproducible — the real window is inside one fiber's uninterruptible tail.
  test("wake retries while the row survives a turn that did not consume it", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "explore-1",
            mode: "subagent",
            parentActorID: undefined,
            agent: "explore",
            description: "test",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.updateStatus(session.id, "explore-1", { status: "idle", lastOutcome: "success" }),
        ),
      )

      let calls = 0
      const previous = sessionPromptRef.current
      // First call models the swallowed turn (nothing drains); the second behaves
      // like a real turn and consumes the row.
      sessionPromptRef.current = {
        loop: () =>
          Effect.sync(() => {
            calls += 1
            if (calls >= 2) {
              Database.use((db) =>
                db
                  .delete(InboxTable)
                  .where(
                    and(
                      eq(InboxTable.receiver_session_id, session.id),
                      eq(InboxTable.receiver_actor_id, "explore-1"),
                    ),
                  )
                  .run(),
              )
            }
            return undefined as unknown as MessageV2.WithParts
          }),
      }
      try {
        await rt.runPromise(
          Inbox.Service.use((inbox) =>
            inbox.send({
              receiverSessionID: session.id,
              receiverActorID: "explore-1",
              content: "follow-up",
            }),
          ),
        )
        // The wake fiber is detached; give it room to run both attempts.
        await new Promise((r) => setTimeout(r, 300))
        expect(calls).toBe(2)
        expect(calls).toBeLessThanOrEqual(WAKE_ATTEMPTS)
      } finally {
        sessionPromptRef.current = previous
      }
    })
  })
})
