/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

/** Decide how a permission `ask` from the current turn should be routed:
 *  - system agent -> non-interactive (auto-deny, no human to answer)
 *  - orchestrator peer (background + mode:peer + has a parent) -> forward the ask
 *    for approval (interactive, with the parent session as approval route)
 *  - other background (e.g. compose subagents) -> non-interactive (auto-deny)
 *  - normal foreground -> interactive
 *  Pure function so the gate is unit-testable without a full prompt turn.
 */
export function decideAskRouting(input: {
  askActor?: { agent: string; background: boolean; mode: string; parentActorID?: string }
  sessionParentID?: string
  agentName: string
}): { interactive: boolean; forward?: { parentSessionID: string } } {
  const isSystemAgent = input.askActor
    ? SYSTEM_SPAWNED_AGENT_TYPES.has(input.askActor.agent)
    : SYSTEM_SPAWNED_AGENT_TYPES.has(input.agentName)
  if (isSystemAgent) return { interactive: false }
  const isOrchestratorPeer =
    !!input.askActor?.background &&
    input.askActor?.mode === "peer" &&
    !!(input.askActor?.parentActorID || input.sessionParentID)
  if (isOrchestratorPeer && input.sessionParentID) {
    return { interactive: true, forward: { parentSessionID: input.sessionParentID } }
  }
  return { interactive: !input.askActor?.background }
}
