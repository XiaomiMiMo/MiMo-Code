import { SYSTEM_SPAWNED_AGENT_TYPES } from "@/agent/config"
import { Log } from "@/util"

const log = Log.create({ service: "session.visibility" })

/**
 * Which sessions the UI is allowed to display.
 *
 * Product prohibition: a session that exists only to host a RUNTIME-spawned
 * agent must never be rendered — not merely omitted from lists. The scope is
 * narrow on purpose: only the runtime-spawned writer / dream / distill hosts are
 * clearly not conversations, and everything else a user can reach should render.
 * The prohibition exists because navigation was landing inside a writer host.
 *
 * ## Exactly three code paths create a child session
 *
 * Enumerated by grepping every `create({ parentID })` in src/ (non-test):
 *
 *   1. `actor/spawn.ts:674` — a PEER child (`session create`, `mode: "peer"`,
 *      `session_id === actor_id === child.id`). A real conversation the
 *      subagent dialog already shows. Renderable.
 *   2. `tool/session.ts:128` — the `session ask` fork-query host (`forkQuery`,
 *      title `ask: <question>`, `mode: "subagent"`, and `agentType` is the
 *      TARGET's own last-assistant agent, so `build` / `compose` / `general`).
 *      MODEL-spawned and read-only. Renderable — if a compose or workflow run
 *      goes wrong, its side-question transcript is exactly what you want.
 *   3. `session/checkpoint.ts:851` — the checkpoint-writer host, spawned with
 *      `agentType: "checkpoint-writer"` (`checkpoint.ts:878`). RUNTIME-spawned
 *      bookkeeping. The one population this file exists to refuse.
 *
 * ⚠️"workflow subagent sessions" is NOT a fourth path: a workflow's `agent()`
 * calls `actor.spawn({ mode: "subagent", sessionID: input.sessionID })`
 * (`workflow/runtime.ts:814-816`, `:945-948`) — it registers an actor under the
 * workflow's OWN session and creates no child session at all. An earlier
 * revision of this comment (and of `Session.children`'s) named it as a hidden
 * session category; it never was one.
 *
 * ## The criterion: the agent-type set, not `mode !== "peer"`
 *
 * `SYSTEM_SPAWNED_AGENT_TYPES` (`agent/config.ts`) already means "spawned by the
 * runtime, NOT by the model", and is already the discriminator for the same kind
 * of decision elsewhere — permission routing (`agent/agent.ts`: a system agent
 * auto-denies because there is no human to answer) and the
 * prune/bootstrap/memory/recall scan skips.
 *
 * The predicate this file used to carry — *renderable iff root, or present among
 * the parent's `visible: true` children* — was a PROXY for "internal machinery",
 * because `visible: true` resolves to `ActorRegistry.mode === "peer"`
 * (`session/session.ts` `children()`). Measured on the live DB the proxy
 * over-blocked by 28 sessions: it refused all 11 `ask:` forks and all 17
 * legacy no-actor-row `@explore`/`@general` subagent transcripts, none of which
 * is machinery.
 *
 * ## Fail OPEN, and why the live DB settles it
 *
 * Keying on an agent-type set inverts the old fail-closed default: a session
 * with no actor row is not in the set, so it renders. That is the intended
 * answer, not an accident:
 *
 *   - All 17 child sessions in the live DB with NO actor row are pre-registry
 *     (Jan–Feb 2026) `@explore` / `@general` mention subagents. 17/17 hold
 *     their messages under `main`; 0/17 has a non-main bucket, i.e. not one of
 *     them is an actor-hosted machinery session. Fail-closed refused all 17.
 *   - A checkpoint-writer host cannot present as "no actor row" once it has
 *     anything to leak: `spawnSubagent` registers the row (`actor/spawn.ts:731`)
 *     BEFORE it forks the work that writes the first message (`:762`), and the
 *     row is `ON DELETE CASCADE` on the session, so it cannot be outlived.
 *     1302/1302 writer hosts in the live DB carry their row. The residual race
 *     window — created, not yet registered — has zero messages, so fail-open's
 *     worst case there is an EMPTY pane, not a leaked machinery transcript.
 *
 * A prohibition that fails open is still a prohibition when the population it
 * targets provably cannot arrive un-annotated; over-refusing real transcripts is
 * the more expensive error, and it is the one the user actually hit.
 *
 * ## "Unreadable" is NOT "absent" — only the first of the two fails open
 *
 * The argument above is about rows that are genuinely ABSENT, and it rests on a
 * measured population: all 17 no-row children are real transcripts. It does not
 * transfer to rows that EXIST but could not be READ. That is a different
 * population — every child is a candidate, and of the 1504 children in the live
 * DB 1304 carry a system-spawned row — so a read failure that fell through to
 * the fail-open arm would render a checkpoint-writer host in roughly six cases
 * out of seven. A filter may fail open; a GATE must fail closed, and this is a
 * gate.
 *
 * So `classifySession` never learns about read failures: `undefined` means "this
 * session has no rows" and nothing else. A failed read goes to
 * `classifyUnreadableActors` instead, which refuses with a DISTINCT reason
 * ("could not verify") so an operator can tell a broken read from the product
 * prohibition, and logs the session id and the cause — the swallowed
 * `catch(() => undefined)` this replaced reported a state it had not verified
 * and left no trace of having failed.
 *
 * Failing closed costs a legitimate session that is briefly unopenable, which is
 * the OTHER error this file was narrowed to avoid. Two things bound that cost:
 * the refusal is only reached after one retry, which is what a single dropped
 * request costs; and a root never reaches it at all, because a root's verdict
 * does not depend on its rows, so an unreadable read cannot change it.
 */

/** Minimal shape needed to classify — `parentID` is a nullable DB column. */
export interface SessionVisibilityInput {
  readonly id: string
  readonly parentID?: string | null
}

/** The two `ActorRegistry` fields the verdict reads. */
export interface SessionActorInput {
  readonly mode: string
  readonly agent: string
}

export type RenderVerdict = { readonly renderable: true } | { readonly renderable: false; readonly reason: string }

const RENDERABLE: RenderVerdict = { renderable: true }

/**
 * `actors` must be the session's OWN `ActorRegistry` rows
 * (`ActorRegistry.listBySession` / `GET /session/:id/actors`) — the rows keyed by
 * `session_id === info.id`. `undefined` means the session HAS no rows, which is
 * renderable: see the fail-open note above. A read that FAILED must never be
 * passed here as `undefined`; route it to `classifyUnreadableActors`, which is
 * the whole point of keeping the two states apart.
 */
export function classifySession(
  info: SessionVisibilityInput,
  actors: readonly SessionActorInput[] | undefined,
): RenderVerdict {
  // Roots are what the session list shows, and user-initiated forks are roots
  // too (Session.fork → createNext, no parentID). Checked first and not merely
  // as an optimisation: one real root in the live DB carries a
  // `checkpoint-writer` actor row, because before the writer got its own child
  // session it registered under the session it was checkpointing. Reading the
  // agent set without this guard would refuse that user's own conversation.
  if (!info.parentID) return RENDERABLE
  // A peer child is a conversation by construction (spawn.ts registers
  // session_id === actor_id === child.id), and it is what the subagent dialog
  // lists. Checked before the agent set for the same reason as the root guard:
  // whatever a peer child happened to RUN must not decide what it IS. Because the
  // default below is renderable, this arm only changes an outcome for a peer that
  // ALSO carries a system-spawned row — narrow, but that is precisely the overlap
  // the one writer-carrying root in the live DB exhibits, one level up.
  if (actors?.some((actor) => actor.mode === "peer")) return RENDERABLE
  const system = actors?.find((actor) => SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent))
  if (system)
    return {
      renderable: false,
      reason: `${info.id} hosts the runtime-spawned ${system.agent} agent, not a conversation`,
    }
  return RENDERABLE
}

/**
 * The verdict for a session whose own actor rows could not be READ, as opposed to
 * a session that genuinely has none. Fails closed for a child, and logs the
 * session id with the underlying cause so the failure is never silent.
 *
 * A root stays renderable: `classifySession` decides a root without looking at
 * its rows at all, so an unreadable read cannot change its verdict, and routing
 * roots through here keeps the two enforcement points from disagreeing — the
 * transport wrapper below returns before it ever fetches, while the session
 * tool's `switch` reads rows unconditionally and so does reach this function.
 *
 * The reason deliberately says "could not verify" and never names an agent: the
 * user-visible string has to distinguish a broken read from the prohibition.
 */
export function classifyUnreadableActors(info: SessionVisibilityInput, cause: unknown): RenderVerdict {
  if (!info.parentID) return RENDERABLE
  log.error("actor rows unreadable, refusing to render", { sessionID: info.id, cause })
  return {
    renderable: false,
    reason: `could not verify whether ${info.id} is a conversation: reading its actor rows failed`,
  }
}

/**
 * Same rule, for callers that reach the actor registry over a transport rather
 * than in-process. `fetchActors` MUST REJECT when the read fails — a client that
 * resolves `{ data: undefined }` on an HTTP error arrives here as "no rows" and
 * fails open, so the caller passes `throwOnError`.
 */
export async function verifySessionRenderable(
  info: SessionVisibilityInput,
  fetchActors: (sessionID: string) => Promise<readonly SessionActorInput[] | undefined>,
): Promise<RenderVerdict> {
  if (!info.parentID) return RENDERABLE
  // One retry, then refuse. A single dropped request is the common failure and is
  // not worth making a real transcript unopenable; a failure that survives a
  // second attempt is not transient. Bounded on purpose — a gate that retries
  // until it succeeds is a gate that never closes.
  let cause: unknown
  for (let attempt = 0; attempt < 2; attempt++) {
    try {
      return classifySession(info, await fetchActors(info.id))
    } catch (error) {
      cause = error
    }
  }
  return classifyUnreadableActors(info, cause)
}
