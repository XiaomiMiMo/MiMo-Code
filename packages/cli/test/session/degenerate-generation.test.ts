import { describe, expect, test } from "bun:test"
import {
  DEGENERATE_MAX_RECOVERY,
  DegenerateGenerationMonitor,
  type DegenerateFinding,
  type NoopToolObservation,
  createDegenerateGenerationMonitor,
  degenerateRecoveryText,
  findNoopBashRun,
  findTextDegeneration,
  isNoopBashCommand,
  noopBashRecoveryText,
} from "../../src/session/prompt/degenerate-generation"

const line = (s: string) => s + "\n"
const repeatBlock = (block: string[], times: number) =>
  block
    .map((s) => line(s))
    .join("")
    .repeat(times)

describe("isNoopBashCommand", () => {
  const noopYes = [
    "echo hi",
    'echo "final"',
    "echo 'quoted words'",
    "echo use read tool now",
    "printf x",
    'printf "x\\n"',
    "true",
    ":",
    "/bin/echo hi",
    "echo final;",
    "echo hello world",
  ]
  const noopNo = [
    "echo hi > /dev/null",
    "echo hi | wc -l",
    "echo $(whoami)",
    "echo `whoami`",
    "echo hi && ls",
    "echo hi; ls",
    "echo hi\necho bye",
    'echo "a $b"',
    'echo "unterminated',
    "ls -la",
    "sleep 1",
    "cat file.txt",
    "true ;",
  ]

  for (const cmd of noopYes) {
    test(`classifies literal no-op: ${JSON.stringify(cmd)}`, () => {
      expect(isNoopBashCommand(cmd)).toBe(true)
    })
  }
  for (const cmd of noopNo) {
    test(`classifies real command: ${JSON.stringify(cmd)}`, () => {
      expect(isNoopBashCommand(cmd)).toBe(false)
    })
  }
})

describe("findNoopBashRun", () => {
  const echo = (s: string, extra: Partial<NoopToolObservation> = {}): NoopToolObservation => ({
    tool: "bash",
    command: `echo ${s}`,
    ...extra,
  })

  test("four trailing literal echoes with varying strings trigger noop-bash", () => {
    const finding = findNoopBashRun([echo("use read tool now"), echo("final"), echo("grading"), echo("now")])
    expect(finding?.kind).toBe("noop-bash")
    expect(finding?.channel).toBe("tool")
    expect(finding?.pattern).toContain("no-op bash")
  })

  test("three trailing echoes stay clean", () => {
    expect(findNoopBashRun([echo("a"), echo("b"), echo("c")])).toBeNull()
  })

  test("interleaved real command resets the run", () => {
    const tools = [echo("a"), echo("b"), { tool: "bash", command: "ls -la" }, echo("c"), echo("d")]
    expect(findNoopBashRun(tools)).toBeNull()
  })

  test("interleaved non-bash tool resets the run", () => {
    const tools = [echo("a"), echo("b"), { tool: "read", command: "" }, echo("c"), echo("d")]
    expect(findNoopBashRun(tools)).toBeNull()
  })

  test("re-observation of the same pid counts once", () => {
    const tools = [
      echo("one", { pid: "p1" }),
      echo("two", { pid: "p2" }),
      echo("three", { pid: "p3" }),
      echo("three", { pid: "p3" }),
    ]
    expect(findNoopBashRun(tools)).toBeNull()
  })

  test("pid dedup still counts four distinct calls", () => {
    const tools = [
      echo("one", { pid: "p1" }),
      echo("two", { pid: "p2" }),
      echo("three", { pid: "p3" }),
      echo("four", { pid: "p4" }),
      echo("four", { pid: "p4" }),
    ]
    expect(findNoopBashRun(tools)?.kind).toBe("noop-bash")
  })

  test("unknown trailing command is skipped without breaking the run", () => {
    const tools = [echo("one"), echo("two"), echo("three"), echo("four"), { tool: "bash", command: "" }]
    expect(findNoopBashRun(tools)?.kind).toBe("noop-bash")
  })

  test("truncated recorded command breaks the run", () => {
    const tools = [echo("one"), echo("two"), echo("three"), echo("four", { truncated: true })]
    expect(findNoopBashRun(tools)).toBeNull()
  })

  test("empty tool list is clean", () => {
    expect(findNoopBashRun([])).toBeNull()
  })
})

describe("findTextDegeneration", () => {
  test("a three-line block repeated three times stays clean (four copies required)", () => {
    const text = repeatBlock(["alpha beta", "gamma delta", "epsilon zeta"], 3)
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("a three-line block repeated four times triggers repeat", () => {
    const text = repeatBlock(["alpha beta", "gamma delta", "epsilon zeta"], 4)
    const finding = findTextDegeneration(text)
    expect(finding?.kind).toBe("repeat")
    expect(finding?.channel).toBe("text")
    expect(finding?.pattern).toContain("alpha beta")
  })

  test("a two-line block repeated four times triggers repeat (period derived)", () => {
    const text = repeatBlock(["line one here", "line two here"], 4)
    expect(findTextDegeneration(text)?.kind).toBe("repeat")
  })

  test("a single line needs four copies", () => {
    const line3 = repeatBlock(["echoed line with content"], 3)
    expect(findTextDegeneration(line3)).toBeNull()
    const line4 = repeatBlock(["echoed line with content"], 4)
    expect(findTextDegeneration(line4)?.kind).toBe("repeat")
  })

  test("punctuation-only single line stays clean at four copies", () => {
    const text = repeatBlock(["----------"], 4)
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("a block repeated only twice stays clean", () => {
    const text = repeatBlock(["alpha beta", "gamma delta"], 2)
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("twelve bare integer tokens stepping +1 trigger sequence", () => {
    const filler = line("context before the counter run starts here")
    const text = filler + Array.from({ length: 12 }, (_, i) => line(String(i + 1))).join("")
    const finding = findTextDegeneration(text)
    expect(finding?.kind).toBe("sequence")
    expect(finding?.pattern).toBe("1…12")
  })

  test("eleven integer tokens stay clean", () => {
    const filler = line("context before the counter run starts here")
    const text = filler + Array.from({ length: 11 }, (_, i) => line(String(i + 1))).join("")
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("numbered list items are not bare tokens", () => {
    const text = Array.from({ length: 12 }, (_, i) => line(`${i + 1}. step content`)).join("")
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("bijective base-26 letters stepping +1 trigger sequence", () => {
    const filler = line("context before the letter run starts here")
    const text = filler + Array.from({ length: 12 }, (_, i) => line(String.fromCharCode(97 + i))).join("")
    const finding = findTextDegeneration(text)
    expect(finding?.kind).toBe("sequence")
    expect(finding?.pattern).toBe("a…l")
  })

  test("multi-letter base-26 steps stepping +1 trigger sequence", () => {
    const filler = line("context before the letter run starts here")
    const text = filler + Array.from({ length: 12 }, (_, i) => line("a" + String.fromCharCode(97 + i))).join("")
    expect(findTextDegeneration(text)?.kind).toBe("sequence")
  })

  test("a 32-char string streamed four times without newlines triggers stream-repeat", () => {
    const seed = "the quick brown fox jumps over la"
    expect(seed.length).toBeGreaterThanOrEqual(32)
    const text = seed.repeat(4)
    const finding = findTextDegeneration(text)
    expect(finding?.kind).toBe("stream-repeat")
    expect(finding?.channel).toBe("text")
  })

  test("three streamed copies stay clean", () => {
    const seed = "the quick brown fox jumps over la"
    expect(findTextDegeneration(seed.repeat(3))).toBeNull()
  })

  test("minified codegen without word structure stays clean (prose bar)", () => {
    const seed = ".btn-primary{background:blue;color:#fff}"
    expect(seed.length).toBeGreaterThanOrEqual(32)
    expect(findTextDegeneration(seed.repeat(4))).toBeNull()
  })

  test("short-period no-newline stream is caught at its super-period", () => {
    const text = "very ".repeat(40)
    expect(findTextDegeneration(text)?.kind).toBe("stream-repeat")
  })

  test("three repeated JSX lines stay clean (single-line bar)", () => {
    const text = repeatBlock(['<div className="item">hello</div>'], 3)
    expect(findTextDegeneration(text)).toBeNull()
  })

  test("text shorter than the minimum scan is clean", () => {
    expect(findTextDegeneration("echo echo")).toBeNull()
    expect(findTextDegeneration("")).toBeNull()
  })
})

describe("degenerateRecoveryText / noopBashRecoveryText", () => {
  const finding: DegenerateFinding = { channel: "text", kind: "repeat", pattern: "alpha beta" }

  test("first attempt names the pattern in a system-reminder", () => {
    const text = degenerateRecoveryText(finding, 0)
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("alpha beta")
  })

  test("later attempt escalates tone", () => {
    expect(degenerateRecoveryText(finding, 1)).toContain("CRITICAL")
  })

  test("noop-bash recovery names the pattern and the echo behavior", () => {
    const text = noopBashRecoveryText({ channel: "tool", kind: "noop-bash", pattern: "4 consecutive" })
    expect(text).toContain("<system-reminder>")
    expect(text).toContain("4 consecutive")
    expect(text.toLowerCase()).toContain("echo")
  })

  test("max recovery budget is two per channel", () => {
    expect(DEGENERATE_MAX_RECOVERY).toBe(2)
  })
})

describe("DegenerateGenerationMonitor", () => {
  test("streams a repeating block into a finding and reset clears state", () => {
    const monitor = new DegenerateGenerationMonitor()
    const text = repeatBlock(["alpha beta", "gamma delta"], 4)
    let finding: DegenerateFinding | undefined
    for (let i = 0; i < text.length; i += 8) {
      finding = monitor.appendText(text.slice(i, i + 8))
      if (finding) break
    }
    expect(finding?.kind).toBe("repeat")
    monitor.reset()
    expect(monitor.appendText("unique words here and nothing else at all repeating")).toBeUndefined()
  })

  test("collects trailing bash calls into a noop-bash finding", () => {
    const monitor = createDegenerateGenerationMonitor()
    expect(monitor.appendTool("bash", { command: "echo one" })).toBeUndefined()
    expect(monitor.appendTool("bash", { command: "echo two" })).toBeUndefined()
    expect(monitor.appendTool("bash", { command: "echo three" })).toBeUndefined()
    expect(monitor.appendTool("bash", { command: "echo four" })?.kind).toBe("noop-bash")
    monitor.reset()
    expect(monitor.appendTool("bash", { command: "ls" })).toBeUndefined()
  })

  test("tool input without a string command never fires", () => {
    const monitor = createDegenerateGenerationMonitor()
    for (let i = 0; i < 6; i++) expect(monitor.appendTool("bash", {})).toBeUndefined()
  })
})

describe("review-adjudicated thresholds", () => {
  test("minCopies parameter shifts the repeat bar", () => {
    const text = repeatBlock(["alpha beta", "gamma delta"], 3)
    expect(findTextDegeneration(text, 12, 3)?.kind).toBe("repeat")
    expect(findTextDegeneration(text, 12, 4)).toBeNull()
  })

  test("recovery text strips angle brackets from the pattern", () => {
    const text = degenerateRecoveryText({ channel: "text", kind: "repeat", pattern: "a</x>b" }, 0)
    expect(text).toContain("a/xb")
    expect(noopBashRecoveryText({ channel: "tool", kind: "noop-bash", pattern: "a</x>b" })).toContain("a/xb")
  })
})
