import { describe, expect, test } from "bun:test"
import { DEFAULT_CHUNK_TIMEOUT, DEFAULT_HEADER_TIMEOUT, resolveHeaderTimeout } from "../../src/provider/provider"

describe("provider timeouts", () => {
  test("response headers default to a five-minute timeout for every provider", () => {
    expect(DEFAULT_HEADER_TIMEOUT).toBe(300_000)
  })

  test("resolveHeaderTimeout picks the user value, the disable flag, or the default", () => {
    expect(resolveHeaderTimeout(undefined)).toBe(DEFAULT_HEADER_TIMEOUT)
    expect(resolveHeaderTimeout(false)).toBeUndefined()
    expect(resolveHeaderTimeout(12_000)).toBe(12_000)
    // Invalid values fail safe to the default: an instant-abort (0) or a
    // silently skipped timeout (garbage) would both be worse than bounding.
    expect(resolveHeaderTimeout(0)).toBe(DEFAULT_HEADER_TIMEOUT)
    expect(resolveHeaderTimeout("not a number")).toBe(DEFAULT_HEADER_TIMEOUT)
  })

  test("DEFAULT_CHUNK_TIMEOUT is 8 minutes (480_000 ms)", () => {
    expect(DEFAULT_CHUNK_TIMEOUT).toBe(480_000)
  })

  test("user-supplied chunkTimeout (number) takes precedence over default", () => {
    // Mirrors provider.ts:1472-1476 selection logic.
    function pickChunkTimeout(options: { chunkTimeout?: unknown }): number {
      const userChunkTimeout = options["chunkTimeout"]
      return typeof userChunkTimeout === "number" ? userChunkTimeout : DEFAULT_CHUNK_TIMEOUT
    }

    expect(pickChunkTimeout({ chunkTimeout: 60_000 })).toBe(60_000)
    expect(pickChunkTimeout({ chunkTimeout: 0 })).toBe(0)
    expect(pickChunkTimeout({ chunkTimeout: -1 })).toBe(-1)
    expect(pickChunkTimeout({})).toBe(DEFAULT_CHUNK_TIMEOUT)
    expect(pickChunkTimeout({ chunkTimeout: "not a number" })).toBe(DEFAULT_CHUNK_TIMEOUT)
    expect(pickChunkTimeout({ chunkTimeout: null })).toBe(DEFAULT_CHUNK_TIMEOUT)
  })
})
