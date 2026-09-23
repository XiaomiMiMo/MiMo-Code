import { Flag } from "@/flag/flag"
import { ToolResultError } from "@/tool/result-error"

export const TOOLCALL_DUPLICATE_ERROR =
  "Tool call cancelled because it exactly matches an earlier tool call in this step and was not executed."

function stableStringify(value: unknown): string {
  if (value === null || typeof value === "string" || typeof value === "boolean") return JSON.stringify(value)
  if (typeof value === "number") return Number.isFinite(value) ? JSON.stringify(value) : "null"
  if (Array.isArray(value)) return "[" + value.map(stableStringify).join(",") + "]"
  if (typeof value !== "object") return "null"
  const keys = Object.keys(value as Record<string, unknown>).sort()
  return (
    "{" +
    keys.map((k) => JSON.stringify(k) + ":" + stableStringify((value as Record<string, unknown>)[k])).join(",") +
    "}"
  )
}

/**
 * Per assistant-step exact-repeat filter on (canonical tool name + stable args).
 * First occurrence runs; later identical calls are rejected without executing.
 * Cross-step and cross-turn repeats stay normal.
 */
export function createToolCallDuplicateGuard() {
  const seen = new Set<string>()
  return (name: string, args: unknown): boolean => {
    if (Flag.MIMOCODE_DISABLE_TOOLCALL_DUPLICATE_DETECT) return true
    const signature = `${name}\0${stableStringify(args ?? {})}`
    if (seen.has(signature)) return false
    seen.add(signature)
    return true
  }
}

export function rejectToolCallDuplicate(): Promise<never> {
  return Promise.reject(new ToolResultError(TOOLCALL_DUPLICATE_ERROR, { interrupted: true, reason: "duplicate" }))
}
