import { describe, expect, test } from "bun:test"
import { BuiltinWorkflow } from "../../src/workflow/builtin"
import { parseMeta } from "../../src/workflow/meta"
import { evalScript } from "../../src/workflow/sandbox"

const composeScript = () => {
  const c = BuiltinWorkflow.get("compose")
  expect(c).toBeDefined()
  return c!.script
}

describe("compose script structure", () => {
  test("body parses cleanly", () => {
    const parsed = parseMeta(composeScript())
    expect(parsed.ok).toBe(true)
  })

  test("declares schemas for every phase", () => {
    const script = composeScript()
    expect(script).toContain("BRAINSTORM_SHAPE")
    expect(script).toContain("CLASSIFY_SHAPE")
    expect(script).toContain("DESIGN_SHAPE")
    expect(script).toContain("INTEGRATE_SHAPE")
    expect(script).toContain("VERIFY_SHAPE")
    expect(script).toContain("REVIEW_SHAPE")
    expect(script).toContain("ITERATION_REPORT_SHAPE")
    expect(script).toContain("FINAL_REPORT_SHAPE")
    expect(script).toContain("MERGE_SHAPE")
  })
})

// Default agent stub that drives a clean happy path. Implement/fix agents return a
// `_worktree` (changed) so the integrate path is exercised. Override per-test.
const happyAgent = (prompt: string, opts?: any) => {
  const o = opts as any
  if (o?.schema?.properties?.context) return { context: { projectType: "Bun TS", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
  if (o?.schema?.properties?.type) return { type: "feature", confidence: "high", reasoning: "r" }
  if (o?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
  if (o?.schema?.properties?.merged) return { merged: [{ taskId: "t1", branch: "b", sha: "s" }], conflicts: [], skipped_pristine: [] }
  if (o?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
  if (o?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
  if (o?.schema?.properties?.iteration) return { iteration: 1, what_changed: "x" }
  if (o?.schema?.properties?.path) return { path: "docs/compose/reports/x.md", sha: "rsha" }
  if (o?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
  if (o?.label && String(o.label).startsWith("implement")) return { _worktree: { branch: "wt-" + o.label, directory: "/tmp/" + o.label, changed: true } }
  if (o?.label && String(o.label).startsWith("fix")) return { _worktree: { branch: "wt-" + o.label, directory: "/tmp/" + o.label, changed: true } }
  return "ok"
}

const runCompose = async (args: unknown, agentImpl: (prompt: string, opts?: any) => unknown = happyAgent) => {
  const parsed = parseMeta(composeScript())
  if (!parsed.ok) throw new Error(parsed.error)
  const calls: { prompt: string; opts?: any }[] = []
  const phases: string[] = []
  const hooks = {
    agent: async (prompt: unknown, opts?: unknown) => {
      const p = String(prompt)
      const o = opts as any
      calls.push({ prompt: p, opts: o })
      return agentImpl(p, o)
    },
    phase: (title: unknown) => { phases.push(String(title)) },
    log: () => undefined,
    workflow: async () => null,
    readFile: async () => null,
    writeFile: async () => undefined,
    exists: async () => false,
    glob: async () => [],
  }
  const body = `globalThis.args = ${JSON.stringify(args)};\n` + parsed.body
  const result = await evalScript(body, hooks)
  return { result, calls, phases }
}

describe("compose phase 0: Brainstorm", () => {
  test("runs brainstorm context recon by default", async () => {
    const { calls } = await runCompose({ task: "add dark mode", type: "feature" })
    const bs = calls.find((c) => c.opts?.schema?.properties?.context)
    expect(bs).toBeDefined()
    expect(bs!.opts.label).toBe("brainstorm")
    expect(bs!.prompt).toContain("compose:brainstorm")
    expect(bs!.prompt).toContain("AUTONOMOUS")
  })

  test("skips brainstorm agent when args.skip_brainstorm", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature", skip_brainstorm: true })
    expect(calls.find((c) => c.opts?.schema?.properties?.context)).toBeUndefined()
  })
})

describe("compose docs dir injection", () => {
  test("design + report prompts carry the configured docs dir", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature", _composeDocsDir: "custom/docs" })
    const design = calls.find((c) => c.opts?.schema?.properties?.tasks)
    expect(design!.prompt).toContain("custom/docs/specs")
    expect(design!.prompt).toContain("custom/docs/plans")
    const report = calls.find((c) => c.opts?.schema?.properties?.path)
    expect(report!.prompt).toContain("custom/docs/reports")
  })

  test("defaults to docs/compose when host did not inject", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const design = calls.find((c) => c.opts?.schema?.properties?.tasks)
    expect(design!.prompt).toContain("docs/compose/specs")
  })
})

describe("compose phase 1: Classify", () => {
  test("calls classifier when args.type absent", async () => {
    const { calls } = await runCompose({ task: "fix the foo regression" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.type) return { type: "bugfix", confidence: "high", reasoning: "regression keyword" }
      return null
    })
    const classifyCall = calls.find((c) => c.opts?.schema?.properties?.type)
    expect(classifyCall).toBeDefined()
    expect(classifyCall!.prompt).toContain("fix the foo regression")
  })

  test("skips classifier when args.type provided", async () => {
    const { calls } = await runCompose({ task: "implement bar", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      return null
    })
    expect(calls.find((c) => c.opts?.schema?.properties?.type)).toBeUndefined()
  })
})

describe("compose phase 2: Design", () => {
  test.each([
    ["feature", "compose:plan"],
    ["refactor", "compose:plan"],
    ["bugfix", "compose:debug"],
    ["feedback", "compose:feedback"],
  ])("type=%s routes to %s", async (type, skill) => {
    const { calls } = await runCompose({ task: "x", type }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
      return null
    })
    const designCall = calls.find((c) => c.opts?.schema?.properties?.tasks)
    expect(designCall).toBeDefined()
    expect(designCall!.prompt).toContain(skill)
  })

  test("design returning null surfaces design-failed", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      return null
    })
    expect(result).toMatchObject({ error: "design-failed" })
  })
})

describe("compose phase 3: parallelism, dependencies, worktrees", () => {
  test("independent tasks land in one batch dispatched in parallel with worktree isolation", async () => {
    let maxConcurrent = 0
    let active = 0
    const { result, calls } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { id: "T1", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T2", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T3", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T4", description: "d", acceptance: "a", dependsOn: [] },
      ] }
      if (opts?.schema?.properties?.merged) return { merged: [], conflicts: [], skipped_pristine: [] }
      if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
      if (opts?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
      if (opts?.schema?.properties?.iteration) return { iteration: 1, what_changed: "x" }
      if (opts?.schema?.properties?.path) return { path: "p", sha: "s" }
      if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
      if (opts?.label && String(opts.label).startsWith("implement")) {
        active++; maxConcurrent = Math.max(maxConcurrent, active); active--
        return { _worktree: { branch: "b", directory: "/tmp/d", changed: true } }
      }
      return "ok"
    })
    expect((result as any).batches).toEqual([["T1", "T2", "T3", "T4"]])
    const implCalls = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:"))
    expect(implCalls).toHaveLength(4)
    for (const c of implCalls) expect(c.opts.isolation).toBe("worktree")
  })

  test("dependency chain produces sequential batches in order", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { id: "T1", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T2", description: "d", acceptance: "a", dependsOn: ["T1"] },
        { id: "T3", description: "d", acceptance: "a", dependsOn: ["T2"] },
      ] }
      return happyAgent(prompt, opts)
    })
    expect((result as any).batches).toEqual([["T1"], ["T2"], ["T3"]])
  })

  test("dependency cycle returns design-cycle", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { id: "T1", description: "d", acceptance: "a", dependsOn: ["T2"] },
        { id: "T2", description: "d", acceptance: "a", dependsOn: ["T1"] },
      ] }
      return happyAgent(prompt, opts)
    })
    expect(result).toMatchObject({ error: "design-cycle" })
    expect((result as any).cycleNodes).toEqual(expect.arrayContaining(["T1", "T2"]))
  })

  test("integrate agent dispatched with kept worktrees", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const integrate = calls.find((c) => c.opts?.label === "integrate")
    expect(integrate).toBeDefined()
    expect(integrate!.opts.schema.properties.merged).toBeDefined()
    expect(integrate!.prompt).toContain("_worktree")
  })
})

describe("compose phase 3: TDD loop", () => {
  test("verify passes first try → no debug, no retry", async () => {
    let implCalls = 0
    let verifyCalls = 0
    let debugCalls = 0
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.label && String(opts.label).startsWith("implement")) { implCalls++; return { _worktree: { branch: "b", directory: "/d", changed: true } } }
      if (opts?.schema?.properties?.allPassed) { verifyCalls++; return { typecheck: "ok", tests: { passed: 5, failed: 0 }, build: "ok", allPassed: true } }
      if (opts?.label === "debug") debugCalls++
      return happyAgent(prompt, opts)
    })
    expect(implCalls).toBe(1)
    expect(verifyCalls).toBe(1)
    expect(debugCalls).toBe(0)
    expect(result).not.toMatchObject({ error: "verify-exhausted" })
  })

  test("verify fails 3 times → returns verify-exhausted with history", async () => {
    let verifyCalls = 0
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.allPassed) { verifyCalls++; return { typecheck: "fail", tests: { passed: 0, failed: 1 }, build: "skipped", allPassed: false, failures: "tc#" + verifyCalls } }
      return happyAgent(prompt, opts)
    })
    expect(verifyCalls).toBe(3)
    expect(result).toMatchObject({ error: "verify-exhausted", attempts: 3 })
    expect((result as any).verifyHistory).toHaveLength(3)
  })

  test("verify fails twice then passes → 3 verifies + 2 debugs", async () => {
    let verifyCalls = 0
    let debugCalls = 0
    await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.allPassed) {
        verifyCalls++
        return verifyCalls >= 3
          ? { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
          : { typecheck: "fail", tests: { passed: 0, failed: 1 }, build: "skipped", allPassed: false, failures: "x" }
      }
      if (opts?.label === "debug") debugCalls++
      return happyAgent(prompt, opts)
    })
    expect(verifyCalls).toBe(3)
    expect(debugCalls).toBe(2)
  })

  test("one successful iteration writes one iteration-report", async () => {
    let reportCalls = 0
    await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.iteration) { reportCalls++; return { iteration: 1, what_changed: "x" } }
      return happyAgent(prompt, opts)
    })
    expect(reportCalls).toBe(1)
  })
})

describe("compose phases 4-5: Review + Fix loop", () => {
  test("review with no critical → no fix loop, proceeds to merge", async () => {
    let fixCalls = 0
    let reviewCalls = 0
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.readyToMerge) { reviewCalls++; return { critical: [], important: ["nit"], minor: [], readyToMerge: true } }
      if (opts?.label && String(opts.label).startsWith("fix")) fixCalls++
      return happyAgent(prompt, opts)
    })
    expect(reviewCalls).toBe(1)
    expect(fixCalls).toBe(0)
    expect(result).not.toMatchObject({ readyToMerge: false })
  })

  test("review critical, fix succeeds on iteration 1 → exits loop, merges", async () => {
    let reviewCalls = 0
    const { result, calls } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.readyToMerge) {
        reviewCalls++
        return reviewCalls === 1
          ? { critical: ["bug X"], important: [], minor: [], readyToMerge: false }
          : { critical: [], important: [], minor: [], readyToMerge: true }
      }
      return happyAgent(prompt, opts)
    })
    expect(reviewCalls).toBe(2)
    const fixCall = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("fix:"))
    expect(fixCall!.opts.isolation).toBe("worktree")
    expect(result).not.toMatchObject({ readyToMerge: false })
  })

  test("review critical persists through 2 fix iterations → readyToMerge:false", async () => {
    let reviewCalls = 0
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.readyToMerge) { reviewCalls++; return { critical: ["unfixable"], important: [], minor: [], readyToMerge: false } }
      return happyAgent(prompt, opts)
    })
    expect(reviewCalls).toBe(3)
    expect(result).toMatchObject({ readyToMerge: false })
    expect((result as any).review.critical).toContain("unfixable")
  })
})

describe("compose phase 6: Final report", () => {
  test("final-report agent runs before merge", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const finalIdx = calls.findIndex((c) => c.opts?.label === "final-report")
    const mergeIdx = calls.findIndex((c) => c.opts?.label === "merge")
    expect(finalIdx).toBeGreaterThanOrEqual(0)
    expect(mergeIdx).toBeGreaterThan(finalIdx)
  })

  test("skip_report short-circuits iteration + final report writes", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature", skip_report: true })
    expect(calls.find((c) => c.opts?.schema?.properties?.iteration)).toBeUndefined()
    expect(calls.find((c) => c.opts?.schema?.properties?.path)).toBeUndefined()
  })
})

describe("compose phase 7: Merge + final shape", () => {
  test("happy path returns full shape per [S4]", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" })
    expect(result).toMatchObject({
      type: "feature",
      design: { tasks: expect.any(Array) },
      review: { readyToMerge: true },
      merge: { committed: true, sha: "abc", action: "commit" },
    })
    expect((result as any).brainstorm).toBeDefined()
    expect((result as any).batches).toBeDefined()
    expect((result as any).verifyHistory).toBeDefined()
    expect((result as any).stats).toMatchObject({ agents: expect.any(Number), parallelBatches: expect.any(Number) })
  })

  test("merge failure returns merge-failed", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.committed) return { committed: false, action: "none" }
      return happyAgent(prompt, opts)
    })
    expect(result).toMatchObject({ error: "merge-failed", merge: { committed: false } })
  })
})

describe("compose E2E smoke", () => {
  test("happy path runs phases in order (Brainstorm→Classify→Design→Implement→Verify→Report→Review→Merge)", async () => {
    const { result, phases } = await runCompose({ task: "ship a feature", type: "feature" })
    // First occurrence of each phase, in order. The iteration report (Report) fires
    // inside the TDD loop on a successful verify, before Phase 4 Review (spec [S3] 3f).
    const firstSeen: string[] = []
    for (const p of phases) if (firstSeen.indexOf(p) < 0) firstSeen.push(p)
    expect(firstSeen).toEqual(["Brainstorm", "Classify", "Design", "Implement", "Verify", "Report", "Review", "Merge"])
    expect((result as any).merge?.committed).toBe(true)
  })
})
