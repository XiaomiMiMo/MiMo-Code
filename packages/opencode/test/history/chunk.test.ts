import { test, expect } from "bun:test"
import {
  CHUNK_BODY_MAX,
  CHUNK_MAX,
  CHUNK_OMIT,
  basePartId,
  chunkBody,
  chunkId,
  chunkLikePattern,
  likeEscape,
  splitBody,
} from "../../src/history/chunk"

test("basePartId strips chunk suffix only", () => {
  expect(basePartId("prt_abc")).toBe("prt_abc")
  expect(basePartId("prt_abc#0")).toBe("prt_abc")
  expect(basePartId("prt_abc#12")).toBe("prt_abc")
  expect(basePartId("prt_abc#x")).toBe("prt_abc#x")
  expect(basePartId("#0")).toBe("#0")
})

test("chunkId keeps bare id for single chunk", () => {
  expect(chunkId("prt_abc", 0, 1)).toBe("prt_abc")
  expect(chunkId("prt_abc", 0, 2)).toBe("prt_abc#0")
  expect(chunkId("prt_abc", 1, 2)).toBe("prt_abc#1")
})

test("splitBody short body is one chunk", () => {
  expect(splitBody("hello")).toEqual(["hello"])
})

test("splitBody prefers newline boundaries", () => {
  const line = "x".repeat(40) + "\n"
  const body = line.repeat(10) // 410 chars
  const parts = splitBody(body, 100)
  expect(parts.length).toBeGreaterThan(1)
  for (const p of parts) expect(p.length).toBeLessThanOrEqual(100)
  expect(parts.join("")).toBe(body)
})

test("chunkBody caps count and marks omission", () => {
  const body = ("word\n".repeat(20)).repeat(200) // large
  const chunks = chunkBody(body, 200, 3)
  expect(chunks.length).toBe(3)
  expect(chunks[2]!.endsWith(CHUNK_OMIT)).toBe(true)
  expect(chunks[0]!.length).toBeLessThanOrEqual(200 + 1)
})

test("chunkBody default max matches contract", () => {
  const body = "a".repeat(CHUNK_BODY_MAX + 10)
  const chunks = chunkBody(body)
  expect(chunks.length).toBe(2)
  expect(chunks[0]!.length).toBeLessThanOrEqual(CHUNK_BODY_MAX)
})

test("chunkLikePattern escapes LIKE metacharacters", () => {
  expect(likeEscape("a%b_c\\d")).toBe("a\\%b\\_c\\\\d")
  // `_` is a LIKE single-char wildcard; production part ids contain `_` and must be escaped.
  expect(chunkLikePattern("prt_abc")).toBe("prt\\_abc#%")
})

test("CHUNK_MAX is positive and CHUNK_BODY_MAX reasonable", () => {
  expect(CHUNK_MAX).toBeGreaterThan(0)
  expect(CHUNK_BODY_MAX).toBeGreaterThan(1000)
})
