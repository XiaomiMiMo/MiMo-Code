import { beforeEach, describe, expect, test } from "bun:test"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import {
  TryBestMonitor,
  jaccard,
  monitor,
  normalizeCommand,
  normalizeDiff,
  normalizeResult,
  resetAllMonitors,
  shingleSet,
} from "../../src/session/try-best-detector"

beforeEach(() => {
  resetAllMonitors()
})

function tool(input: {
  tool: string
  args: Record<string, unknown>
  status?: "completed" | "error"
  metadata?: Record<string, unknown>
  output?: string
  error?: string
}) {
  const status = input.status ?? "completed"
  return MessageV2.ToolPart.parse({
    id: PartID.ascending(),
    messageID: MessageID.ascending(),
    sessionID: SessionID.descending(),
    type: "tool",
    tool: input.tool,
    callID: crypto.randomUUID(),
    state:
      status === "completed"
        ? {
            status,
            input: input.args,
            output: input.output ?? "ok",
            title: input.tool,
            metadata: input.metadata ?? {},
            time: { start: 1, end: 2 },
          }
        : {
            status,
            input: input.args,
            error: input.error ?? "failed",
            metadata: input.metadata,
            time: { start: 1, end: 2 },
          },
  })
}

function edit(file: string, diff: string) {
  return tool({ tool: "edit", args: { file_path: file }, metadata: { diff } })
}

describe("try-best normalization", () => {
  test("normalizes diff structure and ignores context", () => {
    expect(normalizeDiff("@@ -1,3 +1,3 @@\n keep\n-old   value\n+new value\n context")).toBe("- old value + new value")
  })

  test("normalizes volatile command and result values", () => {
    expect(normalizeCommand("bun test /tmp/run-123 --seed 12345   --pid 1234567")).toBe(
      "bun test <TMP> <SEED> --pid <NUM>",
    )
    expect(normalizeResult("failed in 12.5s at /private/tmp/run-1/out 1234567")).toBe("failed in <TIME> at <TMP> <NUM>")
  })

  test("preserves both ends of long results", () => {
    const result = normalizeResult(`failure at start ${"x".repeat(2100)} final stack frame`)
    expect(result).toStartWith("failure at start")
    expect(result).toEndWith("final stack frame")
    expect(result).toContain("<TRUNCATED>")
    expect(result).toHaveLength(2000)
  })

  test("computes shingle jaccard", () => {
    expect(jaccard(shingleSet("a b c d"), shingleSet("a b c e"))).toBeCloseTo(1 / 3)
  })
})

describe("TryBestMonitor", () => {
  test("detects the third near-identical edit to one file", () => {
    const monitor = new TryBestMonitor()
    expect(monitor.consume(edit("src/a.ts", "@@ -1 +1 @@\n-const value = 1\n+const value = 2"))).toBeUndefined()
    expect(monitor.consume(edit("src/a.ts", "@@ -2 +2 @@\n-const value = 1\n+const value = 2"))).toBeUndefined()
    expect(monitor.consume(edit("src/a.ts", "@@ -3 +3 @@\n-const value = 1\n+const value = 2"))?.reason).toBe(
      "edit_repeat",
    )
  })

  test("does not compare edits from different files", () => {
    const monitor = new TryBestMonitor()
    expect(monitor.consume(edit("src/a.ts", "-old value here\n+new value here"))).toBeUndefined()
    expect(monitor.consume(edit("src/b.ts", "-old value here\n+new value here"))).toBeUndefined()
    expect(monitor.consume(edit("src/c.ts", "-old value here\n+new value here"))).toBeUndefined()
  })

  test("detects identical failed bash retry without an edit", () => {
    const monitor = new TryBestMonitor()
    const failed = () => tool({ tool: "bash", args: { command: "bun test --seed 123" }, status: "error" })
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(failed())).toMatchObject({ reason: "bash_retry", evidence: { count: 3 } })
  })

  test("continues tracking action streaks when a bash retry is detected", () => {
    const monitor = new TryBestMonitor()
    const failed = (command: string) => tool({ tool: "bash", args: { command }, status: "error" })
    expect(monitor.consume(failed("bun test a"))).toBeUndefined()
    expect(monitor.consume(failed("bun test a"))).toBeUndefined()
    expect(monitor.consume(failed("bun test a"))?.reason).toBe("bash_retry")
    expect(monitor.consume(failed("bun test b"))?.reason).toBe("action_streak")
  })

  test("updates options on a cached session monitor", () => {
    const cached = monitor("session", "agent", { action_streak: 4 })
    expect(cached.consume(edit("a", "-one old\n+one new"))).toBeUndefined()
    expect(cached.consume(edit("b", "-two old\n+two new"))).toBeUndefined()
    const configured = monitor("session", "agent", { action_streak: 3 })
    expect(configured).toBe(cached)
    expect(configured.consume(edit("c", "-three old\n+three new"))?.reason).toBe("action_streak")
  })

  test("treats a completed bash tool with nonzero exit metadata as failed", () => {
    const monitor = new TryBestMonitor()
    const failed = () =>
      tool({ tool: "bash", args: { command: "bun test" }, metadata: { exit: 1 }, output: "tests failed" })
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(failed())?.reason).toBe("bash_retry")
  })

  test("successful edit clears failed bash retry", () => {
    const monitor = new TryBestMonitor()
    const failed = () => tool({ tool: "bash", args: { command: "bun test" }, status: "error" })
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(edit("src/a.ts", "-before line\n+after line"))).toBeUndefined()
    expect(monitor.consume(failed())).toBeUndefined()
    expect(monitor.consume(failed())).toBeUndefined()
  })

  test("detects four edits even when their diffs differ", () => {
    const monitor = new TryBestMonitor()
    expect(monitor.consume(edit("a", "-one old\n+one new"))).toBeUndefined()
    expect(monitor.consume(edit("b", "-two old\n+two new"))).toBeUndefined()
    expect(monitor.consume(edit("c", "-three old\n+three new"))).toBeUndefined()
    expect(monitor.consume(edit("d", "-four old\n+four new"))?.reason).toBe("action_streak")
  })

  test("ignores read/search actions while counting edit structure", () => {
    const monitor = new TryBestMonitor()
    expect(monitor.consume(edit("a", "-one old\n+one new"))).toBeUndefined()
    expect(monitor.consume(tool({ tool: "read", args: { file_path: "a" } }))).toBeUndefined()
    expect(monitor.consume(edit("b", "-two old\n+two new"))).toBeUndefined()
    expect(monitor.consume(tool({ tool: "grep", args: { pattern: "x" } }))).toBeUndefined()
    expect(monitor.consume(edit("c", "-three old\n+three new"))).toBeUndefined()
    expect(monitor.consume(edit("d", "-four old\n+four new"))?.reason).toBe("action_streak")
  })

  test("changed verify result counts as progress", () => {
    const monitor = new TryBestMonitor()
    const verify = (error: string) => tool({ tool: "bash", args: { command: "bun test" }, status: "error", error })
    expect(monitor.consume(verify("three failures"))).toBeUndefined()
    expect(monitor.consume(verify("two failures"))).toBeUndefined()
    expect(monitor.consume(verify("one failure"))).toBeUndefined()
    expect(monitor.consume(verify("different failure"))).toBeUndefined()
  })
})
