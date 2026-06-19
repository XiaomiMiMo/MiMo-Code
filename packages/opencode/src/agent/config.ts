/** Agent types that are spawned by the runtime (prune, scheduler, system code),
 *  NOT by the model. They get tool whitelist defaults and are skipped by
 *  prune/bootstrap/memory/recall scans.
 */
export const SYSTEM_SPAWNED_AGENT_TYPES: ReadonlySet<string> = new Set(["checkpoint-writer", "dream", "distill"])

/** Primary agent name constants — use these instead of string literals. */
export const AGENT_BUILD = "build" as const
export const AGENT_PLAN = "plan" as const
export const AGENT_COMPOSE = "compose" as const
