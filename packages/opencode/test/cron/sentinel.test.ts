import { test, expect, beforeEach } from "bun:test"
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import {
  resolveAtFireTime,
  resetOnCompaction,
  LOOP_FILE_SENTINEL,
  LOOP_FILE_DYNAMIC_SENTINEL,
  AUTONOMOUS_LOOP_SENTINEL,
  AUTONOMOUS_LOOP_DYNAMIC_SENTINEL,
  isSentinel,
} from "@/cron/sentinel"

beforeEach(() => resetOnCompaction())

test("non-sentinel prompts pass through unchanged", async () => {
  const out = await resolveAtFireTime("check the deploy", "/tmp/anywhere")
  expect(out).toBe("check the deploy")
})

test("isSentinel detects all four sentinels", () => {
  expect(isSentinel(LOOP_FILE_SENTINEL)).toBe(true)
  expect(isSentinel(LOOP_FILE_DYNAMIC_SENTINEL)).toBe(true)
  expect(isSentinel(AUTONOMOUS_LOOP_SENTINEL)).toBe(true)
  expect(isSentinel(AUTONOMOUS_LOOP_DYNAMIC_SENTINEL)).toBe(true)
  expect(isSentinel("plain prompt")).toBe(false)
})

test("autonomous-loop first fire returns full preamble", async () => {
  const out = await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/x")
  expect(out.length).toBeGreaterThan(100)
  expect(out).toContain("autonomous loop")
})

test("autonomous-loop subsequent fires return short reminder", async () => {
  await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/x")
  const out = await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/x")
  expect(out).toMatch(/autonomous loop tick/)
  expect(out.length).toBeLessThan(150)
})

test("loop.md sentinel reads project loop.md and returns fenced content", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "- check deploy\n- review PRs")
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toContain("Loop tasks (from")
  expect(out).toContain("- check deploy")
  expect(out).toContain("- review PRs")
  rmSync(dir, { recursive: true, force: true })
})

test("loop.md sentinel unchanged content returns short reminder on 2nd fire", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "tasks here")
  await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toMatch(/unchanged/)
  rmSync(dir, { recursive: true, force: true })
})

test("loop.md edited between fires returns full content again", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  const p = join(dir, ".mimocode", "loop.md")
  writeFileSync(p, "v1")
  await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  writeFileSync(p, "v2")
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toContain("v2")
  expect(out).not.toMatch(/unchanged/)
  rmSync(dir, { recursive: true, force: true })
})

test("loop.md absent returns absent-reminder", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toMatch(/no longer present/)
  rmSync(dir, { recursive: true, force: true })
})

test("loop.md > 25KB is truncated with warning", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "x".repeat(30_000))
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toContain("truncated to 25000 bytes")
  expect(out.length).toBeLessThan(28_000)
  rmSync(dir, { recursive: true, force: true })
})

test("resetOnCompaction clears the cache", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "content")
  await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  resetOnCompaction()
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toContain("content")
  rmSync(dir, { recursive: true, force: true })
})

test("loop.md with backticks gets a longer fence", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "run ```bash\necho hi\n``` thingy")
  const out = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir)
  expect(out).toMatch(/````/)
  rmSync(dir, { recursive: true, force: true })
})

// Regression for PR #1479 finding #10: sentinel caches must be per-session.
// Without keying, Session B's first <<loop.md>> fire would return the short
// "unchanged" reminder if Session A had cached the same content.
test("loop.md cache does not bleed across sessions", async () => {
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "shared content")

  const a1 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_A")
  expect(a1).toContain("shared content")

  // Session B: must ALSO get full content on first fire.
  const b1 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_B")
  expect(b1).toContain("shared content")
  expect(b1).not.toMatch(/unchanged/)

  // Session A's second fire (same content) gets the short reminder.
  const a2 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_A")
  expect(a2).toMatch(/unchanged/)

  rmSync(dir, { recursive: true, force: true })
})

test("autonomous-loop delivery does not bleed across sessions", async () => {
  resetOnCompaction() // clear any anon-session state from prior tests
  const a1 = await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/sentinel-iso", "ses_A")
  expect(a1).toContain("autonomous loop")
  const a2 = await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/sentinel-iso", "ses_A")
  expect(a2).toMatch(/autonomous loop tick/)

  // Session B must get the full preamble on its first fire.
  const b1 = await resolveAtFireTime(AUTONOMOUS_LOOP_SENTINEL, "/tmp/sentinel-iso", "ses_B")
  expect(b1).toContain("autonomous loop")
  expect(b1.length).toBeGreaterThan(100)
})

// Regression: resetOnCompaction(sessionID) is scoped — only the named session's
// cache entries are cleared. Sibling sessions keep their "already delivered"
// state so their next fire returns the short reminder (no wasted retransmission).
// This is the shape the cron-bridge uses when it subscribes to
// SessionCompaction.Event.Compacted and forwards `sessionID` — the wiring that
// covers both the user-/compact path and the overflow-boundary rebuild path.
test("resetOnCompaction(sessionID) is scoped, does not clear sibling sessions", async () => {
  resetOnCompaction() // clean slate
  const dir = mkdtempSync(join(tmpdir(), "sentinel-"))
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", "loop.md"), "shared body")

  // Warm the cache for both sessions.
  const a1 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_A")
  const b1 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_B")
  expect(a1).toContain("shared body")
  expect(b1).toContain("shared body")

  // 2nd fire on each → short reminder (cache is warm).
  const a2 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_A")
  const b2 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_B")
  expect(a2).toMatch(/unchanged/)
  expect(b2).toMatch(/unchanged/)

  // Only compact session A.
  resetOnCompaction("ses_A")

  // A's next fire returns full content again (cache was cleared for A).
  const a3 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_A")
  expect(a3).toContain("shared body")

  // B's cache is untouched → still returns the short reminder.
  const b3 = await resolveAtFireTime(LOOP_FILE_SENTINEL, dir, "ses_B")
  expect(b3).toMatch(/unchanged/)

  rmSync(dir, { recursive: true, force: true })
})
