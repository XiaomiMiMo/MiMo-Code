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
