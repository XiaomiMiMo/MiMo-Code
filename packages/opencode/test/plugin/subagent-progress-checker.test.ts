import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import os from "os"
import path from "path"
import { SubagentProgressCheckerPlugin } from "../../src/plugin/subagent-progress-checker"
import { tasksDir, progressPath } from "../../src/session/checkpoint-paths"
import { SessionID } from "../../src/session/schema"

async function withTmpHome<T>(fn: (sessionID: SessionID) => Promise<T>): Promise<T> {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "subagent-progress-test-"))
  const prevHome = process.env.MIMOCODE_HOME
  process.env.MIMOCODE_HOME = dir
  try {
    const sid = SessionID.make("ses_test_" + Date.now())
    await fs.mkdir(tasksDir(sid), { recursive: true })
    return await fn(sid)
  } finally {
    if (prevHome === undefined) delete process.env.MIMOCODE_HOME
    else process.env.MIMOCODE_HOME = prevHome
    await fs.rm(dir, { recursive: true, force: true })
  }
}

async function getHooks() {
  return await SubagentProgressCheckerPlugin({} as never)
}

function makeInput(sessionID: SessionID, task_id?: string, canWrite?: boolean) {
  return {
    sessionID: sessionID as unknown as string,
    actorID: "actor-test",
    agentType: "explore",
    mode: "subagent" as const,
    lifecycle: "ephemeral" as const,
    task: "find error recovery",
    description: "Find error recovery",
    finalText: "(done)",
    outcome: "success" as const,
    iteration: 0,
    ...(task_id !== undefined ? { task_id } : {}),
    ...(canWrite !== undefined ? { canWrite } : {}),
  }
}

describe("SubagentProgressCheckerPlugin postStop", () => {
  test("no task_id → no-op", async () => {
    await withTmpHome(async (sid) => {
      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      await fn(makeInput(sid, undefined), output)
      expect(output.continue).toBeUndefined()
      expect(output.reason).toBeUndefined()
    })
  })

  test("canWrite=false → skip (read-only agent, no nudge even when file missing)", async () => {
    await withTmpHome(async (sid) => {
      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      // task-bound AND file missing, but agent cannot write → must NOT nudge.
      await fn(makeInput(sid, "T4", false), output)
      expect(output.continue).toBeUndefined()
      expect(output.reason).toBeUndefined()
    })
  })

  test("canWrite=true → still nudges when file missing (writable agent unchanged)", async () => {
    await withTmpHome(async (sid) => {
      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      await fn(makeInput(sid, "T4", true), output)
      expect(output.continue).toBe(true)
      expect(output.reason).toContain(progressPath(sid, "T4"))
    })
  })

  test("file missing → continue=true with full template feedback", async () => {
    await withTmpHome(async (sid) => {
      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      await fn(makeInput(sid, "T4"), output)
      expect(output.continue).toBe(true)
      expect(output.reason).toContain(progressPath(sid, "T4"))
      expect(output.reason).toContain("## §1 Task identity")
      expect(output.reason).toContain("## §5 Outcome and discoveries")
    })
  })

  test("file exists with all 5 sections → PASS, frontmatter injected", async () => {
    await withTmpHome(async (sid) => {
      const fp = progressPath(sid, "T7")
      await fs.mkdir(path.dirname(fp), { recursive: true })
      const body =
        "## §1 Task identity\n- task_id: T7\n\n" +
        "## §2 Subagent intent\nDo X.\n\n" +
        "## §3 Files and code sections\n- a.ts: read\n\n" +
        "## §4 Verbatim commands\n```\nls\n```\n\n" +
        "## §5 Outcome and discoveries\n- Outcome: success\n"
      await Bun.write(fp, body)

      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      await fn(makeInput(sid, "T7"), output)

      expect(output.continue).toBeUndefined()
      const after = await Bun.file(fp).text()
      expect(after.startsWith("---\nwritten-at: ")).toBe(true)
      expect(after).toContain("## §1 Task identity")
      expect(after).toContain("## §5 Outcome and discoveries")
    })
  })

  test("file exists missing §3 → continue=true, reason lists §3", async () => {
    await withTmpHome(async (sid) => {
      const fp = progressPath(sid, "T9")
      await fs.mkdir(path.dirname(fp), { recursive: true })
      const body =
        "## §1 Task identity\n- task_id: T9\n\n" +
        "## §2 Subagent intent\nDo X.\n\n" +
        "## §4 Verbatim commands\n```\nls\n```\n\n" +
        "## §5 Outcome and discoveries\n- Outcome: success\n"
      await Bun.write(fp, body)

      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run
      const output: { continue?: boolean; reason?: string } = {}
      await fn(makeInput(sid, "T9"), output)

      expect(output.continue).toBe(true)
      expect(output.reason).toContain("missing required sections")
      expect(output.reason).toContain("## §3 Files and code sections")
    })
  })

  test("frontmatter idempotent — second PASS replaces, doesn't stack", async () => {
    await withTmpHome(async (sid) => {
      const fp = progressPath(sid, "T2")
      await fs.mkdir(path.dirname(fp), { recursive: true })
      const body =
        "## §1 Task identity\n- task_id: T2\n\n" +
        "## §2 Subagent intent\nDo X.\n\n" +
        "## §3 Files and code sections\n- a.ts: read\n\n" +
        "## §4 Verbatim commands\n```\nls\n```\n\n" +
        "## §5 Outcome and discoveries\n- Outcome: success\n"
      await Bun.write(fp, body)

      const hooks = await getHooks()
      const reg = hooks["actor.postStop"]
      if (!reg || typeof reg === "function") throw new Error("expected object form with run")
      const fn = (reg as { run: (...args: any[]) => Promise<void> }).run

      await fn(makeInput(sid, "T2"), {})
      const afterFirst = await Bun.file(fp).text()
      const firstMatch = afterFirst.match(/^---\nwritten-at: (\d+)\n---\n/)
      expect(firstMatch).not.toBeNull()

      await new Promise((r) => setTimeout(r, 5))

      await fn(makeInput(sid, "T2"), {})
      const afterSecond = await Bun.file(fp).text()
      const secondMatch = afterSecond.match(/^---\nwritten-at: (\d+)\n---\n/)
      expect(secondMatch).not.toBeNull()
      expect(Number(secondMatch![1])).toBeGreaterThanOrEqual(Number(firstMatch![1]))

      const fmCount = (afterSecond.match(/^---/gm) ?? []).length
      expect(fmCount).toBe(2) // opening --- and closing ---
    })
  })
})

// ---------------------------------------------------------------------------
// C1 regression: matcher must fire for built-in subagent types
// ---------------------------------------------------------------------------
//
// Previously the plugin had no matcher field; matchesActor's default path
// returned !isBuiltIn(agentType), so the plugin silently no-op'd for
// general/explore/build/etc. — the exact built-in subagents that bind to
// task_id in production. The new excludeOnly form bypasses that early-return.

import { matchesActor } from "../../src/plugin/matcher"

describe("SubagentProgressCheckerPlugin matcher (C1 regression)", () => {
  test("matcher fires for built-in subagents (general / explore / build)", async () => {
    const hooks = await getHooks()
    const reg = hooks["actor.postStop"]
    if (!reg || typeof reg === "function") throw new Error("expected matcher form")
    const matcher = (reg as { matcher?: import("@mimo-ai/plugin").ActorMatcher }).matcher
    for (const at of ["general", "explore", "build"]) {
      expect(matchesActor(matcher, { mode: "subagent", agentType: at })).toBe(true)
    }
  })

  test("matcher excludes internal subagents that lack task_id semantics", async () => {
    const hooks = await getHooks()
    const reg = hooks["actor.postStop"]
    if (!reg || typeof reg === "function") throw new Error("expected matcher form")
    const matcher = (reg as { matcher?: import("@mimo-ai/plugin").ActorMatcher }).matcher
    for (const at of ["checkpoint-writer", "title", "summary", "dream", "distill", "compaction", "main"]) {
      expect(matchesActor(matcher, { mode: "subagent", agentType: at })).toBe(false)
    }
  })

  test("matcher fires for user-defined custom subagents (not built-in, not in exclude list)", async () => {
    const hooks = await getHooks()
    const reg = hooks["actor.postStop"]
    if (!reg || typeof reg === "function") throw new Error("expected matcher form")
    const matcher = (reg as { matcher?: import("@mimo-ai/plugin").ActorMatcher }).matcher
    expect(matchesActor(matcher, { mode: "subagent", agentType: "my-custom-reviewer" })).toBe(true)
  })
})
