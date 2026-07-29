import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { renderInboxRow } from "../../src/inbox/render"
import type { InboxRow } from "../../src/inbox/inbox.sql"
import { defaultModelRef } from "../../src/inbox/inbox-ref"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

// The inbox drain is the ONE user-message producer that does not go through
// SessionPrompt.createUserMessage, so `hasSubstantiveContent` never inspects
// it. A blank `actor_notification` body would therefore be persisted verbatim
// as a user message whose only part is {type:"text",text:""} — and ai@6's
// `convertToLanguageModelMessage` user branch filters empty text parts out with
// NO backfill, so that message would reach the provider as `content: []` and be
// rejected with `messages.<N>: user messages must have non-empty content`.
//
// No caller can supply such a body today (see
// empty-notification-reachability.test.ts — the actor tool's shell route IS
// re-validated against `content: z.string().min(1)`), so this closes a latent
// defence gap. These tests pin the structural invariant that keeps the shape
// unreachable regardless of what any future row type renders: the drain never
// persists a blank text part, for any row content.

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
        model: { providerID: ProviderID.make("test"), modelID: ModelID.make("test-model") },
      }),
    ),
  )
}

async function registerActor(rt: RT, sessionID: SessionID, actorID: string) {
  return rt.runPromise(
    ActorRegistry.Service.use((reg) =>
      reg.register({
        sessionID,
        actorID,
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
}

function row(overrides: Partial<InboxRow>): InboxRow {
  return {
    id: "01JTESTROW",
    receiver_session_id: SessionID.make("ses_receiver"),
    receiver_actor_id: "main",
    sender_session_id: SessionID.make("ses_sender"),
    sender_actor_id: "explore-1",
    type: "text",
    content: { text: "hello" },
    created_at: 1_700_000_000_000,
    ...overrides,
  } as InboxRow
}

describe("renderInboxRow never returns a blank string", () => {
  // `content.text ?? placeholder` only catches null/undefined. An empty body is
  // stored as "" and, for actor_notification, passed through RAW.
  test("actor_notification with an empty body falls back to the placeholder", () => {
    const rendered = renderInboxRow(row({ type: "actor_notification", content: { text: "" } }))
    expect(rendered).toBe("(no notification body)")
    expect(rendered.trim().length).toBeGreaterThan(0)
  })

  test("actor_notification with a whitespace-only body falls back to the placeholder", () => {
    expect(renderInboxRow(row({ type: "actor_notification", content: { text: "   \n\t " } }))).toBe(
      "(no notification body)",
    )
  })

  test("actor_notification with a missing body still falls back", () => {
    expect(renderInboxRow(row({ type: "actor_notification", content: {} }))).toBe("(no notification body)")
  })

  test("actor_notification with a real body is passed through verbatim", () => {
    const body = "<actor-notification>\nchild completed.\n</actor-notification>"
    expect(renderInboxRow(row({ type: "actor_notification", content: { text: body } }))).toBe(body)
  })

  test("a text row with an empty body renders the (empty) placeholder inside the wrapper", () => {
    const rendered = renderInboxRow(row({ type: "text", content: { text: "" } }))
    expect(rendered).toContain("(empty)")
    expect(rendered.trim().length).toBeGreaterThan(0)
  })
})

describe("Inbox.drain never persists an empty user text part", () => {
  test("a blank actor_notification body yields a non-blank synthetic part", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await registerActor(rt, session.id, "actor-empty")
      await seedRealMessage(rt, session.id, "actor-empty")

      // This is the reachable producer: a blank body reaches the inbox (the
      // `actor` tool's JSON path guards it with .min(1), but the shell path did
      // not, and inbox.send itself does not validate).
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "actor-empty",
            type: "actor_notification",
            content: "",
          }),
        ),
      )

      const count = await rt.runPromise(Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-empty")))
      // The notification is NOT lost — it is rendered with a placeholder.
      expect(count).toBe(1)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "actor-empty" })),
      )
      const synthetic = msgs
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.synthetic)

      expect(synthetic.length).toBe(1)
      // THE INVARIANT: no persisted user text part may be empty or blank.
      for (const part of synthetic) {
        expect(part.type === "text" && part.text).not.toBe("")
        expect(part.type === "text" && part.text.trim().length).toBeGreaterThan(0)
      }
    })
  })

  test("a blank body mixed with a real one keeps both parts non-blank", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await registerActor(rt, session.id, "actor-mixed")
      await seedRealMessage(rt, session.id, "actor-mixed")

      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "actor-mixed",
            type: "actor_notification",
            content: "",
          }),
        ),
      )
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "actor-mixed",
            type: "actor_notification",
            content: "<actor-notification>\nreal body\n</actor-notification>",
          }),
        ),
      )

      const count = await rt.runPromise(Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-mixed")))
      expect(count).toBe(2)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "actor-mixed" })),
      )
      const texts = msgs
        .filter((m) => m.info.role === "user")
        .flatMap((m) => m.parts)
        .filter((p) => p.type === "text" && p.synthetic)
        .map((p) => (p.type === "text" ? p.text : ""))

      expect(texts.length).toBe(2)
      expect(texts.every((t) => t.trim().length > 0)).toBe(true)
      expect(texts).toContain("(no notification body)")
    })
  })
})
