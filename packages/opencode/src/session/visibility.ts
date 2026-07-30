/**
 * Which sessions the UI is allowed to display.
 *
 * Product prohibition: an internal-machinery session (checkpoint-writer host,
 * ask-tool fork, workflow subagent host) must NEVER be rendered — not merely
 * omitted from lists. The rule here is not a new classification; it is the
 * composition of the two layers that already hide these sessions:
 *
 *   - `Session.list({ roots: true })` → `isNull(SessionTable.parent_id)`
 *     (session/session.ts:861-862), so no child session is listable.
 *   - `Session.children(parentID, { visible: true })` → keeps only children
 *     that own an ActorRegistry row with `mode === "peer"`
 *     (session/session.ts:519-542).
 *
 * A session is therefore renderable iff it is a root, or it appears among its
 * parent's visible children. Anything else is internal machinery. Keeping the
 * prohibition expressed as those same two predicates means it cannot drift
 * away from what the lists show.
 *
 * Note this deliberately does NOT reuse the roster rule
 * (`actor.mode !== "subagent" && !SYSTEM_SPAWNED_AGENT_TYPES.has(actor.agent)`,
 * tool/session.ts:696, ActorRegistry.servesCheckpoint). That one answers "may
 * the model address this actor?" and fails OPEN when no actor row exists
 * (actor/registry.ts:421-422) — as a render gate it would admit every session
 * whose actor row is missing, which is exactly the population being forbidden.
 */

/** Minimal shape needed to classify — `parentID` is a nullable DB column. */
export interface SessionVisibilityInput {
  readonly id: string
  readonly parentID?: string | null
}

export type RenderVerdict = { readonly renderable: true } | { readonly renderable: false; readonly reason: string }

const RENDERABLE: RenderVerdict = { renderable: true }

/**
 * `visibleSiblings` must be the result of `Session.children(parentID, { visible: true })`.
 * `undefined` means the lookup could not be completed — a prohibition that fails
 * open is not a prohibition, so an unverifiable child is refused.
 */
export function classifySession(
  info: SessionVisibilityInput,
  visibleSiblings: readonly { readonly id: string }[] | undefined,
): RenderVerdict {
  // Roots are what the session list shows; they are always renderable, and
  // user-initiated forks are roots too (Session.fork → createNext, no parentID).
  if (!info.parentID) return RENDERABLE
  if (!visibleSiblings)
    return {
      renderable: false,
      reason: `could not verify that child session ${info.id} is user-facing`,
    }
  if (visibleSiblings.some((sibling) => sibling.id === info.id)) return RENDERABLE
  return {
    renderable: false,
    reason: `${info.id} is an internal session (checkpoint-writer host, ask-tool fork, or workflow subagent host), not a conversation`,
  }
}

/**
 * Same rule, for callers that reach `Session.children` over a transport rather
 * than in-process. `fetchVisibleChildren` should resolve `undefined` on failure.
 */
export async function verifySessionRenderable(
  info: SessionVisibilityInput,
  fetchVisibleChildren: (parentID: string) => Promise<readonly { readonly id: string }[] | undefined>,
): Promise<RenderVerdict> {
  if (!info.parentID) return RENDERABLE
  const siblings = await fetchVisibleChildren(info.parentID).catch(() => undefined)
  return classifySession(info, siblings)
}
