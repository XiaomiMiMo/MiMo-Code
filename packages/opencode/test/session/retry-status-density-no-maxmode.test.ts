import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

/**
 * [engine-retry-status-density] Arithmetic notes for publish density WITHOUT maxMode.
 *
 * Field measurement (invalid baseURL, pre-fix): 20 session.status frames / ~32s.
 * Pattern: request×4 + stream, repeated. That exceeds a pure network-kind nested
 * ceiling (~15 in 32s at 5s→60s) because "Cannot connect to API" is classified on
 * the stream ladder with ~2s initialDelay (server/stream-style), packing more
 * outer cycles: 4×(4 request + 1 stream) ≈ 20.
 *
 * After the ownership fix, request-phase does not publish session.status; only
 * processor stream frames appear (see retry-density-invalid-baseurl.test.ts).
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
    expect(requestBudget.maxRetries).toBe(4)
    expect(streamBudget.mode).toBe("persistent")
    expect(streamBudget.initialDelayMs).toBe(5000)

    const perCycle = (requestBudget.maxRetries ?? 0) + 1
    const cyclesIn32s = 3
    const nestedNetworkCeiling = perCycle * cyclesIn32s
    expect(nestedNetworkCeiling).toBe(15)
    // Field 20 > network-kind ceiling ⇒ stream waits were shorter (server/stream
    // ~2s class), not 5s network. Ownership fix removes request frames either way.
    expect(nestedNetworkCeiling).toBeLessThan(20)
  })

  test("request budget always uses 200ms-class ladder regardless of kind", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    for (const kind of ["network", "server", "rate_limit", "stream", "unknown"] as const) {
      const decision = {
        retryable: true as const,
        phase: "request" as const,
        scope: "request" as const,
        kind,
        message: "x",
      }
      const budget = SessionRetry.budgetFor(resolved, decision)
      expect(budget.maxRetries).toBe(4)
      expect(budget.initialDelayMs).toBe(200)
    }
  })
})
