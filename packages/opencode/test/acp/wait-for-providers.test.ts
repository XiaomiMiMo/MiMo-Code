import { test, expect, describe } from "bun:test"
import { waitForProviders } from "../../src/acp/wait-for-providers"

describe("waitForProviders", () => {
  test("returns true immediately when providers are available", async () => {
    const poll = () => Promise.resolve({ data: { providers: [{ id: "mimo" }] } })
    const result = await waitForProviders(poll, { maxAttempts: 3, intervalMs: 10 })
    expect(result).toBe(true)
  })

  test("retries and returns true when providers load on Nth attempt", async () => {
    let calls = 0
    const poll = () => {
      calls++
      if (calls < 3) return Promise.resolve({ data: { providers: [] } })
      return Promise.resolve({ data: { providers: [{ id: "mimo" }] } })
    }
    const result = await waitForProviders(poll, { maxAttempts: 5, intervalMs: 10 })
    expect(result).toBe(true)
    expect(calls).toBe(3)
  })

  test("returns false after exhausting all attempts", async () => {
    const poll = () => Promise.resolve({ data: { providers: [] } })
    const result = await waitForProviders(poll, { maxAttempts: 3, intervalMs: 10 })
    expect(result).toBe(false)
  })

  test("handles undefined data gracefully", async () => {
    const poll = () => Promise.resolve({ data: undefined })
    const result = await waitForProviders(poll, { maxAttempts: 2, intervalMs: 10 })
    expect(result).toBe(false)
  })
})
