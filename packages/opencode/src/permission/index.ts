import { Bus } from "@/bus"
import { BusEvent } from "@/bus/bus-event"
import { ConfigPermission } from "@/config/permission"
import { InstanceState } from "@/effect"
import { ProjectID } from "@/project/schema"
import { MessageID, SessionID } from "@/session/schema"
import { PermissionTable } from "@/session/session.sql"
import { Database, eq } from "@/storage"
import { zod } from "@/util/effect-zod"
import { Log } from "@/util"
import { withStatics } from "@/util/schema"
import { Wildcard } from "@/util"
import { Deferred, Effect, Layer, Schema, Context } from "effect"
import os from "os"
import { evaluate as evalRule } from "./evaluate"
import { PermissionID } from "./schema"
import { forwardRef } from "./permission-forward-ref"
import { inboxServiceRef } from "@/inbox/inbox-ref"
import { TuiEvent } from "@/cli/cmd/tui/event"

// A forwarded ask (orchestrator peer) that no one ever approves resolves DENY
// after this bound rather than hanging — preserving the hang-safety the old
// interactive:false gate guaranteed. Aligned with the actor registry stuck bound.
const FORWARD_DENY_TIMEOUT_MS = 5 * 60 * 1000
// In skip-all mode, forced-ask permissions (bash_delete etc.) still require a
// human — but the human is likely away. Bounded wait, then auto-reject with
// model-actionable feedback instead of hanging the unattended run.
// Read lazily so tests (and unusual deployments) can override via env.
const skipAllForcedAskTimeoutMs = () => Number(process.env.MIMOCODE_SKIP_ALL_FORCED_ASK_TIMEOUT_MS) || 60 * 1000

const log = Log.create({ service: "permission" })

export const Action = Schema.Literals(["allow", "deny", "ask"])
  .annotate({ identifier: "PermissionAction" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Action = Schema.Schema.Type<typeof Action>

export class Rule extends Schema.Class<Rule>("PermissionRule")({
  permission: Schema.String,
  pattern: Schema.String,
  action: Action,
}) {
  static readonly zod = zod(this)
}

export const Ruleset = Schema.mutable(Schema.Array(Rule))
  .annotate({ identifier: "PermissionRuleset" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Ruleset = Schema.Schema.Type<typeof Ruleset>

export class Request extends Schema.Class<Request>("PermissionRequest")({
  id: PermissionID,
  sessionID: SessionID,
  permission: Schema.String,
  patterns: Schema.Array(Schema.String),
  metadata: Schema.Record(Schema.String, Schema.Unknown),
  always: Schema.Array(Schema.String),
  tool: Schema.optional(
    Schema.Struct({
      messageID: MessageID,
      callID: Schema.String,
    }),
  ),
}) {
  static readonly zod = zod(this)
}

export const Reply = Schema.Literals(["once", "always", "reject"]).pipe(withStatics((s) => ({ zod: zod(s) })))
export type Reply = Schema.Schema.Type<typeof Reply>

const reply = {
  reply: Reply,
  message: Schema.optional(Schema.String),
}

export const ReplyBody = Schema.Struct(reply)
  .annotate({ identifier: "PermissionReplyBody" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyBody = Schema.Schema.Type<typeof ReplyBody>

export class Approval extends Schema.Class<Approval>("PermissionApproval")({
  projectID: ProjectID,
  patterns: Schema.Array(Schema.String),
}) {
  static readonly zod = zod(this)
}

export const Event = {
  Asked: BusEvent.define("permission.asked", Request.zod),
  Replied: BusEvent.define(
    "permission.replied",
    zod(
      Schema.Struct({
        sessionID: SessionID,
        requestID: PermissionID,
        reply: Reply,
      }),
    ),
  ),
}

export class RejectedError extends Schema.TaggedErrorClass<RejectedError>()("PermissionRejectedError", {}) {
  override get message() {
    return "The user rejected permission to use this specific tool call."
  }
}

export class CorrectedError extends Schema.TaggedErrorClass<CorrectedError>()("PermissionCorrectedError", {
  feedback: Schema.String,
}) {
  override get message() {
    return `The user rejected permission to use this specific tool call with the following feedback: ${this.feedback}`
  }
}

export class DeniedError extends Schema.TaggedErrorClass<DeniedError>()("PermissionDeniedError", {
  ruleset: Schema.Any,
}) {
  override get message() {
    return `The user has specified a rule which prevents you from using this specific tool call. Here are some of the relevant rules ${JSON.stringify(this.ruleset)}`
  }
}

export type Error = DeniedError | RejectedError | CorrectedError

export const AskInput = Schema.Struct({
  ...Request.fields,
  id: Schema.optional(PermissionID),
  ruleset: Ruleset,
  // When false, an ask that would otherwise block on human reply instead fails
  // immediately with DeniedError. Set by callers spawning non-interactive agents
  // (SYSTEM_SPAWNED_AGENT_TYPES) which have no attached human to reply. Default
  // (undefined/true) preserves all existing interactive behavior.
  interactive: Schema.optional(Schema.Boolean),
  // Orchestrator-peer forward mode. When present, an ask that would block is
  // FORWARDED for approval instead of auto-denied: the orchestrator may
  // pre-authorize it via a delegation grant (keyed by parentSessionID), else it
  // waits (bounded) for a human/orchestrator reply. Internal to the ask call —
  // NOT persisted on the Request schema.
  forward: Schema.optional(Schema.Struct({ parentSessionID: Schema.String })),
  // Parent-grant inheritance for ordinary (non-peer) background subagents. When
  // present, an ask that would block is NOT auto-denied outright: it is first
  // checked against the PARENT session's approved ruleset (published process-
  // wide via forwardRef.parentGrants). If the parent already holds a matching
  // grant for every pattern, the child is auto-allowed with no human round-trip;
  // otherwise it fails closed (DeniedError) — never hangs, never blocks on a
  // human. Distinct from `forward` (orchestrator-peer human/delegation routing).
  inherit: Schema.optional(Schema.Struct({ parentSessionID: Schema.String })),
})
  .annotate({ identifier: "PermissionAskInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type AskInput = Schema.Schema.Type<typeof AskInput>

export const ReplyInput = Schema.Struct({
  requestID: PermissionID,
  ...reply,
})
  .annotate({ identifier: "PermissionReplyInput" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type ReplyInput = Schema.Schema.Type<typeof ReplyInput>

export interface Interface {
  readonly ask: (input: AskInput, abortSignal?: AbortSignal) => Effect.Effect<void, Error>
  readonly reply: (input: ReplyInput) => Effect.Effect<void>
  readonly list: () => Effect.Effect<ReadonlyArray<Request>>
  readonly skipAll: () => Effect.Effect<boolean>
  readonly setSkipAll: (enabled: boolean) => Effect.Effect<void>
}

interface PendingEntry {
  info: Request
  deferred: Deferred.Deferred<void, RejectedError | CorrectedError>
}

interface State {
  pending: Map<PermissionID, PendingEntry>
  approved: Ruleset
  // When true, any ask that would block for human approval is auto-allowed
  // instead. Explicit "deny" rules still win (they return before this check).
  // Runtime-only, instance-scoped: subagents in the same project inherit it.
  skipAll: boolean
}

export function evaluate(permission: string, pattern: string, ...rulesets: Ruleset[]): Rule {
  return evalRule(permission, pattern, ...rulesets)
}

// Permissions whose "allow" outcome must ALWAYS come from an explicit human ask.
// A wildcard rule like `permissions.allow: ["*"]` (or a stored `{permission:"*",
// pattern:"*", action:"allow"}` approval) MUST NOT be able to pre-authorize
// these — the whole point of a forced-ask permission is that the intent to
// perform an irreversible action must be recorded in-band, not inherited from
// a broad blanket rule. Explicit deny still wins; the tool-side env opt-out
// (e.g. MIMOCODE_AUTO_APPROVE_DELETE for bash_delete) is the only bypass.
const FORCED_ASK = new Set(["bash_delete"])

export class Service extends Context.Service<Service, Interface>()("@opencode/Permission") {}

export const layer = Layer.effect(
  Service,
  Effect.gen(function* () {
    const bus = yield* Bus.Service
    const state = yield* InstanceState.make<State>(
      Effect.fn("Permission.state")(function* (ctx) {
        const row = Database.use((db) =>
          db.select().from(PermissionTable).where(eq(PermissionTable.project_id, ctx.project.id)).get(),
        )
        const state = {
          pending: new Map<PermissionID, PendingEntry>(),
          approved: row?.data ?? [],
          skipAll: false,
        }

        yield* Effect.addFinalizer(() =>
          Effect.gen(function* () {
            for (const item of state.pending.values()) {
              yield* Deferred.fail(item.deferred, new RejectedError())
            }
            state.pending.clear()
          }),
        )

        return state
      }),
    )

    const ask = Effect.fn("Permission.ask")(function* (input: AskInput, abortSignal?: AbortSignal) {
      const s = yield* InstanceState.get(state)
      const { approved, pending } = s
      const { ruleset, ...request } = input
      let needsAsk = false

      // Publish this session's effective grant snapshot so background children
      // in another Instance can inherit it. Kept as two ordered phases (ruleset,
      // then session-accumulated approvals) — NOT flattened — so the child can
      // mirror the two-phase evaluation below: a ruleset deny wins outright, and
      // only a non-denying ruleset lets an approved allow upgrade an ask.
      forwardRef.setParentGrants(request.sessionID, { ruleset, approved })

      const forced = FORCED_ASK.has(request.permission)

      for (const pattern of request.patterns) {
        // Evaluate the ruleset ALONE first. An explicit deny here must win
        // outright — a persisted approval (e.g. an edit approved "always" in
        // build mode) must NOT be able to out-rank it. Only once the ruleset
        // itself does not deny do we let approvals upgrade an "ask" to "allow".
        const ruleAction = evaluate(request.permission, pattern, ruleset).action
        if (ruleAction === "deny") {
          return yield* new DeniedError({
            ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
          })
        }
        // Forced-ask permissions skip both allow short-circuits: neither the
        // ruleset nor the persisted approvals can pre-authorize them. They
        // always land in the human ask flow below (unless denied above).
        if (forced) {
          needsAsk = true
          continue
        }
        if (ruleAction === "allow") continue
        if (evaluate(request.permission, pattern, approved).action === "allow") continue
        needsAsk = true
      }

      // Runtime skip-all: auto-allow anything that would block for approval.
      // Ordered AFTER the deny loop (explicit deny still wins) and EXCLUDES
      // forced-ask permissions (bash_delete etc.) — same containment as a
      // wildcard allow rule, which forced-ask is designed to resist.
      if (needsAsk && s.skipAll && !forced) {
        log.info("skip-all active, auto-allowing", { permission: request.permission, patterns: request.patterns })
        return
      }

      // Parent-grant inheritance: an ordinary background subagent reuses the
      // permissions its parent already holds. Consult the parent session's
      // published grant snapshot; auto-allow ONLY when the parent already grants
      // every requested pattern (same evaluate() the parent would run). Ordered
      // AFTER the deny loop (explicit deny still wins) and forced-ask still falls
      // through to the fail-closed/human path below. A path the parent doesn't
      // hold isn't matched → we do NOT return here → it fails closed at the
      // non-interactive gate. No human wait, no hang.
      if (needsAsk && input.inherit && !forced) {
        const parentSnapshot = forwardRef.getParentGrants(input.inherit.parentSessionID)
        if (parentSnapshot) {
          // Mirror the parent's own two-phase evaluation (see the deny loop
          // above). A parent ruleset deny must win outright — an approved allow
          // must NOT be able to out-rank it — so evaluate the ruleset ALONE for
          // deny first, and only for a non-denying ruleset let approvals upgrade
          // to allow. Never flatten ruleset+approved into one findLast pass:
          // that would let a trailing approved allow beat a ruleset deny and let
          // the child escape a permission the parent itself would refuse.
          const allAllowed = request.patterns.every((pattern) => {
            if (evaluate(request.permission, pattern, parentSnapshot.ruleset).action === "deny") return false
            return (
              evaluate(request.permission, pattern, parentSnapshot.ruleset, parentSnapshot.approved).action === "allow"
            )
          })
          if (allAllowed) {
            log.info("inheriting parent grant, auto-allowing", {
              permission: request.permission,
              patterns: request.patterns,
              parentSessionID: input.inherit.parentSessionID,
            })
            return
          }
        }
      }

      // Non-interactive caller (system-spawned background agent): no human is
      // attached to reply, so an ask that would block instead fails clean with
      // the same DeniedError an explicit "deny" rule produces. Emits no
      // Event.Asked and creates no Deferred → provably cannot hang.
      if (needsAsk && input.interactive === false) {
        return yield* new DeniedError({
          ruleset: ruleset.filter((rule) => Wildcard.match(request.permission, rule.permission)),
        })
      }

      if (!needsAsk) return

      const id = request.id ?? PermissionID.ascending()
      const info = Schema.decodeUnknownSync(Request)({
        id,
        ...request,
      })
      log.info("asking", { id, permission: info.permission, patterns: info.patterns })

      const deferred = yield* Deferred.make<void, RejectedError | CorrectedError>()
      pending.set(id, { info, deferred })
      yield* bus.publish(Event.Asked, info)

      // Orchestrator-peer forward mode: either the orchestrator holds a delegation
      // grant for this child (pre-authorized → resolve allow immediately, no human
      // round-trip), or record the pending forward so `session approve` can find
      // it and race a bounded deny-timeout below.
      if (input.forward) {
        const parentSessionID = input.forward.parentSessionID
        if (forwardRef.grantAllowed(parentSessionID, info.sessionID)) {
          yield* Deferred.succeed(deferred, void 0)
        } else {
          // Store a resolver bound to THIS ask's Deferred (in this child's
          // Instance) so `session approve` can resolve it from the orchestrator's
          // Instance. allow → succeed; deny → fail(RejectedError). Resolving an
          // already-settled Deferred is a no-op (idempotent with a direct reply).
          forwardRef.addPending(String(id), {
            childSessionID: info.sessionID,
            parentSessionID,
            resolve: (decision) =>
              Effect.runFork(
                decision === "allow"
                  ? Deferred.succeed(deferred, void 0)
                  : Deferred.fail(deferred, new RejectedError()),
              ),
          })
          // Wake the orchestrator (inbox note to its main actor) so it learns a
          // child needs approval, and toast the user (child may be unfocused).
          // Best-effort: never fail the ask on a notify hiccup.
          const inbox = inboxServiceRef.current
          if (inbox) {
            yield* inbox
              .send({
                receiverSessionID: parentSessionID as SessionID,
                receiverActorID: "main",
                senderSessionID: info.sessionID,
                content: `<permission-request child="${info.sessionID}" requestID="${id}">Child session ${info.sessionID} needs approval to use "${info.permission}". Use \`session approve ${info.sessionID}\` to allow it once, or \`session grant-approval ${info.sessionID}\` (or \`all\`) to auto-approve future asks.</permission-request>`,
              })
              .pipe(Effect.ignore)
          }
          yield* Effect.promise(() =>
            Bus.publish(TuiEvent.ToastShow, {
              message: `Child session needs approval to use "${info.permission}"`,
              variant: "warning",
            }),
          ).pipe(Effect.ignore)
        }
      }

      // Spec ③ P3: race against caller's abortSignal so a stranded ask
      // doesn't block forever when the surrounding scope is interrupted.
      // NOTE: Effect.callback (not Effect.promise) — when Deferred.await
      // wins the race, Effect.race interrupts the callback and runs the
      // cleanup returned from the body, which removes the addEventListener.
      // Effect.promise has no such hook: listener leaks for the lifetime
      // of the AbortSignal + unhandled-rejection when the eventual abort
      // tries to reject the already-dead Promise.
      const deferredAwait = Deferred.await(deferred)
      const main = abortSignal
        ? Effect.race(
            deferredAwait,
            Effect.callback<never, RejectedError>((resume) => {
              const onAbort = () => {
                Effect.runPromise(Deferred.fail(deferred, new RejectedError())).catch(() => {})
                resume(Effect.fail(new RejectedError()))
              }
              if (abortSignal.aborted) {
                onAbort()
                return
              }
              abortSignal.addEventListener("abort", onAbort, { once: true })
              return Effect.sync(() => {
                abortSignal.removeEventListener("abort", onAbort)
              })
            }),
          )
        : deferredAwait

      // A forwarded ask that no approver resolves must still terminate (deny),
      // never hang. Race the bounded timeout; the grant path above already
      // resolved the Deferred, so it wins instantly when pre-authorized.
      let guarded = input.forward
        ? Effect.race(
            main,
            Effect.sleep(`${FORWARD_DENY_TIMEOUT_MS} millis`).pipe(
              Effect.andThen(() => Deferred.fail(deferred, new RejectedError())),
              Effect.andThen(() => Effect.fail(new RejectedError())),
            ),
          )
        : main

      // Skip-all mode: the user opted into unattended execution, so a forced-ask
      // (the only ask that still blocks here) must not hang the run forever.
      // Bound it with a timeout; CorrectedError (not RejectedError) so the
      // processor does NOT set ctx.blocked — the model sees an error result with
      // actionable feedback and the session loop continues to the next step.
      // NOTE: Effect.race with a permanently-blocked Deferred hangs under the
      // current Effect v4 beta, so use Effect.timeoutOrElse instead.
      if (s.skipAll && forced) {
        const timeoutMs = skipAllForcedAskTimeoutMs()
        guarded = Effect.timeoutOrElse(guarded, {
          duration: `${timeoutMs} millis`,
          orElse: () =>
            bus
              .publish(Event.Replied, {
                sessionID: info.sessionID,
                requestID: info.id,
                reply: "reject",
              })
              .pipe(
                Effect.andThen(() =>
                  Effect.fail(
                    new CorrectedError({
                      feedback: `No user response within ${Math.round(timeoutMs / 1000)}s (skip-permissions mode is on, user likely away). This destructive action was auto-rejected as a safety measure — NOT an explicit user denial. Skip this operation and continue with the rest of the task; leave the cleanup/deletion for the user to do manually.`,
                    }),
                  ),
                ),
              ),
        })
      }

      return yield* Effect.ensuring(
        guarded,
        Effect.sync(() => {
          pending.delete(id)
          forwardRef.removePending(String(id))
        }),
      )
    })

    const reply = Effect.fn("Permission.reply")(function* (input: ReplyInput) {
      const { approved, pending } = yield* InstanceState.get(state)
      const existing = pending.get(input.requestID)
      if (!existing) return

      pending.delete(input.requestID)
      yield* bus.publish(Event.Replied, {
        sessionID: existing.info.sessionID,
        requestID: existing.info.id,
        reply: input.reply,
      })

      if (input.reply === "reject") {
        yield* Deferred.fail(
          existing.deferred,
          input.message ? new CorrectedError({ feedback: input.message }) : new RejectedError(),
        )

        for (const [id, item] of pending.entries()) {
          if (item.info.sessionID !== existing.info.sessionID) continue
          pending.delete(id)
          yield* bus.publish(Event.Replied, {
            sessionID: item.info.sessionID,
            requestID: item.info.id,
            reply: "reject",
          })
          yield* Deferred.fail(item.deferred, new RejectedError())
        }
        return
      }

      yield* Deferred.succeed(existing.deferred, undefined)
      if (input.reply === "once") return
      // Forced-ask permissions never persist an approval — even if the caller
      // (or a future permission type) accidentally passes a non-empty `always`
      // list, the promise of "human must confirm every time" trumps it.
      // Treating "always" as "once" for these keeps the UI reply path a no-op
      // instead of writing a rule that ask() would just ignore next call.
      if (FORCED_ASK.has(existing.info.permission)) return

      for (const pattern of existing.info.always) {
        approved.push({
          permission: existing.info.permission,
          pattern,
          action: "allow",
        })
      }
      // Refresh the parent snapshot so a background child inherits this
      // just-approved grant on its next ask. The parent's `ruleset` isn't known
      // here, so preserve whatever ruleset phase ask() last published and update
      // only the approved phase (the live `approved` array already holds the
      // just-pushed patterns). Keeping the phases separate preserves deny
      // precedence for the child (a ruleset deny still can't be out-ranked).
      forwardRef.setParentGrants(existing.info.sessionID, {
        ruleset: forwardRef.getParentGrants(existing.info.sessionID)?.ruleset ?? [],
        approved,
      })

      for (const [id, item] of pending.entries()) {
        if (item.info.sessionID !== existing.info.sessionID) continue
        const ok = item.info.patterns.every(
          (pattern) => evaluate(item.info.permission, pattern, approved).action === "allow",
        )
        if (!ok) continue
        pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "always",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    const list = Effect.fn("Permission.list")(function* () {
      const pending = (yield* InstanceState.get(state)).pending
      return Array.from(pending.values(), (item) => item.info)
    })

    const skipAll = Effect.fn("Permission.skipAll")(function* () {
      return (yield* InstanceState.get(state)).skipAll
    })

    const setSkipAll = Effect.fn("Permission.setSkipAll")(function* (enabled: boolean) {
      const s = yield* InstanceState.get(state)
      s.skipAll = enabled
      log.info("skip-all set", { enabled })
      // Flush already-blocked asks so enabling mid-wait unblocks them (forced-ask
      // pendings stay: they must always be answered by a human).
      if (!enabled) return
      for (const [id, item] of s.pending.entries()) {
        if (FORCED_ASK.has(item.info.permission)) continue
        s.pending.delete(id)
        yield* bus.publish(Event.Replied, {
          sessionID: item.info.sessionID,
          requestID: item.info.id,
          reply: "once",
        })
        yield* Deferred.succeed(item.deferred, undefined)
      }
    })

    return Service.of({ ask, reply, list, skipAll, setSkipAll })
  }),
)

function expand(pattern: string): string {
  if (pattern.startsWith("~/")) return os.homedir() + pattern.slice(1)
  if (pattern === "~") return os.homedir()
  if (pattern.startsWith("$HOME/")) return os.homedir() + pattern.slice(5)
  if (pattern.startsWith("$HOME")) return os.homedir() + pattern.slice(5)
  return pattern
}

export function fromConfig(permission: ConfigPermission.Info) {
  const ruleset: Ruleset = []
  for (const [key, value] of Object.entries(permission)) {
    if (typeof value === "string") {
      ruleset.push({ permission: key, action: value, pattern: "*" })
      continue
    }
    ruleset.push(
      ...Object.entries(value).map(([pattern, action]) => ({ permission: key, pattern: expand(pattern), action })),
    )
  }
  return ruleset
}

export function merge(...rulesets: Ruleset[]): Ruleset {
  return rulesets.flat()
}

const EDIT_TOOLS = ["edit", "write", "apply_patch", "multiedit"]

export function disabled(tools: string[], ruleset: Ruleset): Set<string> {
  const result = new Set<string>()
  for (const tool of tools) {
    // Match rules by the tool's own name, AND — for EDIT_TOOLS — also by
    // the "edit" group alias. findLast returns the last-merged matching
    // rule, so a tool-specific rule placed after a group rule wins
    // naturally. This preserves the convenience of `edit: "deny"` covering
    // all edit-family tools while letting an explicit `write: "allow"` or
    // `write: "deny"` take precedence when present.
    const rule = ruleset.findLast(
      (r) =>
        Wildcard.match(tool, r.permission) ||
        (EDIT_TOOLS.includes(tool) && Wildcard.match("edit", r.permission)),
    )
    if (!rule) continue
    if (rule.pattern === "*" && rule.action === "deny") result.add(tool)
  }
  return result
}

export const defaultLayer = layer.pipe(Layer.provide(Bus.layer))

export * as Permission from "."
