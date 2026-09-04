import type { Info } from "./agent"

/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

/** Whether the `actor` tool is in an agent's schema: subagents don't get it,
 *  because they must not spawn further subagents, and neither does an agent whose
 *  toolAllowlist omits it (dream/distill). Read by ToolRegistry.available (which
 *  applies the mask) and by prompt surfaces that would otherwise name the tool, so
 *  the schema and the prose can't drift apart. Accepts undefined because
 *  `Agent.Service.get` is typed `Info` but returns `agents[name]`, which is absent
 *  for a name no longer in config; an unresolvable agent keeps the tool, matching
 *  prior behavior.
 */
export function hasActorTool(agent: Pick<Info, "name" | "mode" | "toolAllowlist"> | undefined) {
  if (!agent) return true
  if (agent.toolAllowlist && !agent.toolAllowlist.includes("actor")) return false
  return agent.mode !== "subagent" || SYSTEM_SPAWNED_AGENT_TYPES.has(agent.name)
}

export type InvalidOutputPolicy = "primary" | "actor" | "checkpoint"

/** System agents must opt into an invalid-output contract instead of inheriting
 * the user-facing primary retry when they run with agentID "main". */
export const SYSTEM_INVALID_OUTPUT_POLICIES: Readonly<Record<string, InvalidOutputPolicy>> = {
  "checkpoint-writer": "checkpoint",
  dream: "actor",
  distill: "actor",
}

export function resolveInvalidOutputPolicy(input: {
  agentName: string
  agentID?: string
}): InvalidOutputPolicy {
  const system = SYSTEM_INVALID_OUTPUT_POLICIES[input.agentName]
  if (system) return system
  if (!input.agentID || input.agentID === "main") return "primary"
  return "actor"
}

/** Decide how a permission `ask` from the current turn should be routed:
 *  - system agent -> non-interactive (auto-deny, no human to answer)
 *  - orchestrator peer (background + mode:peer + has a parent) -> forward the ask
 *    for approval (interactive, with the parent session as approval route)
 *  - other background WITH a parent session id (child-session peers, or
 *    same-session actor subagents via sessionID) -> non-interactive but INHERIT:
 *    reuse the parent session's already-held grants (auto-allow granted paths,
 *    fail-closed on ungranted ones — never hang)
 *  - background with neither sessionParentID nor (for mode:subagent) sessionID
 *    -> non-interactive (auto-deny)
 *  - normal foreground -> interactive
 *  Pure function so the gate is unit-testable without a full prompt turn.
 */
export function decideAskRouting(input: {
  askActor?: { agent: string; background: boolean; mode: string; parentActorID?: string }
  sessionParentID?: string
  /** Current session id. Same-session actor subagents share the parent session
   *  (sessionParentID is empty on a root session); their grants are published
   *  under this id, so it is the inherit parent for that case. */
  sessionID?: string
  agentName: string
  // When false, orchestrator-peer forwarding is disabled (feature flag off) and
  // a peer falls back to the background auto-deny path.
  orchestratorEnabled?: boolean
}): { interactive: boolean; forward?: { parentSessionID: string }; inherit?: { parentSessionID: string } } {
  const isSystemAgent = input.askActor
    ? SYSTEM_SPAWNED_AGENT_TYPES.has(input.askActor.agent)
    : SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentName)
  if (isSystemAgent) return { interactive: false }
  const isOrchestratorPeer =
    input.orchestratorEnabled !== false &&
    !!input.askActor?.background &&
    input.askActor?.mode === "peer" &&
    !!(input.askActor?.parentActorID || input.sessionParentID)
  if (isOrchestratorPeer && input.sessionParentID) {
    return { interactive: true, forward: { parentSessionID: input.sessionParentID } }
  }
  // Ordinary background subagent: don't fail closed outright — let it inherit
  // the permissions the parent already holds a grant for. Still non-interactive
  // (no human attached); the ask consults the parent snapshot and auto-allows
  // only genuinely-granted paths, else fails closed.
  //
  // Inherit parent resolution:
  // - child-session peer (orchestrator worker): session.parentID points at the
  //   orchestrator session that published the grants.
  // - same-session actor spawn/run subagent: they share the parent session, so
  //   session.parentID is empty on a root session. Grants were published under
  //   the current session id — use that. Without this, same-session actor
  //   subagents silently skipped inherit and only skip-all could save them.
  //
  // sessionID fallback is subagent-only on purpose: a peer without
  // sessionParentID is a broken registration (its parent is the orchestrator
  // session). Looking up the peer's own session as "parent" would silently
  // broaden that edge; keep it fail-closed.
  if (input.askActor?.background) {
    const inheritParent = input.sessionParentID
      ?? (input.askActor.mode === "subagent" ? input.sessionID : undefined)
    if (inheritParent) {
      return { interactive: false, inherit: { parentSessionID: inheritParent } }
    }
  }
  return { interactive: !input.askActor?.background }
}
