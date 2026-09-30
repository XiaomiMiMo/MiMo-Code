import { afterEach, describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { MAX_DRAIN_PER_TURN } from "../../src/inbox/inbox"
import { defaultModelRef } from "../../src/inbox/inbox-ref"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)
const testLayer = Inbox.layer.pipe(Layer.provide(base), Layer.provideMerge(base))

afterEach(async () => {
  defaultModelRef.current = undefined
  await Instance.disposeAll()
})

type RT = ManagedRuntime.ManagedRuntime<Inbox.Service | Session.Service | ActorRegistry.Service | Bus.Service, never>

async function withInbox(directory: string, fn: (rt: RT) => Promise<void>) {
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

/** Seed a "real" user message so drain's lastReal predicate resolves. */
async function seedRealMessage(rt: RT, sessionID: SessionID, actorID: string) {
  return rt.runPromise(
    Session.Service.use((sessions) =>
      sessions.updateMessage({
        id: MessageID.ascending(),
        role: "user" as const,
        sessionID,
        agentID: actorID,
        time: { created: Date.now() },
        agent: "general",
        model: {
          providerID: ProviderID.make("test"),
          modelID: ModelID.make("test-model"),
        },
      }),
    ),
  )
}

describe("Inbox.drain in loop (Plan 2 / Task 7)", () => {
  test("empty inbox returns 0 and writes no message", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-1",
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

      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-1")),
      )
      expect(count).toBe(0)
    })
  })

  test("drain defers when no real message in slice yet", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-2",
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

      // Send a message without seeding a real message — drain should defer (return 0)
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "actor-2",
            content: "hello",
          }),
        ),
      )

      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-2")),
      )
      expect(count).toBe(0)
    })
  })

  test("3 sends → drain returns 3 after seeding real message", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-3",
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

      await seedRealMessage(rt, session.id, "actor-3")

      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          Effect.all([
            inbox.send({ receiverSessionID: session.id, receiverActorID: "actor-3", content: "msg-1" }),
            inbox.send({ receiverSessionID: session.id, receiverActorID: "actor-3", content: "msg-2" }),
            inbox.send({ receiverSessionID: session.id, receiverActorID: "actor-3", content: "msg-3" }),
          ]),
        ),
      )

      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-3")),
      )
      expect(count).toBe(3)

      // Spec requirement: drain must write 1 user message with exactly N synthetic text parts
      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "actor-3" })),
      )
      const lastUser = msgs.findLast((m) => m.info.role === "user")
      const syntheticTextParts = lastUser?.parts.filter((p) => p.type === "text" && p.synthetic) ?? []
      expect(syntheticTextParts.length).toBe(3)

      // Second drain: inbox is now empty
      const count2 = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-3")),
      )
      expect(count2).toBe(0)
    })
  })

  test("tier-1 seed: idle standing peer inherits agent+model from a prior CROSS-SLICE message (no Provider layer)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      // Register the peer whose OWN slice (agentID === its actor id) has NO
      // messages — the "peer ran a turn under a different slice, then went idle"
      // case. The prior model-bearing message lives on the "main" slice.
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "peer-idle",
            mode: "peer",
            parentActorID: undefined,
            agent: "build",
            description: "standing peer",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "persistent",
          }),
        ),
      )
      // Seed a real model-bearing message on a DIFFERENT slice ("main").
      await seedRealMessage(rt, session.id, "main")

      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({ receiverSessionID: session.id, receiverActorID: "peer-idle", content: "relayed task" }),
        ),
      )

      // drain must now SEED from the cross-slice message and process the row —
      // NOT return 0. No Provider layer is present, proving tier 1 needs none.
      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "peer-idle")),
      )
      expect(count).toBe(1)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "peer-idle" })),
      )
      const lastUser = msgs.findLast((m) => m.info.role === "user")
      expect(lastUser).toBeDefined()
      const info1 = lastUser!.info
      if (info1.role !== "user") throw new Error("expected a user message")
      // Inherited agent + model from the cross-slice real message.
      expect(info1.agent).toBe("general")
      expect(String(info1.model.modelID)).toBe("test-model")
    })
  })

  test("tier-2 seed: turnCount-0 peer seeds agent from registry + model from the default-model ref", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "peer-t0",
            mode: "peer",
            parentActorID: undefined,
            agent: "compose",
            description: "turnCount-0 peer",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "persistent",
          }),
        ),
      )
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({ receiverSessionID: session.id, receiverActorID: "peer-t0", content: "queued" }),
        ),
      )

      // Wire the already-resolved default-model value (as SessionPrompt.layer
      // would in production). No Provider LAYER is pulled — the ref is a plain
      // resolver over a stored value.
      defaultModelRef.current = {
        defaultModel: () =>
          Effect.succeed({ providerID: ProviderID.make("test"), modelID: ModelID.make("default-model") }),
      }

      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "peer-t0")),
      )
      expect(count).toBe(1)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "peer-t0" })),
      )
      const lastUser = msgs.findLast((m) => m.info.role === "user")
      expect(lastUser).toBeDefined()
      const info2 = lastUser!.info
      if (info2.role !== "user") throw new Error("expected a user message")
      // Agent from the REGISTRY row; model from the default-model ref.
      expect(info2.agent).toBe("compose")
      expect(String(info2.model.modelID)).toBe("default-model")
    })
  })

  test("tier-3: with no prior message AND no default-model ref, drain leaves rows durable (returns 0, no regression)", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "peer-fresh",
            mode: "peer",
            parentActorID: undefined,
            agent: "build",
            description: "turnCount-0 peer",
            contextMode: "none",
            contextWatermark: undefined,
            background: true,
            lifecycle: "persistent",
          }),
        ),
      )
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({ receiverSessionID: session.id, receiverActorID: "peer-fresh", content: "queued" }),
        ),
      )

      // No cross-slice message (tier 1 miss) and no defaultModelRef wired in this
      // minimal fixture (tier 2 unavailable) → tier 3: keep durable, return 0.
      const count = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "peer-fresh")),
      )
      expect(count).toBe(0)

      // The row is STILL in the inbox (durable) — a later drain with a model
      // source will consume it. Prove by seeding a message and draining again.
      await seedRealMessage(rt, session.id, "main")
      const count2 = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "peer-fresh")),
      )
      expect(count2).toBe(1)
    })
  })

  test(`MAX_DRAIN_PER_TURN cap: first drain returns ${MAX_DRAIN_PER_TURN}, second returns 5`, async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-cap",
            mode: "subagent",
            parentActorID: undefined,
            agent: "general",
            description: "cap test",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )

      await seedRealMessage(rt, session.id, "actor-cap")

      const total = MAX_DRAIN_PER_TURN + 5
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          Effect.all(
            Array.from({ length: total }, (_, i) =>
              inbox.send({
                receiverSessionID: session.id,
                receiverActorID: "actor-cap",
                content: `msg-${i}`,
              }),
            ),
          ),
        ),
      )

      const first = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-cap")),
      )
      expect(first).toBe(MAX_DRAIN_PER_TURN)

      // Reseed real message so drain can process the remainder
      await seedRealMessage(rt, session.id, "actor-cap")

      const second = await rt.runPromise(
        Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-cap")),
      )
      expect(second).toBe(5)
    })
  })
})
