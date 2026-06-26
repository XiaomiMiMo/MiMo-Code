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

  test("declares schemas for every structured phase", () => {
    const script = composeScript()
    expect(script).toContain("BRAINSTORM_SHAPE")
    expect(script).toContain("DESIGN_SHAPE")
    expect(script).toContain("INTEGRATE_SHAPE")
    expect(script).toContain("VERIFY_SHAPE")
    expect(script).toContain("REVIEW_SHAPE")
    expect(script).toContain("MERGE_SHAPE")
  })

  test("has no separate Classify phase (type resolved inline)", () => {
    const script = composeScript()
    expect(script).not.toContain('phase("Classify")')
    expect(script).not.toContain("CLASSIFY_SHAPE")
  })

  test("each phase applies its compose skill (verify included)", () => {
    const script = composeScript()
    for (const skill of ["compose:brainstorm", "compose:debug", "compose:feedback", "compose:plan", "compose:tdd", "compose:review", "compose:report", "compose:merge", "compose:verify"]) {
      expect(script).toContain(skill)
    }
  })

  test("design and report phases write files via agent (no output schema)", () => {
    const script = composeScript()
    // The design-write and report agents must NOT use a schema (a schema biases the
    // agent into emitting JSON instead of writing the file). They are dispatched by
    // label and gated by glob (specs/plans) / exists (report).
    expect(script).toContain('label: "design:"')
    expect(script).toContain('label: "design-extract:"')
    expect(script).toContain("glob(SPECS_DIR")
    expect(script).toContain("glob(PLANS_DIR")
    expect(script).toContain("exists(REPORT_PATH)")
    // The extract agent must force a direct StructuredOutput tool call (avoids the
    // prose→retry loop that stalled the Design phase).
    expect(script).toContain("StructuredOutput")
  })
})

// Default agent stub that drives a clean happy path. Implement/fix agents return a
// `_worktree` (changed) so the integrate path is exercised. Design-write and report
// agents have no schema (they write files); the harness's exists() returns true to
// simulate the agent having written them. Override per-test.
const happyAgent = (prompt: string, opts?: any) => {
  const o = opts as any
  if (o?.schema?.properties?.context) return { context: { projectType: "Bun TS", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
  if (o?.schema?.properties?.type) return { type: "feature", confidence: "high", reasoning: "r" }
  if (o?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
  if (o?.schema?.properties?.merged) return { merged: [{ taskId: "t1", branch: "b", sha: "s" }], conflicts: [], skipped_pristine: [] }
  if (o?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
  if (o?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
  if (o?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
  if (o?.label && String(o.label).startsWith("implement")) return { _worktree: { branch: "wt-" + o.label, directory: "/tmp/" + o.label, changed: true } }
  if (o?.label && String(o.label).startsWith("fix")) return { _worktree: { branch: "wt-" + o.label, directory: "/tmp/" + o.label, changed: true } }
  return "ok"
}

const runCompose = async (
  args: unknown,
  agentImpl: (prompt: string, opts?: any) => unknown = happyAgent,
  opts?: { exists?: (p: string) => boolean; globEmpty?: boolean; glob?: (pattern: string) => string[] },
) => {
  const parsed = parseMeta(composeScript())
  if (!parsed.ok) throw new Error(parsed.error)
  const calls: { prompt: string; opts?: any }[] = []
  const phases: string[] = []
  const written: string[] = []
  const existsImpl = opts?.exists ?? (() => true)
  // The design gate globs SPECS_DIR/PLANS_DIR for *.md. By default simulate the
  // agent having written a doc (one match), so the gate passes. globEmpty:true
  // simulates the agent never writing → the gate re-dispatches. A custom glob
  // override simulates pre-existing docs (for amend tests).
  const globImpl = opts?.glob ?? ((pattern: string) => (opts?.globEmpty ? [] : [pattern.replace("*.md", "x.md")]))
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
    writeFile: async (p: unknown) => { written.push(String(p)) },
    exists: async (p: unknown) => existsImpl(String(p)),
    glob: async (p: unknown) => globImpl(String(p)),
  }
  const body = `globalThis.args = ${JSON.stringify(args)};\n` + parsed.body
  const result = await evalScript(body, hooks)
  return { result, calls, phases, written }
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
  test("design-write + report prompts carry the configured docs dir", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature", _composeDocsDir: "custom/docs" })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite!.prompt).toContain("custom/docs/specs")
    expect(designWrite!.prompt).toContain("custom/docs/plans")
    const report = calls.find((c) => c.opts?.label === "final-report")
    expect(report!.prompt).toContain("custom/docs/reports")
  })

  test("defaults to docs/compose when host did not inject", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite!.prompt).toContain("docs/compose/specs")
  })
})

describe("compose docs are written by the AGENT, gated by the workflow", () => {
  test("design dispatches a write agent (no schema) then a structured extract agent", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const write = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    const extract = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design-extract:"))
    expect(write).toBeDefined()
    expect(write!.opts.schema).toBeUndefined() // agent must be free to use write tool
    expect(write!.prompt).toContain("write")
    expect(extract).toBeDefined()
    expect(extract!.opts.schema?.properties?.tasks).toBeDefined() // extraction is structured
  })

  test("when agent skips the write, workflow re-dispatches the design agent (does not write files itself)", async () => {
    let designWrites = 0
    const { written } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.label && String(opts.label).startsWith("design:")) designWrites++
        return happyAgent(prompt, opts)
      },
      { globEmpty: true, exists: () => false }, // simulate: docs never appear
    )
    expect(designWrites).toBe(2) // initial + one re-dispatch
    expect(written).toHaveLength(0) // the WORKFLOW never writes files — only agents do
  })
})

describe("compose type resolution (no Classify phase)", () => {
  test("no classifier agent is ever dispatched", async () => {
    const { calls } = await runCompose({ task: "fix the foo regression" })
    // There must be no classify agent (no agent with a {type,confidence,reasoning} schema).
    expect(calls.find((c) => c.opts?.schema?.properties?.type && c.opts?.schema?.properties?.confidence)).toBeUndefined()
  })

  test("heuristic routes a bug task to compose:debug without an LLM classify call", async () => {
    const { calls } = await runCompose({ task: "fix the foo regression that crashes on startup" })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite!.prompt).toContain("compose:debug")
  })

  test("explicit args.type is honored", async () => {
    const { calls } = await runCompose({ task: "implement bar", type: "feedback" })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite!.prompt).toContain("compose:feedback")
  })

  test("default (no keyword, no args.type) routes to compose:plan", async () => {
    const { calls } = await runCompose({ task: "implement a brand new widget gallery" })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite!.prompt).toContain("compose:plan")
  })
})

describe("compose phase 2: Design", () => {
  test.each([
    ["feature", "compose:plan"],
    ["refactor", "compose:plan"],
    ["bugfix", "compose:debug"],
    ["feedback", "compose:feedback"],
  ])("type=%s routes the design-write agent to %s", async (type, skill) => {
    const { calls } = await runCompose({ task: "x", type }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
      return "ok"
    })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(designWrite).toBeDefined()
    expect(designWrite!.prompt).toContain(skill)
  })

  test("extract returning null surfaces design-failed", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return null // extraction fails
      return "ok"
    })
    expect(result).toMatchObject({ error: "design-failed" })
  })

  test("extract returning a truthy object without a tasks array surfaces design-failed (no crash)", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { notes: "oops, no tasks field" } // truthy but malformed
      return "ok"
    })
    expect(result).toMatchObject({ error: "design-failed" })
  })

  test("tasks with missing/blank ids get backfilled (no implement:undefined label)", async () => {
    const { calls, result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { description: "first", acceptance: "a" },        // no id
        { id: "", description: "second", acceptance: "a" }, // blank id
        { id: "T2", description: "third", acceptance: "a" }, // real id
      ] }
      return happyAgent(prompt, opts)
    })
    // No implement label may contain "undefined".
    const implLabels = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:")).map((c) => String(c.opts.label))
    expect(implLabels.length).toBeGreaterThan(0)
    for (const l of implLabels) expect(l).not.toContain("undefined")
    // Every designed task ends up with a non-empty id.
    for (const t of (result as any).design.tasks) expect(typeof t.id === "string" && t.id.length > 0).toBe(true)
  })
})

describe("compose phase 3: parallelism, dependencies, worktrees", () => {
  test("multiple independent tasks AUTO-isolate (worktree per task), no flag needed", async () => {
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
      if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
      if (opts?.label && String(opts.label).startsWith("implement")) return { _worktree: { branch: "b", directory: "/tmp/d", changed: true } }
      return "ok"
    })
    expect((result as any).batches).toEqual([["T1", "T2", "T3", "T4"]])
    const implCalls = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:"))
    expect(implCalls).toHaveLength(4)
    for (const c of implCalls) expect(c.opts.isolation).toBe("worktree") // auto, no flag
    expect(calls.find((c) => c.opts?.label === "integrate")).toBeDefined()
  })

  test("a single-task batch stays sequential, no isolation, no integrate (auto)", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "T1", description: "d", acceptance: "a", dependsOn: [] }] }
      return happyAgent(prompt, opts)
    })
    const implCalls = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:"))
    expect(implCalls).toHaveLength(1)
    expect(implCalls[0].opts.isolation).toBeUndefined()
    expect(calls.find((c) => c.opts?.label === "integrate")).toBeUndefined()
  })

  test("args.isolate_worktrees:false forces all-sequential, no isolation even for a multi-task batch", async () => {
    let active = 0
    let maxConcurrent = 0
    const agentImpl = async (prompt: string, opts?: any) => {
      if (opts?.label && String(opts.label).startsWith("implement:")) {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return "ok"
      }
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { id: "T1", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T2", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T3", description: "d", acceptance: "a", dependsOn: [] },
      ] }
      return happyAgent(prompt, opts)
    }
    const { calls } = await runCompose({ task: "x", type: "feature", isolate_worktrees: false }, agentImpl)
    const implCalls = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:"))
    for (const c of implCalls) expect(c.opts.isolation).toBeUndefined()
    expect(maxConcurrent).toBe(1) // forced sequential
  })

  test("auto-isolated independent tasks run CONCURRENTLY (worktree per task)", async () => {
    let active = 0
    let maxConcurrent = 0
    const agentImpl = async (prompt: string, opts?: any) => {
      if (opts?.label && String(opts.label).startsWith("implement:")) {
        active++
        maxConcurrent = Math.max(maxConcurrent, active)
        await new Promise((r) => setTimeout(r, 5))
        active--
        return { _worktree: { branch: "b", directory: "/tmp/d", changed: true } }
      }
      if (opts?.schema?.properties?.context) return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [] }
      if (opts?.schema?.properties?.tasks) return { tasks: [
        { id: "T1", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T2", description: "d", acceptance: "a", dependsOn: [] },
        { id: "T3", description: "d", acceptance: "a", dependsOn: [] },
      ] }
      return happyAgent(prompt, opts)
    }
    await runCompose({ task: "x", type: "feature" }, agentImpl) // no flag — auto
    expect(maxConcurrent).toBeGreaterThan(1)
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

  test("integrate agent dispatched with kept worktrees when isolated", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature", isolate_worktrees: true })
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

  test("one successful iteration writes one iteration-report (agent dispatched by label, no schema)", async () => {
    let reportCalls = 0
    const { calls } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.label && String(opts.label).startsWith("iteration-report:")) reportCalls++
      return happyAgent(prompt, opts)
    })
    expect(reportCalls).toBe(1)
    const ir = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("iteration-report:"))
    expect(ir!.opts.schema).toBeUndefined() // report agent writes a file, not JSON
    expect(ir!.prompt).toContain("write")
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
    const { result, calls } = await runCompose({ task: "x", type: "feature", isolate_worktrees: true }, (prompt, opts) => {
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
    expect(calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("iteration-report:"))).toBeUndefined()
    expect(calls.find((c) => c.opts?.label === "final-report")).toBeUndefined()
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
  test("happy path runs phases in order (Brainstorm→Design→Implement→Verify→Report→Review→Merge)", async () => {
    const { result, phases } = await runCompose({ task: "ship a feature", type: "feature" })
    // First occurrence of each phase, in order. The iteration report (Report) fires
    // inside the TDD loop on a successful verify, before Phase 4 Review (spec [S3] 3f).
    const firstSeen: string[] = []
    for (const p of phases) if (firstSeen.indexOf(p) < 0) firstSeen.push(p)
    expect(firstSeen).toEqual(["Brainstorm", "Design", "Implement", "Verify", "Report", "Review", "Merge"])
    expect((result as any).merge?.committed).toBe(true)
  })
})

describe("compose incremental amend", () => {
  const withExistingDocs = (p: string) =>
    p.includes("/specs") ? ["docs/compose/specs/strutil.md"] : p.includes("/plans") ? ["docs/compose/plans/strutil.md"] : []

  test("brainstorm is given the list of existing compose docs", async () => {
    const { calls } = await runCompose(
      { task: "change the truncate ellipsis to a unicode … in the strutil lib" },
      happyAgent,
      { glob: withExistingDocs },
    )
    const bs = calls.find((c) => c.opts?.label === "brainstorm")
    expect(bs!.prompt).toContain("strutil.md")
    expect(bs!.prompt.toLowerCase()).toContain("existing")
  })

  test("when brainstorm flags an amendment, design-write is told to amend the existing plan", async () => {
    const { calls } = await runCompose(
      { task: "change truncate ellipsis to unicode …" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.context)
          return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [], amends: "strutil", existingDocs: ["docs/compose/plans/strutil.md"] }
        return happyAgent(prompt, opts)
      },
      { glob: withExistingDocs },
    )
    const write = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(write!.prompt).toContain("AMENDMENT")
    expect(write!.prompt).toContain("strutil")
  })

  test("amend: design-extract returning only the changed task drives a single implement", async () => {
    const { calls } = await runCompose(
      { task: "change truncate ellipsis" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.context)
          return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [], amends: "strutil" }
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "T-truncate", description: "update ellipsis", acceptance: "uses …", dependsOn: [] }] }
        return happyAgent(prompt, opts)
      },
      { glob: withExistingDocs },
    )
    const impl = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("implement:"))
    expect(impl).toHaveLength(1)
    // amend reuses existing docs → no redundant second design-write
    const writes = calls.filter((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(writes).toHaveLength(1)
  })

  test("non-amend (empty amends) keeps the normal create-spec/plan prompt", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const write = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))
    expect(write!.prompt).not.toContain("AMENDMENT")
    expect(write!.prompt).toContain("create BOTH of these files")
  })
})

describe("compose amend scope-aware fan-out", () => {
  const existing = (p: string) =>
    p.includes("/plans") ? ["docs/compose/plans/strutil.md"] : p.includes("/specs") ? ["docs/compose/specs/strutil.md"] : []
  const amendAgent = (prompt: string, opts?: any) => {
    if (opts?.schema?.properties?.context)
      return { context: { projectType: "x", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [], amends: "strutil" }
    return happyAgent(prompt, opts)
  }

  test("amend design-write prompt instructs scope assessment + forbids duplicate tasks", async () => {
    const { calls } = await runCompose({ task: "change truncate ellipsis to unicode …" }, amendAgent, { glob: existing })
    const write = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))!
    expect(write.prompt.toLowerCase()).toContain("scope")
    expect(write.prompt.toLowerCase()).toContain("magnitude")
    expect(write.prompt).toMatch(/NEVER emit two near-identical or duplicate tasks/i)
  })

  test("amend extract prompt forbids duplicate/near-identical tasks and sizes to the change", async () => {
    const { calls } = await runCompose({ task: "change truncate ellipsis" }, amendAgent, { glob: existing })
    const extract = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design-extract:"))!
    expect(extract.prompt).toMatch(/SMALLEST set of tasks/i)
    expect(extract.prompt).toMatch(/do NOT return duplicate or near-identical tasks/i)
  })

  test("non-amend design-write has no scope-assessment block", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" })
    const write = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))!
    expect(write.prompt).not.toContain("assess the MAGNITUDE")
  })
})

describe("compose brainstorm robustness", () => {
  test("non-array brainstorm fields (string conventions etc.) do not crash the script", async () => {
    const { result } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context)
        // Malformed: fields that should be arrays come back as strings/undefined.
        return { context: { projectType: "p", conventions: "a, b", recentChanges: undefined, relevantFiles: "x.js" }, assumptions: "none" }
      return happyAgent(prompt, opts)
    })
    // Must reach a normal terminal shape, not throw / reject the script.
    expect(result).toBeDefined()
    expect((result as any).type).toBe("feature")
  })
})

describe("compose phase I/O chaining", () => {
  test("brainstorm prompt self-conducts Socratic Q&A + approaches (autonomous)", () => {
    const s = composeScript()
    expect(s).toContain("self-conduct the dialogue")
    expect(s).toContain("selfQA")
    expect(s).toContain("approaches")
    expect(s).toContain("chosenApproach")
  })

  test("brainstorm is NOT downgraded to lite model anymore", () => {
    const s = composeScript()
    // the brainstorm agent opts must not pin model:"lite"
    expect(s).not.toMatch(/label: "brainstorm"[^}]*model: "lite"/)
  })

  test("implement carries Intent (chosen approach) and TASKS_DIGEST is gone", () => {
    const s = composeScript()
    expect(s).toContain("Intent (from design")
    expect(s).not.toContain("TASKS_DIGEST")
  })

  test("review is two-stage: spec-compliance before code-quality, with git diff", () => {
    const s = composeScript()
    expect(s).toContain("TWO STAGES")
    expect(s).toMatch(/Stage 1 — Spec compliance/i)
    expect(s).toMatch(/Stage 2 — Code quality/i)
    expect(s).toContain("git diff")
  })

  test("merge prompt receives what-was-built + review outcome", () => {
    const s = composeScript()
    expect(s).toContain("What was built")
    expect(s).toContain("Review outcome")
  })

  test("brainstorm self-Q&A reasoning flows into the design prompt at runtime", async () => {
    const { calls } = await runCompose({ task: "x", type: "feature" }, (prompt, opts) => {
      if (opts?.schema?.properties?.context)
        return { context: { projectType: "p", conventions: [], recentChanges: [], relevantFiles: [] }, assumptions: [],
                 approaches: [{ name: "A1", tradeoffs: "fast" }], chosenApproach: "A1", chosenRationale: "simplest" }
      return happyAgent(prompt, opts)
    })
    const designWrite = calls.find((c) => c.opts?.label && String(c.opts.label).startsWith("design:"))!
    expect(designWrite.prompt).toContain("Chosen approach: A1")
    expect(designWrite.prompt).toContain("simplest")
  })
})
