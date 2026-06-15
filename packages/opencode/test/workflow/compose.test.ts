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
    expect(script).toContain("CLASSIFY_SHAPE")
    expect(script).toContain("DESIGN_SHAPE")
    expect(script).toContain("VERIFY_SHAPE")
    expect(script).toContain("REVIEW_SHAPE")
    expect(script).toContain("MERGE_SHAPE")
  })
})

const runCompose = async (args: unknown, agentImpl: (prompt: string, opts?: any) => unknown) => {
  const parsed = parseMeta(composeScript())
  if (!parsed.ok) throw new Error(parsed.error)
  const calls: { prompt: string; opts?: any }[] = []
  const hooks = {
    agent: async (prompt: unknown, opts?: unknown) => {
      const p = String(prompt)
      const o = opts as any
      calls.push({ prompt: p, opts: o })
      return agentImpl(p, o)
    },
    phase: () => undefined,
    log: () => undefined,
    workflow: async () => null,
    readFile: async () => null,
    writeFile: async () => undefined,
    exists: async () => false,
    glob: async () => [],
  }
  // The sandbox exposes args via globalThis.args; inject by prepending a global.
  const body = `globalThis.args = ${JSON.stringify(args)};\n` + parsed.body
  const result = await evalScript(body, hooks)
  return { result, calls }
}

describe("compose phase 1: Classify", () => {
  test("calls classifier when args.type absent", async () => {
    const { calls } = await runCompose(
      { task: "fix the foo regression" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.type) {
          return { type: "bugfix", confidence: "high", reasoning: "regression keyword" }
        }
        return null
      },
    )
    const classifyCall = calls.find((c) => c.opts?.schema?.properties?.type)
    expect(classifyCall).toBeDefined()
    expect(classifyCall!.prompt).toContain("fix the foo regression")
  })

  test("skips classifier when args.type provided", async () => {
    const { calls } = await runCompose(
      { task: "implement bar", type: "feature" },
      () => null,
    )
    const classifyCall = calls.find((c) => c.opts?.schema?.properties?.type)
    expect(classifyCall).toBeUndefined()
  })
})

describe("compose phase 2: Design", () => {
  test.each([
    ["feature", "compose:plan"],
    ["refactor", "compose:plan"],
    ["bugfix", "compose:debug"],
    ["feedback", "compose:feedback"],
  ])("type=%s routes to %s", async (type, skill) => {
    const { calls } = await runCompose(
      { task: "x", type },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) {
          return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        }
        return null
      },
    )
    const designCall = calls.find((c) => c.opts?.schema?.properties?.tasks)
    expect(designCall).toBeDefined()
    expect(designCall!.prompt).toContain(skill)
  })

  test("design returning null surfaces design-failed", async () => {
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      () => null,
    )
    expect(result).toMatchObject({ error: "design-failed" })
  })
})

describe("compose phase 3: TDD loop", () => {
  test("verify passes first try → no debug, no retry", async () => {
    let implCalls = 0
    let verifyCalls = 0
    let debugCalls = 0
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) {
          verifyCalls++
          return { typecheck: "ok", tests: { passed: 5, failed: 0 }, build: "ok", allPassed: true }
        }
        if (opts?.label === "implement") implCalls++
        if (opts?.label?.startsWith("debug")) debugCalls++
        if (opts?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
        if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
        return "ok"
      },
    )
    expect(implCalls).toBe(1)
    expect(verifyCalls).toBe(1)
    expect(debugCalls).toBe(0)
    expect(result).not.toMatchObject({ error: "verify-exhausted" })
  })

  test("verify fails 3 times → returns verify-exhausted with history", async () => {
    let verifyCalls = 0
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) {
          verifyCalls++
          return { typecheck: "fail", tests: { passed: 0, failed: 1 }, build: "skipped", allPassed: false, failures: "tc#" + verifyCalls }
        }
        return "ok"
      },
    )
    expect(verifyCalls).toBe(3)
    expect(result).toMatchObject({ error: "verify-exhausted", attempts: 3 })
    expect((result as any).verifyHistory).toHaveLength(3)
  })

  test("verify fails twice then passes → loop runs 3 impls + 3 verifies + 2 debugs", async () => {
    let verifyCalls = 0
    let implCalls = 0
    let debugCalls = 0
    await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) {
          verifyCalls++
          return verifyCalls >= 3
            ? { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
            : { typecheck: "fail", tests: { passed: 0, failed: 1 }, build: "skipped", allPassed: false, failures: "x" }
        }
        if (opts?.label === "implement") implCalls++
        if (opts?.label?.startsWith("debug")) debugCalls++
        if (opts?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
        if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
        return "ok"
      },
    )
    expect(implCalls).toBe(3)
    expect(verifyCalls).toBe(3)
    expect(debugCalls).toBe(2)
  })
})

describe("compose phases 4-5: Review + Fix loop", () => {
  test("review with no critical → no fix loop, proceeds to merge", async () => {
    let fixCalls = 0
    let reviewCalls = 0
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
        if (opts?.schema?.properties?.readyToMerge) {
          reviewCalls++
          return { critical: [], important: ["nit"], minor: [], readyToMerge: true }
        }
        if (opts?.label === "fix") fixCalls++
        if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
        return "ok"
      },
    )
    expect(reviewCalls).toBe(1)
    expect(fixCalls).toBe(0)
    expect(result).not.toMatchObject({ readyToMerge: false })
  })

  test("review critical, fix succeeds on iteration 1 → exits loop, merges", async () => {
    let reviewCalls = 0
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
        if (opts?.schema?.properties?.readyToMerge) {
          reviewCalls++
          return reviewCalls === 1
            ? { critical: ["bug X"], important: [], minor: [], readyToMerge: false }
            : { critical: [], important: [], minor: [], readyToMerge: true }
        }
        if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc", action: "commit" }
        return "ok"
      },
    )
    expect(reviewCalls).toBe(2)
    expect(result).not.toMatchObject({ readyToMerge: false })
  })

  test("review critical persists through 2 fix iterations → readyToMerge:false", async () => {
    let reviewCalls = 0
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
        if (opts?.schema?.properties?.readyToMerge) {
          reviewCalls++
          return { critical: ["unfixable"], important: [], minor: [], readyToMerge: false }
        }
        return "ok"
      },
    )
    expect(reviewCalls).toBe(3) // initial + 2 fix-loop reviews
    expect(result).toMatchObject({ readyToMerge: false })
    expect((result as any).review.critical).toContain("unfixable")
  })
})

describe("compose phase 6: Merge + final shape", () => {
  test("happy path returns full shape per [S4]", async () => {
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
        if (opts?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
        if (opts?.schema?.properties?.committed) return { committed: true, sha: "abc1234", action: "commit", prUrl: undefined }
        return "ok"
      },
    )
    expect(result).toMatchObject({
      type: "feature",
      design: { tasks: expect.any(Array) },
      review: { readyToMerge: true },
      merge: { committed: true, sha: "abc1234", action: "commit" },
    })
    expect((result as any).verifyHistory).toBeDefined()
    expect((result as any).stats).toMatchObject({ agents: expect.any(Number), durationMs: expect.any(Number) })
  })

  test("merge failure returns merge-failed", async () => {
    const { result } = await runCompose(
      { task: "x", type: "feature" },
      (prompt, opts) => {
        if (opts?.schema?.properties?.tasks) return { tasks: [{ id: "t1", description: "d", acceptance: "a" }] }
        if (opts?.schema?.properties?.allPassed) return { typecheck: "ok", tests: { passed: 1, failed: 0 }, build: "ok", allPassed: true }
        if (opts?.schema?.properties?.readyToMerge) return { critical: [], important: [], minor: [], readyToMerge: true }
        if (opts?.schema?.properties?.committed) return { committed: false, action: "none" }
        return "ok"
      },
    )
    expect(result).toMatchObject({ error: "merge-failed", merge: { committed: false } })
  })
})
