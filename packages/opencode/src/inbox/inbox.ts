import { Context, Effect, Layer, Scope, Schema, Option } from "effect"
import { ulid } from "ulid"
import { Database, eq, and, lte, inArray } from "@/storage"
import { Bus } from "@/bus"
import { ActorRegistry } from "@/actor/registry"
import { Session } from "@/session"
import { MessageID, PartID } from "@/session/schema"
import { InboxArrived } from "@/actor/events"
import type { SessionID } from "@/session/schema"
import { Log } from "@/util"
import { InboxTable } from "./inbox.sql"
import { renderInboxRow } from "./render"
import { sessionPromptRef, inboxServiceRef, defaultModelRef } from "./inbox-ref"
import type { ProviderID, ModelID } from "@/provider/schema"

const log = Log.create({ service: "inbox" })

const GC_TTL_MS = 7 * 24 * 60 * 60 * 1000
export const MAX_DRAIN_PER_TURN = 100

/** Delete inbox rows whose created_at is at or before cutoffMs. Unit-testable without layer reset. */
export function gcInboxRows(cutoffMs: number) {
  return Effect.sync(() =>
    Database.use((db) => db.delete(InboxTable).where(lte(InboxTable.created_at, cutoffMs)).run()),
  )
}

export class InboxReceiverNotFound extends Schema.TaggedErrorClass<InboxReceiverNotFound>()(
  "InboxReceiverNotFound",
  {
    receiverSessionID: Schema.String,
    receiverActorID: Schema.String,
  },
) {}

export interface DrainSeed {
  agent: string
  model: { providerID: ProviderID; modelID: ModelID; variant?: string }
}

/**
 * Resolve the {agent, model} a drained synthetic user message should carry,
 * via a layered cheapest-first fallback. Exported for unit testing.
 *
 *  1. A prior real (non-system) model-bearing message. Inherits that message's
 *     agent+model. No Provider dependency. The SEARCH SCOPE depends on the
 *     receiver's mode: a standing `peer` (its actor id === its session id, runs
 *     its own child session) may have run a turn under a DIFFERENT slice then
 *     gone idle, so it searches cross-slice (agentID "*") — the idle-standing-
 *     peer relay case. Every other receiver (an ordinary subagent slice, or a
 *     session's host/"main" actor that merely COORDINATES other actors — e.g. a
 *     WorkflowRuntime parent whose subagents run under its session) searches
 *     ONLY its own slice, so a completion/notification delivered to the host
 *     never fabricates a turn off an unrelated subagent's message. Restoring the
 *     pre-relay slice scope for non-peers fixes the WorkflowRuntime regression
 *     where the parent "main" drained a child's actor_notification into a real
 *     LLM turn (stealing a queued response from the next agent()).
 *  2. A true turnCount-0 / empty-slice peer: agent from the actor-registry row
 *     (recorded at spawn), model from the project default resolver reachable via
 *     `defaultModelRef` (an already-wired value — no fresh provider layer). If
 *     the ref is unavailable (minimal fixtures), this tier is skipped.
 *  3. Neither → `undefined`; caller keeps the rows durable and logs.
 */
export function resolveDrainSeed(
  sessions: Session.Interface,
  reg: ActorRegistry.Interface,
  sessionID: SessionID,
  actorID: string,
): Effect.Effect<DrainSeed | undefined> {
  return Effect.gen(function* () {
    // Receiver's registry row decides the Tier 1 search scope + feeds Tier 2.
    const actor = yield* reg.get(sessionID, actorID)
    // Tier 1: a prior real model-bearing message. Cross-slice ONLY for a standing
    // peer; slice-scoped for every other receiver (subagent / coordinating host).
    const crossSlice = actor?.mode === "peer"
    const match = yield* sessions.findMessage(
      sessionID,
      (m) =>
        (m.info.role === "user" || m.info.role === "assistant") &&
        "model" in m.info &&
        m.info.model !== undefined &&
        m.info.model.providerID !== "system" &&
        "agent" in m.info &&
        m.info.agent !== "system",
      { agentID: crossSlice ? "*" : actorID },
    )
    if (Option.isSome(match)) {
      const info = match.value.info
      if ("model" in info && info.model && "agent" in info) {
        return { agent: info.agent, model: info.model }
      }
    }

    // Tier 2: turnCount-0 / empty slice. Agent from the registry row (recorded
    // at spawn); model from the already-wired default resolver.
    const resolver = defaultModelRef.current
    if (actor && resolver) {
      const model = yield* resolver.defaultModel()
      return { agent: actor.agent, model: { providerID: model.providerID, modelID: model.modelID } }
    }

    // Tier 3: nothing to seed from.
    return undefined
  })
}

export interface SendInput {
  receiverSessionID: SessionID
  receiverActorID: string
  senderSessionID?: SessionID
  senderActorID?: string
  content: string
  type?: string
}

export interface SendResult {
  inboxID: string
}

export interface Interface {
  readonly send: (input: SendInput) => Effect.Effect<SendResult, InboxReceiverNotFound>
  readonly drain: (sessionID: SessionID, actorID: string) => Effect.Effect<number>
}

export class Service extends Context.Service<Service, Interface>()("@opencode/Inbox") {}

export const layer: Layer.Layer<
  Service,
  never,
  Bus.Service | ActorRegistry.Service | Session.Service
> = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const reg = yield* ActorRegistry.Service
    const sessions = yield* Session.Service
    const scope = yield* Scope.Scope

    // 7-day GC at init. Idempotent: deletes any rows older than now-7d.
    yield* gcInboxRows(Date.now() - GC_TTL_MS)
    log.info("inbox gc-on-init complete")

    const send = Effect.fn("Inbox.send")(function* (input: SendInput) {
      // ESRCH check (B3). receiver row must exist.
      const receiver = yield* reg.get(input.receiverSessionID, input.receiverActorID)
      if (!receiver) {
        return yield* Effect.fail(
          new InboxReceiverNotFound({
            receiverSessionID: input.receiverSessionID,
            receiverActorID: input.receiverActorID,
          }),
        )
      }

      const row = {
        id: ulid(),
        receiver_session_id: input.receiverSessionID,
        receiver_actor_id: input.receiverActorID,
        sender_session_id: input.senderSessionID ?? null,
        sender_actor_id: input.senderActorID ?? null,
        type: input.type ?? "text",
        content: { text: input.content },
        created_at: Date.now(),
      }
      yield* Effect.sync(() => Database.use((db) => db.insert(InboxTable).values(row).run()))
      yield* bus.publish(InboxArrived, {
        receiverSessionID: input.receiverSessionID,
        receiverActorID: input.receiverActorID,
        ...(input.senderSessionID !== undefined ? { senderSessionID: input.senderSessionID } : {}),
        ...(input.senderActorID !== undefined ? { senderActorID: input.senderActorID } : {}),
        inboxID: row.id,
        type: row.type,
      })

      // Fork-and-forget wake (B2). Sender returns after fork is scheduled;
      // wake fiber lives in the service scope, so sender lifecycle does
      // not affect delivery.
      const promptRef = sessionPromptRef.current
      if (promptRef) {
        yield* promptRef
          .loop({
            sessionID: input.receiverSessionID,
            agentID: input.receiverActorID,
            // Woken turns notify their parent on completion. The spawn turn goes
            // through SessionPrompt.prompt (no flag) so forkWork.notify remains
            // the sole notifier for turn 1 — no double-notify.
            notifyParentOnComplete: true,
          })
          .pipe(Effect.ignore, Effect.forkIn(scope))
      } else {
        // Test fixtures / renderer-only paths can run without SessionPrompt.
        // Row is durable; will be drained on next runLoop iteration.
        log.warn("inbox.send: sessionPromptRef.current undefined — wake skipped", {
          receiverActorID: input.receiverActorID,
        })
      }

      return { inboxID: row.id }
    })

    const drain = Effect.fn("Inbox.drain")(function* (
      sessionID: SessionID,
      actorID: string,
    ) {
      // Cheap indexed SELECT first — if inbox is empty, bail immediately.
      // Common case: every iteration discovers nothing to drain.
      const rows = yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .select()
            .from(InboxTable)
            .where(
              and(
                eq(InboxTable.receiver_session_id, sessionID),
                eq(InboxTable.receiver_actor_id, actorID),
              ),
            )
            .orderBy(InboxTable.id)
            .limit(MAX_DRAIN_PER_TURN)
            .all(),
        ),
      )
      if (rows.length === 0) return 0

      // Resolve the {agent, model} the synthetic user message will carry, via a
      // LAYERED fallback (cheapest-first) so a woken idle/standing peer always
      // drains instead of no-op'ing when it has no prior real turn:
      //
      //   1. Any prior real (non-system) message in the session — searched
      //      cross-slice (agentID "*") so a peer that ran a turn under any slice,
      //      then went idle, still inherits that turn's agent+model. No extra
      //      dependency; this covers the common "idle standing peer" case.
      //   2. A true turnCount-0 / empty-slice peer: seed the agent from the
      //      actor-registry row (recorded at spawn) and the model from the
      //      project default resolver (already-wired ref — no fresh provider
      //      layer in the hot path). This reuses the same default the normal
      //      loop uses; it does NOT invent a new provider call.
      //   3. If BOTH yield nothing, do NOT drop the queued task: leave the rows
      //      durable and log, so a later turn that does have a model consumes
      //      them (no regression vs. the previous return-0 behavior).
      const seed = yield* resolveDrainSeed(sessions, reg, sessionID, actorID)
      if (!seed) {
        log.warn("inbox.drain: no model source (no prior model-bearing message, registry row, or default-model ref) — leaving rows durable", {
          sessionID,
          actorID,
          pending: rows.length,
        })
        return 0
      }

      // Non-transactional crash window: updateMessage + updatePart commit
      // before the inbox DELETE. A crash between them re-renders the same
      // rows on next drain — LLM sees duplicated notifications. Tolerable;
      // a transactional fix would require threading tx through
      // sessions.updateMessage/updatePart, which crosses three abstraction
      // layers.
      const msgID = MessageID.ascending()
      const now = Date.now()
      yield* sessions.updateMessage({
        id: msgID,
        role: "user" as const,
        sessionID,
        agentID: actorID,
        time: { created: now },
        agent: seed.agent,
        model: seed.model,
      })
      for (const row of rows) {
        yield* sessions.updatePart({
          id: PartID.ascending(),
          messageID: msgID,
          sessionID,
          type: "text" as const,
          synthetic: true,
          text: renderInboxRow(row),
        })
      }
      yield* Effect.sync(() =>
        Database.use((db) =>
          db
            .delete(InboxTable)
            .where(inArray(InboxTable.id, rows.map((r) => r.id)))
            .run(),
        ),
      )

      return rows.length
    })

    const impl = Service.of({ send, drain })
    inboxServiceRef.current = impl
    yield* Effect.addFinalizer(() =>
      Effect.sync(() => {
        if (inboxServiceRef.current === impl) inboxServiceRef.current = undefined
      }),
    )
    return impl
  }),
)

export const defaultLayer = layer.pipe(
  Layer.provide(Bus.defaultLayer),
  Layer.provide(ActorRegistry.defaultLayer),
  Layer.provide(Session.defaultLayer),
)
