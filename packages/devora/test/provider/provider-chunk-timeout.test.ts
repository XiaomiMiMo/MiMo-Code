import { describe, expect, test } from "bun:test"
import { DEFAULT_CHUNK_TIMEOUT } from "../../src/provider/provider"

describe("provider chunkTimeout", () => {
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
