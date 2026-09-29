import { describe, expect } from "bun:test"
import { Effect } from "effect"
import { persistToolMetadata } from "../../src/mcp/tool-metadata"
import * as Truncate from "../../src/tool/truncate"
import { testEffect } from "../lib/effect"

const it = testEffect(Truncate.defaultLayer)

describe("MCP metadata persistence", () => {
  it.live("preserves small fields without changing the source", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const metadata = {
        isError: false,
        structuredContent: { items: [1, 2, 3] },
        _meta: { traceId: "test-trace" },
        legacyMetadata: { count: 3 },
      }
      const before = structuredClone(metadata)
      expect(yield* persistToolMetadata(metadata, truncate)).toEqual(before)
      expect(metadata).toEqual(before)
    }),
  )

  it.live("bounds the combined UTF-8 payload and archives private fields under _meta", () =>
    Effect.gen(function* () {
      const truncate = yield* Truncate.Service
      const payload = "诊断😀".repeat(3000)
      const metadata = {
        isError: true,
        structuredContent: { payload },
        _meta: { payload },
        legacyMetadata: { payload },
      }
      const before = structuredClone(metadata)
      const saved = yield* persistToolMetadata(metadata, truncate)
      expect(Buffer.byteLength(JSON.stringify(saved))).toBeLessThan(Truncate.MAX_BYTES + 1024)
      expect(saved.isError).toBe(true)
      expect(saved.structuredContent).toEqual({ payload })
      const privateMeta = saved._meta as { truncated: boolean; outputPath: string }
      expect(privateMeta.truncated).toBe(true)
      expect(yield* Effect.promise(() => Bun.file(privateMeta.outputPath).json())).toEqual({ payload })
      expect(yield* Effect.promise(() => Bun.file(String(saved.legacyMetadataPath)).json())).toEqual({ payload })
      expect(saved.legacyMetadata).toBeUndefined()
      expect(metadata).toEqual(before)
    }),
  )
})
