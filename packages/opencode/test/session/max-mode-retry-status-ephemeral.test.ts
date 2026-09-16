import { describe, expect, test } from "bun:test"
import { readFileSync } from "fs"
import path from "path"
import { SessionRetry } from "../../src/session/retry"

/**
 * Density ownership is enforced by llm.ts not calling status.setRetry on the
 * request path (processor owns session.status). Max-mode must NOT reuse
 * `ephemeral:true` as a status switch — that flag also skips plugins, affinity
 * headers, OTel functionId, and system assembly.
 */

const maxModePath = path.join(import.meta.dir, "../../src/session/max-mode.ts")

describe("max-mode does not overload ephemeral for status control", () => {
  test("candidate/judge llm.stream calls are not marked ephemeral:true", () => {
    const src = readFileSync(maxModePath, "utf8")
    // Strip comments before scanning for the flag assignment.
    const code = src.replace(/\/\*[\s\S]*?\*\//g, "").replace(/^\s*\/\/.*$/gm, "")
    expect(code.includes("ephemeral: true")).toBe(false)
  })

  test("request-phase budget is still 4×200ms (status ownership lives in llm.ts)", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    const decision = {
      retryable: true as const,
      phase: "request" as const,
      scope: "request" as const,
      kind: "network" as const,
      message: "network",
    }
    const budget = SessionRetry.budgetFor(resolved, decision)
    expect(budget.maxRetries).toBe(4)
    expect(budget.initialDelayMs).toBe(200)
  })
})
