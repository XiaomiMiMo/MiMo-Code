import type { Info } from "./agent"

/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

/** Whether the `actor` tool is in an agent's schema: subagents don't get it,
 *  because they must not spawn further subagents, and neither does an agent whose
 *  toolAllowlist omits it (dream/distill). Read by ToolRegistry.available, which
 *  applies the mask. Accepts undefined because
 *  `Agent.Service.get` is typed `Info` but returns `agents[name]`, which is absent
 *  for a name no longer in config; an unresolvable agent keeps the tool, matching
 *  prior behavior.
 */
export function hasActorTool(agent: Pick<Info, "name" | "mode" | "toolAllowlist"> | undefined) {
  return actorToolVariant(agent) === "full"
}

/** Which `actor` surface an agent gets.
 *
 *  - `full`: everything. Primaries, peers, system-spawned agents (whose real
 *    authority is the actor.tools whitelist), and any agent whose allowlist omits
 *    `actor` never reaching this branch.
 *  - `send`: subagents. They may not spawn further subagents, so the spawn/run/
 *    cancel/status/wait/models actions stay unavailable, but a worker needs one
 *    live channel back to report a blocker or a plan-changing finding instead of
 *    waiting for its turn to end. The registry swaps in a send-only schema and the
 *    tool re-checks the contract at runtime.
 *  - `none`: an agent whose toolAllowlist omits `actor` (dream, distill).
 */
export function actorToolVariant(
  agent: Pick<Info, "name" | "mode" | "toolAllowlist"> | undefined,
): "full" | "send" | "none" {
  if (!agent) return "full"
  if (agent.toolAllowlist && !agent.toolAllowlist.includes("actor")) return "none"
  if (agent.mode !== "subagent" || SYSTEM_SPAWNED_AGENT_TYPES.has(agent.name)) return "full"
  return "send"
}

/** Background actor subagents still have an attached client to answer asks.
 * Other background actors can only reuse existing parent grants; system agents
 * remain non-interactive even when a parent grant is available.
 */
export function decideAskRouting(input: {
  askActor?: { agent: string; background: boolean; mode: string; parentActorID?: string }
  sessionParentID?: string
  /** Current session id. Same-session actor subagents share the parent session
   *  (sessionParentID is empty on a root session); their grants are published
   *  under this id, so it is the inherit parent for that case. */
  sessionID?: string
  agentName: string
}): { interactive: boolean; inherit?: { parentSessionID: string } } {
  const isSystemAgent = input.askActor
    ? SYSTEM_SPAWNED_AGENT_TYPES.has(input.askActor.agent)
    : SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentName)
  if (isSystemAgent) return { interactive: false }
  const interactive = !input.askActor?.background || input.askActor.mode === "subagent"
  // Only same-session subagents may use their own session as the grant source.
  const inheritParent =
    input.sessionParentID ?? (input.askActor?.mode === "subagent" ? input.sessionID : undefined)
  if (inheritParent) {
    return { interactive, inherit: { parentSessionID: inheritParent } }
  }
  return { interactive }
}
