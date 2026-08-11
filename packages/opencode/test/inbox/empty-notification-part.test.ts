import { afterEach, describe, expect, test } from "bun:test"
import { Layer, ManagedRuntime } from "effect"
import { Inbox } from "../../src/inbox"
import { renderInboxRow } from "../../src/inbox/render"
import { defaultModelRef } from "../../src/inbox/inbox-ref"
import type { InboxRow } from "../../src/inbox/inbox.sql"
import { ActorRegistry } from "../../src/actor/registry"
import { Session } from "../../src/session"
import { Bus } from "../../src/bus"
import { Instance } from "../../src/project/instance"
import { MessageID, SessionID } from "../../src/session/schema"
import { ProviderID, ModelID } from "../../src/provider/schema"
import { tmpdir } from "../fixture/fixture"

// Latent defence gap in the inbox render/drain path (NOT an observed producer —
// see empty-notification-reachability.test.ts: the actor tool's shell route is
// re-validated against `content: z.string().min(1)`, so no caller could supply a
// blank body).
//
// Inbox.drain writes ONE synthetic `role:"user"` message and then one text part
// per queued row, with `text: renderInboxRow(row)` persisted verbatim —
// bypassing createUserMessage/hasSubstantiveContent entirely. renderInboxRow
// used `content.text ?? "(no notification body)"`, and `??` does not catch `""`,
// so a body-less `actor_notification` row would render to exactly `""`. With a
// single queued row that yields `parts: [{type:"text",text:""}]` — length 1, so
// every `parts.length === 0` guard misses it — which `ai`'s
// convertToLanguageModelMessage then filters to `content: []`, the shape a
// provider rejects with "user messages must have non-empty content".
//
// See test/session/message-v2.test.ts for the SDK-boundary half of the proof.

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

function row(type: string, text: string | undefined): InboxRow {
  return {
    id: "01AAA",
    receiver_session_id: "ses_x",
    receiver_actor_id: "main",
    sender_session_id: "ses_y",
    sender_actor_id: "general-1",
    type,
    content: text === undefined ? {} : { text },
    created_at: 0,
  } as unknown as InboxRow
}

describe("inbox render never yields an empty part text", () => {
  test("a body-less actor_notification renders the placeholder, not an empty string", () => {
    expect(renderInboxRow(row("actor_notification", ""))).toBe("(no notification body)")
    expect(renderInboxRow(row("actor_notification", undefined))).toBe("(no notification body)")
  })

  test("a body-less text row renders a non-empty wrapper", () => {
    expect(renderInboxRow(row("text", ""))).toContain("(empty)")
    expect(renderInboxRow(row("text", undefined))).toContain("(empty)")
  })

  test("every row type/body combination renders non-empty", () => {
    for (const type of ["actor_notification", "text", "unknown-future-type"]) {
      for (const text of ["", undefined, "  ", "real body"]) {
        expect(renderInboxRow(row(type, text)).length).toBeGreaterThan(0)
      }
    }
  })
})

describe("Inbox.drain never persists an empty user text part", () => {
  test("draining a body-less actor_notification writes a non-empty synthetic part", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-empty",
            mode: "subagent",
            parentActorID: undefined,
            agent: "general",
            description: "empty-body notification",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await seedRealMessage(rt, session.id, "actor-empty")

      // Constructed, not reachable through the actor tool: the shell route IS
      // re-validated against `content: z.string().min(1)` (see
      // empty-notification-reachability.test.ts). This calls Inbox.send directly
      // to pin what the layers BELOW the entry point do with a blank body, so the
      // render/drain invariants are proven independently of any caller's guard.
      await rt.runPromise(
        Inbox.Service.use((inbox) =>
          inbox.send({
            receiverSessionID: session.id,
            receiverActorID: "actor-empty",
            content: "",
            type: "actor_notification",
          }),
        ),
      )

      expect(await rt.runPromise(Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-empty")))).toBe(1)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "actor-empty" })),
      )
      const drained = msgs.findLast((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.synthetic))
      expect(drained).toBeDefined()
      const textParts = drained!.parts.filter((p) => p.type === "text")
      expect(textParts.length).toBe(1)
      // The whole point: this part must not be "" — a length-1 parts array whose
      // only text is empty is the shape that reaches a provider as `content: []`.
      expect(textParts[0].type === "text" && textParts[0].text).toBe("(no notification body)")
      expect(drained!.parts.every((p) => p.type !== "text" || p.text !== "")).toBe(true)
    })
  })

  test("a mixed drain (empty + real bodies) leaves no empty text part behind", async () => {
    await using tmp = await tmpdir({ git: true })
    await withInbox(tmp.path, async (rt) => {
      const session = await rt.runPromise(Session.Service.use((s) => s.create()))
      await rt.runPromise(
        ActorRegistry.Service.use((reg) =>
          reg.register({
            sessionID: session.id,
            actorID: "actor-mixed",
            mode: "subagent",
            parentActorID: undefined,
            agent: "general",
            description: "mixed bodies",
            contextMode: "none",
            contextWatermark: undefined,
            background: false,
            lifecycle: "ephemeral",
          }),
        ),
      )
      await seedRealMessage(rt, session.id, "actor-mixed")

      for (const body of ["", "a real notification", ""]) {
        await rt.runPromise(
          Inbox.Service.use((inbox) =>
            inbox.send({
              receiverSessionID: session.id,
              receiverActorID: "actor-mixed",
              content: body,
              type: "actor_notification",
            }),
          ),
        )
      }

      expect(await rt.runPromise(Inbox.Service.use((inbox) => inbox.drain(session.id, "actor-mixed")))).toBe(3)

      const msgs = await rt.runPromise(
        Session.Service.use((sessions) => sessions.messages({ sessionID: session.id, agentID: "actor-mixed" })),
      )
      const drained = msgs.findLast((m) => m.info.role === "user" && m.parts.some((p) => p.type === "text" && p.synthetic))
      expect(drained!.parts.filter((p) => p.type === "text").length).toBe(3)
      expect(drained!.parts.every((p) => p.type !== "text" || p.text !== "")).toBe(true)
    })
  })
})
