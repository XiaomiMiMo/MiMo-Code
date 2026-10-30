import { Context, Effect, Layer, Schema, Option } from "effect"
import { Database, and, eq, lte, inArray, isNotNull, isNull } from "@/storage"
import * as InboxSync from "./sync"
import { ActorRegistry } from "@/actor/registry"
import { Session } from "@/session"
import { MessageID, PartID } from "@/session/schema"
import type { SessionID } from "@/session/schema"
import { InboxTable } from "./inbox.sql"
import { renderInboxRow } from "./render"
import { inboxServiceRef, defaultModelRef } from "./inbox-ref"
import * as Controller from "./controller"
import type { AdmissionGuard } from "./controller"
import type { ProviderID, ModelID } from "@/provider/schema"
import { Instance } from "@/project/instance"
import * as Project from "@/project/project"
import { SessionTable } from "@/session/session.sql"
import { InstanceRef, WorkspaceRef } from "@/effect/instance-ref"
import { WorkspaceContext } from "@/control-plane/workspace-context"
import { bindScopedRef } from "@/effect/scoped-ref"

const GC_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function gcInboxRows(cutoffMs: number) {
  return Effect.sync(() =>
    Database.use((db) => db.delete(InboxTable).where(and(
      inArray(InboxTable.state, ["settled", "cancelled", "rejected"]),
      lte(InboxTable.time_updated, cutoffMs),
    )).run()),
  )
}

export class InboxReceiverNotFound extends Schema.TaggedErrorClass<InboxReceiverNotFound>()(
  "InboxReceiverNotFound",
  { receiverSessionID: Schema.String, receiverActorID: Schema.String },
) {}

export interface DrainSeed {
  agent: string
  model: { providerID: ProviderID; modelID: ModelID; variant?: string }
}

export function resolveDrainSeed(
  sessions: Session.Interface,
  reg: ActorRegistry.Interface,
  sessionID: SessionID,
  actorID: string,
): Effect.Effect<DrainSeed | undefined> {
  return Effect.gen(function* () {
    const actor = yield* reg.get(sessionID, actorID)
    const match = yield* sessions.findMessage(
      sessionID,
      (m) =>
        (m.info.role === "user" || m.info.role === "assistant") &&
        "model" in m.info &&
        m.info.model !== undefined &&
        m.info.model.providerID !== "system" &&
        "agent" in m.info &&
        m.info.agent !== "system",
      { agentID: actor?.mode === "peer" ? "*" : actorID },
    )
    if (Option.isSome(match)) {
      const info = match.value.info
      if ("model" in info && info.model && "agent" in info) return { agent: info.agent, model: info.model }
    }
    const resolver = defaultModelRef.current
    if (actor?.mode === "peer" && resolver) {
      const model = yield* resolver.defaultModel()
      return { agent: actor.agent, model: { providerID: model.providerID, modelID: model.modelID } }
    }
    return undefined
  })
}

export interface AgentInput {
  receiverSessionID: SessionID
  receiverActorID: string
  senderSessionID?: SessionID
  senderActorID?: string
  content: string
  type?: string
  legacyInboxID?: string
  /** Stable event identity, scoped to the receiving session by the controller. */
  idempotencyKey?: string
  /** Marks a message as external input instead of an ordinary user instruction. */
  externalOrigin?: { server: string; event: string; eventId: string }
}

export interface Interface {
  readonly accept: (input: AgentInput, guard?: AdmissionGuard) => Effect.Effect<{
    inboxID: string
    inputMessageID: MessageID
  }, InboxReceiverNotFound>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Inbox") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const reg = yield* ActorRegistry.Service
    const sessions = yield* Session.Service
    const controller = yield* Controller.Service
    yield* gcInboxRows(Date.now() - GC_TTL_MS)

    const accept = Effect.fn("Inbox.acceptAgent")(function* (input: AgentInput, guard?: AdmissionGuard) {
      const receiver = yield* reg.get(input.receiverSessionID, input.receiverActorID)
      if (!receiver && !input.legacyInboxID) return yield* Effect.fail(new InboxReceiverNotFound({
        receiverSessionID: input.receiverSessionID,
        receiverActorID: input.receiverActorID,
      }))
      const seed = yield* resolveDrainSeed(sessions, reg, input.receiverSessionID, input.receiverActorID)
      const id = MessageID.ascending()
      const now = Date.now()
      const type = input.type ?? "text"
      const text = renderInboxRow({
        type,
        content: { text: input.content },
        sender_session_id: input.senderSessionID,
        sender_actor_id: input.senderActorID,
        created_at: now,
      })
      if (!text.trim()) return yield* Effect.die(new Error("Inbox input rendered empty"))
      const receipt = yield* controller.accept({
        lane: { sessionID: input.receiverSessionID, agentID: input.receiverActorID },
        message: {
          id,
          sessionID: input.receiverSessionID,
          agentID: input.receiverActorID,
          role: "user",
          time: { created: now },
          agent: seed?.agent ?? "system",
          ...(input.externalOrigin ? { provenance: { machine: `mcp-events:${input.externalOrigin.server}` } }
            : input.senderSessionID || input.senderActorID ? { provenance: {
              source: "agent" as const,
              senderSessionID: input.senderSessionID, senderActorID: input.senderActorID,
            } } : {}),
          model: seed?.model ?? { providerID: "system" as ProviderID, modelID: "system" as ModelID },
        },
        parts: [{
          id: PartID.ascending(),
          messageID: id,
          sessionID: input.receiverSessionID,
          type: "text",
          synthetic: true,
          text,
          ...(input.externalOrigin ? { metadata: { origin: { kind: "mcp-event", ...input.externalOrigin } } } : {}),
        }],
        type,
        idempotencyKey: input.idempotencyKey,
        legacyInboxID: input.legacyInboxID,
        senderSessionID: input.senderSessionID,
        senderActorID: input.senderActorID,
      }, guard)
      return { inboxID: receipt.id, inputMessageID: receipt.inputMessageID }
    })
    const legacy = yield* Effect.sync(() => Database.use((db) => db.select().from(InboxTable).where(and(
      isNotNull(InboxTable.content), isNull(InboxTable.input_message_id), eq(InboxTable.state, "accepted"),
    )).orderBy(InboxTable.id).all()))
    for (const row of legacy) {
      const session = yield* sessions.get(row.receiver_session_id)
      const project = Project.get(session.projectID)
      if (!project) return yield* Effect.die(new Error(`Inbox project missing: ${session.projectID}`))
      const instance = { directory: session.directory, worktree: project.worktree, project }
      const workspace = Database.use((db) => db.select().from(SessionTable)
        .where(eq(SessionTable.id, session.id)).get())!.workspace_id ?? undefined
      const convert = !row.content?.text?.trim() || !renderInboxRow(row).trim()
        ? Effect.sync(() => Database.transaction((db) => {
          const rejected = db.update(InboxTable).set({ state: "rejected", content: null, time_updated: Date.now() })
            .where(and(eq(InboxTable.id, row.id), isNull(InboxTable.input_message_id), eq(InboxTable.state, "accepted")))
            .returning().all()
          InboxSync.record({ sessionID: row.receiver_session_id, receipts: rejected })
        }))
        : accept({
          receiverSessionID: row.receiver_session_id,
          receiverActorID: row.receiver_actor_id,
          senderSessionID: row.sender_session_id ?? undefined,
          senderActorID: row.sender_actor_id ?? undefined,
          content: row.content!.text ?? "",
          type: row.type,
          legacyInboxID: row.id,
        }).pipe(Effect.asVoid)
      yield* Effect.promise(() => WorkspaceContext.provide({ workspaceID: workspace, fn: () =>
        Instance.restore(instance, () => Effect.runPromise(convert.pipe(
          Effect.provideService(InstanceRef, instance), Effect.provideService(WorkspaceRef, workspace),
        ))),
      }))
    }
    const impl = Service.of({ accept })
    yield* bindScopedRef(inboxServiceRef, impl)
    return impl
  }),
).pipe(Layer.provide(Controller.defaultLayer))

export const defaultLayer = layer.pipe(
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
