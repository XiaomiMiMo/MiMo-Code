import { describe, expect, spyOn, test } from "bun:test"
import { withTimeout } from "../../src/util/timeout"

describe("withTimeout", () => {
  test("resolves when promise finishes before timeout", async () => {
    const result = await withTimeout(Promise.resolve("ok"), 1000)
    expect(result).toBe("ok")
  })

  test("rejects when promise exceeds timeout", async () => {
    const neverResolve = new Promise<string>(() => {})
    await expect(withTimeout(neverResolve, 50)).rejects.toThrow("timed out")
  })

  test("rejects with timeout error even if promise would eventually resolve", async () => {
    const slowPromise = new Promise<string>((resolve) => {
      setTimeout(() => resolve("late"), 500)
    })
    await expect(withTimeout(slowPromise, 50)).rejects.toThrow("timed out")
  })

  test("propagates rejection from the original promise", async () => {
    const failingPromise = Promise.reject(new Error("fetch failed"))
    await expect(withTimeout(failingPromise, 1000)).rejects.toThrow("fetch failed")
  })

  test("clears its timer when the original promise rejects", async () => {
    const setTimeoutSpy = spyOn(globalThis, "setTimeout")
    const clearTimeoutSpy = spyOn(globalThis, "clearTimeout")
    try {
      await expect(withTimeout(Promise.reject(new Error("fetch failed")), 60_000)).rejects.toThrow("fetch failed")
      expect(clearTimeoutSpy).toHaveBeenCalledWith(setTimeoutSpy.mock.results[0]?.value)
    } finally {
      const timeout = setTimeoutSpy.mock.results[0]?.value
      if (timeout) clearTimeout(timeout)
      clearTimeoutSpy.mockRestore()
      setTimeoutSpy.mockRestore()
    }
  })
})
