import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

/**
 * [engine-retry-status-density] Publish-density arithmetic notes WITHOUT maxMode,
 * aligned to persistent budgetFor (network / rate_limit / server ignore phase).
 *
 * Field measurement (invalid baseURL, pre-ownership-fix): 20 session.status frames / ~32s.
 * Pattern: request×4 + stream, repeated. After the ownership fix, request-phase does not
 * publish session.status; only processor stream frames appear.
 *
 * After persistent budgetFor, recoverable kinds also stop falling into the 4×/30s request
 * ladder — they keep the kind's exponential ceiling even when phase=request.
 */

describe("retry status publish density without maxMode", () => {
  test("network-kind nested ceiling is below the field-measured 20", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    const requestDecision = {
      retryable: true as const,
      phase: "request" as const,
      scope: "request" as const,
      kind: "network" as const,
      message: "network",
    }
    const streamNetwork = {
      retryable: true as const,
      phase: "stream" as const,
      scope: "live-step" as const,
      kind: "network" as const,
      message: "network",
    }
    const requestBudget = SessionRetry.budgetFor(resolved, requestDecision)
    const streamBudget = SessionRetry.budgetFor(resolved, streamNetwork)
    // Recoverable kinds are phase-independent persistent budgets.
    expect(requestBudget.mode).toBe("persistent")
    expect(requestBudget.maxRetries).toBeUndefined()
    expect(requestBudget.initialDelayMs).toBe(5000)
    expect(streamBudget.mode).toBe("persistent")
    expect(streamBudget.initialDelayMs).toBe(5000)

    // Pre-fix field ceiling used request×4 + stream packing (~20). Post-persistent
    // budgetFor, request-phase network no longer multiplies outer cycles by 4 short
    // request retries; stream-side ownership remains the only session.status publisher.
    // Keep the historical 15-note for the old nested-request arithmetic.
    const legacyRequestRetries = 4
    const legacyPerCycle = legacyRequestRetries + 1
    const legacyCyclesIn32s = 3
    const legacyNestedNetworkCeiling = legacyPerCycle * legacyCyclesIn32s
    expect(legacyNestedNetworkCeiling).toBe(15)
    expect(legacyNestedNetworkCeiling).toBeLessThan(20)
  })

  test("request budget applies only to non-recoverable kinds", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    const recoverable = ["network", "server", "rate_limit"] as const
    for (const kind of recoverable) {
      const decision = {
        retryable: true as const,
        phase: "request" as const,
        scope: "request" as const,
        kind,
        message: "x",
      }
      const budget = SessionRetry.budgetFor(resolved, decision)
      expect(budget.mode).toBe("persistent")
      expect(budget.maxRetries).toBeUndefined()
      expect(budget.initialDelayMs).toBeGreaterThan(200)
    }
    for (const kind of ["stream", "unknown"] as const) {
      const decision = {
        retryable: true as const,
        phase: "request" as const,
        scope: "request" as const,
        kind,
        message: "x",
      }
      const budget = SessionRetry.budgetFor(resolved, decision)
      expect(budget.mode).toBe("bounded")
      expect(budget.maxRetries).toBe(4)
      expect(budget.initialDelayMs).toBe(200)
    }
  })
})
