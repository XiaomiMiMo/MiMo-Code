import { BUILT_IN_AGENTS, type ActorMatcher } from "@mimo-ai/plugin"

const isBuiltIn = (agentType: string): boolean =>
  (BUILT_IN_AGENTS as readonly string[]).includes(agentType)

export function matchesActor(
  matcher: ActorMatcher | undefined,
  input: { mode: "subagent" | "peer"; agentType: string },
): boolean {
  if (!matcher) return !isBuiltIn(input.agentType)

  if (matcher.mode && matcher.mode !== input.mode) return false

  const at = matcher.agentType

  if (at === undefined) return !isBuiltIn(input.agentType)

  if (typeof at === "string") {
    if (isBuiltIn(input.agentType)) return false
    try {
      return new RegExp(at).test(input.agentType)
    } catch {
      return false
    }
  }

  if (Array.isArray(at)) return at.includes(input.agentType)

  if ("excludeOnly" in at) return !at.excludeOnly.includes(input.agentType)

  if (at.exclude?.includes(input.agentType)) return false
  return at.include.includes(input.agentType)
}
