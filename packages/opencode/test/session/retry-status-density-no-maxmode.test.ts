import { describe, expect, test } from "bun:test"
import { SessionRetry } from "../../src/session/retry"

/**
 * [engine-retry-status-density] Without maxMode, the only non-ephemeral
 * session.status publishers are:
 *   - llm.ts request-phase (per llm.stream, max request.maxRetries)
 *   - processor.ts stream-phase (per process() Effect.retry, isMain only)
 * A processor attempt that exhausts request-phase then fails the stream can
 * nest: up to 4 request publishes + 1 processor publish per outer cycle.
 * This test documents the arithmetic ceiling — it does NOT prove the field
 * observation (30s / 20) without engine nextDelayMs logs.
 */

describe("retry status publish density without maxMode", () => {
  test("nested request-inside-processor ceiling arithmetic", () => {
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

    // One processor cycle: request ladder publishes (up to maxRetries), then
    // the stream fails and processor policy publishes once more before sleeping
    // stream-network backoff.
    const perCycle = (requestBudget.maxRetries ?? 0) + 1
    // In a 32s window with 5s→60s stream-network waits, outer cycles are few:
    // cycle0: 4 request + 1 processor + wait ~5s
    // cycle1: 4 request + 1 processor + wait ~10s
    // cycle2: 4 request + 1 processor + wait ~20s  → already past 32s
    const cyclesIn32s = 3
    const nestedCeiling = perCycle * cyclesIn32s
    expect(nestedCeiling).toBe(15)
    // Document that 20 is ABOVE this nested-network ceiling in 32s — so either
    // waits were shorter than network defaults (classification/retry-after),
    // publishes duplicated, or the UI streak was not from this ladder alone.
    expect(nestedCeiling).toBeLessThan(20)
  })

  test("server-kind stream budget can nest denser than network in 32s", () => {
    const resolved = SessionRetry.resolve(undefined, "test")
    const requestDecision = {
      retryable: true as const,
      phase: "request" as const,
      scope: "request" as const,
      kind: "server" as const,
      message: "503",
    }
    const streamServer = {
      retryable: true as const,
      phase: "stream" as const,
      scope: "live-step" as const,
      kind: "server" as const,
      message: "503",
    }
    const requestBudget = SessionRetry.budgetFor(resolved, requestDecision)
    const streamBudget = SessionRetry.budgetFor(resolved, streamServer)
    expect(requestBudget.maxRetries).toBe(4)
    expect(streamBudget.maxRetries).toBe(8)
    expect(streamBudget.initialDelayMs).toBe(2000)

    // processor stream-server delays: 2,4,8,16,30... plus 4 request publishes
    // each re-entry. First three outer waits ≈ 2+4+8=14s → 3 cycles × 5 = 15,
    // plus a fourth cycle starting before 32s if request fails fast.
    // Still typically <20 unless request waits are near-zero and cycles pack tighter.
    const perCycle = (requestBudget.maxRetries ?? 0) + 1
    expect(perCycle).toBe(5)
  })
})
