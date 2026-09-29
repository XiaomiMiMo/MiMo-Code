// Direct test of the fix-5 behaviour: does bounding `context` + capping the
// patch actually collapse the 33 MB diff to something bounded?
// Uses the same `diff` package and the same call shape as snapshot/index.ts.
import { test, expect } from "bun:test"
import { formatPatch, structuredPatch } from "diff"

const PATCH_CONTEXT = 3
const PATCH_MAX_CHARS = 256 * 1024
const DIFF_MAX_CHARS = 4 * 1024 * 1024

// mirrors the patched `patch()` in snapshot/index.ts
function patch(file: string, before: string, after: string) {
  const full = formatPatch(structuredPatch(file, file, before, after, "", "", { context: PATCH_CONTEXT }))
  if (full.length <= PATCH_MAX_CHARS) return full
  return full.slice(0, PATCH_MAX_CHARS) + "\n... [patch truncated]\n"
}

function unfixed(file: string, before: string, after: string) {
  return formatPatch(structuredPatch(file, file, before, after, "", "", { context: Number.MAX_SAFE_INTEGER }))
}

test("unbounded context blows up on a one-line edit to a big file", () => {
  const before = Array.from({ length: 10_000 }, (_, i) => `const line${i} = ${i}`).join("\n")
  const after = before.replace("const line5000 = 5000", "const line5000 = 5001")
  const bad = unfixed("big.ts", before, after)
  const good = patch("big.ts", before, after)
  console.log(`      unfixed: ${bad.length.toLocaleString()} chars   fixed: ${good.length.toLocaleString()} chars`)
  // the bug: whole file leaks into the patch
  expect(bad.length).toBeGreaterThan(200_000)
  // the fix: only the changed hunk + context
  expect(good.length).toBeLessThan(1_000)
})

test("realistic 62-file refactor fits inside the whole-diff budget", () => {
  const before = Array.from({ length: 2_000 }, (_, i) => `export const v${i} = ${i}`).join("\n")
  const after = before.replace("export const v1000 = 1000", "export const v1000 = 9999")

  const unfixedTotal = Array.from({ length: 62 }, (_, f) => unfixed(`f${f}.ts`, before, after)).reduce(
    (n, p) => n + p.length,
    0,
  )
  const fixed = Array.from({ length: 62 }, (_, f) => patch(`f${f}.ts`, before, after))
  const fixedTotal = fixed.reduce((n, p) => n + p.length, 0)

  console.log(`      62 files  unfixed: ${(unfixedTotal / 1048576).toFixed(1)} MB   fixed: ${(fixedTotal / 1048576).toFixed(2)} MB`)
  expect(unfixedTotal).toBeGreaterThan(3 * 1024 * 1024)
  expect(fixedTotal).toBeLessThan(DIFF_MAX_CHARS)
  // the fix is the whole point: >100x smaller on the same input
  expect(unfixedTotal / fixedTotal).toBeGreaterThan(100)
})

test("the whole-diff budget strips patch bodies but keeps per-file counts", () => {
  const items = Array.from({ length: 300 }, (_, i) => ({
    file: `f${i}.ts`,
    patch: "x".repeat(100_000),
    additions: 3,
    deletions: 1,
    status: "modified" as const,
  }))

  let budget = DIFF_MAX_CHARS
  let dropped = 0
  for (const item of items) {
    if (budget <= 0) {
      if (item.patch) {
        item.patch = ""
        dropped++
      }
      continue
    }
    if (item.patch.length > budget) {
      item.patch = item.patch.slice(0, budget) + "\n... [diff budget exhausted]\n"
      dropped++
    }
    budget -= item.patch.length
  }

  const total = items.reduce((n, i) => n + i.patch.length, 0)
  console.log(`      300 x 100KB -> ${(total / 1048576).toFixed(2)} MB kept, ${dropped} files had bodies dropped`)
  expect(total).toBeLessThanOrEqual(DIFF_MAX_CHARS + 200_000)
  // counts survive even when the body is dropped — the summary stays correct
  expect(items.every((i) => i.additions === 3 && i.deletions === 1)).toBe(true)
  expect(items.filter((i) => i.patch === "").length).toBeGreaterThan(0)
})

test("trimForPersist keeps only a 4KB preview per file", () => {
  const PREVIEW = 4 * 1024
  const diffs = Array.from({ length: 62 }, (_, i) => ({
    file: `f${i}.ts`,
    patch: "y".repeat(33 * 1024 * 1024 / 62),
    additions: 10,
    deletions: 4,
    status: "modified" as const,
  }))
  const trimmed = diffs.map((item) =>
    item.patch.length > PREVIEW
      ? { ...item, patch: item.patch.slice(0, PREVIEW) + "\n... [preview truncated]\n" }
      : item,
  )
  const total = trimmed.reduce((n, d) => n + d.patch.length, 0)
  console.log(`      persisted per message: ${(total / 1048576).toFixed(2)} MB (was ${(33).toFixed(1)} MB)`)
  expect(total).toBeLessThan(62 * (PREVIEW + 64))
  expect(trimmed.every((d) => d.additions === 10)).toBe(true)
})
