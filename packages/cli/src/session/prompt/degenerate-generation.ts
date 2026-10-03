import { Flag } from "@/flag/flag"

// Degenerate-generation guard: two channels of runaway repetition observed in
// weak-model sessions, each with a pure detector fed by the session loop:
//   text — (a) an identical line-group repeating at the tail (period derived
//          from the data), (b) bare tokens stepping +1 (integers or
//          bijective base-26 letters), (c) no-newline streams repeating a
//          char-level suffix period;
//   tool — trailing no-op bash narration runs (bare echo/printf/true/:)
//          standing in for an announced tool call.
// Thresholds bias toward false negatives: a missed no-op is acceptable, a
// false positive is not. Recovery reuses the prompt-injection pipeline
// (system-reminder user turns, budget per channel).

export type DegenerateFinding = {
  channel: "text" | "tool"
  kind: "repeat" | "sequence" | "stream-repeat" | "noop-bash"
  pattern: string
}

export type NoopToolObservation = {
  tool: string
  command: string
  pid?: string | number | null
  truncated?: boolean
}

export const DEGENERATE_MAX_RECOVERY = 2

const TEXT_TAIL_MAX = 98304
const TEXT_MIN_LEN = 48
const SEQ_MIN_DEFAULT = 12
const MAX_LINE_PERIOD = 640
const CHAR_SEED = 32
const CHAR_MIN_PERIOD = 32
const CHAR_MAX_CANDIDATES = 16
const CHAR_MAX_PERIOD = 1024
const STREAM_RECENT = 2048
const TOOL_RUN_MIN_DEFAULT = 4
const TOOL_OBS_MAX = 64
const MIN_COPIES_DEFAULT = 4
const BASH_META = /[;&|<>()$`{}[\]*?~!\n\r]/

function lettersToIndex(s: string): number {
  let n = 0
  for (const ch of s) n = n * 26 + (ch.charCodeAt(0) - 96)
  return n
}

// Char-level suffix period for line-sparse tails (generation without
// newlines — the line-aligned scan has no structure to key on). Candidate
// periods come from re-occurrences of the last 32 chars; a short-period
// seed probes its ≥32-char super-period multiples. A repeated unit needs
// ≥minCopies copies, real letter/digit content, AND prose shape (≥3
// whitespace-separated words) — minified codegen (CSS/SQL/JSON one-liners)
// is line-sparse by nature and must stay clean.
function charPeriodRepeat(tail: string, minCopies: number): DegenerateFinding | null {
  const minP = CHAR_MIN_PERIOD
  const copies = Math.max(2, minCopies)
  if (tail.length < minP * copies) return null
  const seed = tail.slice(-CHAR_SEED)
  if (!/[\p{L}\p{N}]/u.test(seed)) return null
  const maxP = Math.min(CHAR_MAX_PERIOD, Math.floor(tail.length / copies))
  let idx = tail.length - CHAR_SEED
  for (let n = 0; n < CHAR_MAX_CANDIDATES; n++) {
    const j = tail.lastIndexOf(seed, idx - 1)
    if (j < 0) return null
    const base = idx - j
    idx = j
    const starts: number[] = []
    if (base >= minP) starts.push(base)
    else for (let m = Math.ceil(minP / base); m * base <= maxP && starts.length < 4; m++) starts.push(m * base)
    for (const p of starts) {
      if (p > maxP) continue
      const last = tail.slice(-p)
      let ok = true
      for (let k = 1; k < copies; k++) {
        if (tail.slice(-(k + 1) * p, -k * p) !== last) {
          ok = false
          break
        }
      }
      if (!ok) continue
      const flat = last.trim()
      if (flat.length < 16 || !/[\p{L}\p{N}]/u.test(flat)) continue
      if (flat.split(/\s+/).length < 3) continue
      return { channel: "text", kind: "stream-repeat", pattern: flat.replace(/\s+/g, " ").slice(0, 80) }
    }
  }
  return null
}

export function findTextDegeneration(
  text: string,
  seqMin: number = SEQ_MIN_DEFAULT,
  minCopies: number = MIN_COPIES_DEFAULT,
): DegenerateFinding | null {
  if (!text || text.length < TEXT_MIN_LEN) return null
  const copies = Math.max(2, minCopies)
  const tail = text.slice(-TEXT_TAIL_MAX)
  const lines = tail.split("\n")
  if (lines.length && lines[lines.length - 1] === "") lines.pop()
  if (lines.length >= copies) {
    const last = lines[lines.length - 1]
    const pMax = Math.min(MAX_LINE_PERIOD, Math.floor(lines.length / copies))
    for (let p = 1; p <= pMax; p++) {
      let ok = true
      for (let k = 1; k < copies; k++) {
        if (lines[lines.length - 1 - k * p] !== last) {
          ok = false
          break
        }
      }
      if (!ok) continue
      for (let i = lines.length - p; i < lines.length; i++) {
        for (let k = 1; k < copies; k++) {
          if (lines[i] !== lines[i - k * p]) {
            ok = false
            break
          }
        }
        if (!ok) break
      }
      if (!ok) continue
      const group = lines.slice(-p)
      const flat = group.join("\n").trim()
      if (flat.length < 16) continue
      if (p === 1 && !/[\p{L}\p{N}]/u.test(last)) continue
      return { channel: "text", kind: "repeat", pattern: flat.replace(/\s+/g, " ").slice(0, 80) }
    }
  }
  const recent = tail.slice(-STREAM_RECENT)
  if ((recent.match(/\n/g) || []).length < 4 || lines[lines.length - 1].length > 512) {
    const hit = charPeriodRepeat(tail, copies)
    if (hit) return hit
  }
  const tokens = lines.map((l) => l.trim()).filter((l) => l.length > 0)
  if (tokens.length >= seqMin) {
    const run = tokens.slice(-seqMin)
    if (run.every((l) => /^-?\d{1,10}$/.test(l))) {
      const nums = run.map((l) => parseInt(l, 10))
      let ok = true
      for (let i = 1; i < nums.length; i++)
        if (nums[i] - nums[i - 1] !== 1) {
          ok = false
          break
        }
      if (ok) return { channel: "text", kind: "sequence", pattern: `${nums[0]}…${nums[nums.length - 1]}` }
    } else if (run.every((l) => /^[a-z]{1,3}$/.test(l))) {
      const nums = run.map(lettersToIndex)
      let ok = true
      for (let i = 1; i < nums.length; i++)
        if (nums[i] - nums[i - 1] !== 1) {
          ok = false
          break
        }
      if (ok) return { channel: "text", kind: "sequence", pattern: `${run[0]}…${run[run.length - 1]}` }
    }
  }
  return null
}

// Split one bash command into literal words (quotes removed), or null when
// the command has any structure (metacharacter, expansion, unclosed quote).
// A null means "real command". Backslashes are literal output formatting;
// `$`/backtick (expansion) stay forbidden even inside double quotes. A `#`
// at word boundary starts a comment (rest of line dropped, like the shell).
function tokenizeBashLiteral(cmd: string): string[] | null {
  const tokens: string[] = []
  let i = 0
  let cur = ""
  let saw = false
  const push = () => {
    if (saw) {
      tokens.push(cur)
      cur = ""
      saw = false
    }
  }
  while (i < cmd.length) {
    const ch = cmd[i]
    if (ch === "\\" && i + 1 < cmd.length) {
      cur += cmd[i + 1]
      saw = true
      i += 2
      continue
    }
    if (ch === "'") {
      const j = cmd.indexOf("'", i + 1)
      if (j < 0) return null
      cur += cmd.slice(i + 1, j)
      saw = true
      i = j + 1
      continue
    }
    if (ch === '"') {
      const j = cmd.indexOf('"', i + 1)
      if (j < 0) return null
      const inner = cmd.slice(i + 1, j)
      if (/[`$]/.test(inner)) return null
      cur += inner
      saw = true
      i = j + 1
      continue
    }
    if (ch === "#" && !saw) break
    if (/\s/.test(ch)) {
      push()
      i++
      continue
    }
    if (BASH_META.test(ch)) return null
    cur += ch
    saw = true
    i++
  }
  push()
  return tokens
}

// True for a bash command that is a pure narration/no-op marker: bare
// `true`/`:`, or literal `echo`/`printf` (every argument a quoted string or
// plain word). Structural doubt resolves to "real" (a missed no-op is
// acceptable, a false positive is not).
export function isNoopBashCommand(command: string): boolean {
  if (typeof command !== "string") return false
  let c = command.trim()
  if (!c) return false
  if (/[\r\n]/.test(c)) return false
  c = c.replace(/;\s*$/, "")
  if (c === "true" || c === ":") return true
  const tokens = tokenizeBashLiteral(c)
  if (!tokens || !tokens.length) return false
  const head = tokens[0].split("/").pop()
  return head === "echo" || head === "printf"
}

// Trailing run of distinct no-op bash calls in a tool-observation list.
// Re-observations of the SAME call (same pid) count once; entries with an
// unknown command are skipped without breaking the run; a truncated
// recorded command breaks the run (truncation can forge a literal).
export function findNoopBashRun(
  tools: readonly NoopToolObservation[],
  minRun: number = TOOL_RUN_MIN_DEFAULT,
): DegenerateFinding | null {
  if (!Array.isArray(tools) || tools.length < 1) return null
  const seenPid = new Set<string | number>()
  let run = 0
  let sample = ""
  for (let i = tools.length - 1; i >= 0; i--) {
    const t = tools[i]
    if (!t || typeof t !== "object") break
    if (t.pid != null && seenPid.has(t.pid)) continue
    if (t.tool !== "bash") break
    const cmd = typeof t.command === "string" ? t.command : ""
    if (!cmd.trim()) continue
    if (t.pid != null) seenPid.add(t.pid)
    if (t.truncated || !isNoopBashCommand(cmd)) break
    run++
    if (!sample) sample = cmd.trim().slice(0, 40)
    if (run >= minRun)
      return { channel: "tool", kind: "noop-bash", pattern: `${run} consecutive no-op bash calls (e.g. ${sample})` }
  }
  return null
}

function sanitizePattern(pattern: string): string {
  return pattern.replace(/[<>]/g, "")
}

export function degenerateRecoveryText(finding: DegenerateFinding, attempt: number): string {
  const pattern = sanitizePattern(finding.pattern)
  if (attempt <= 0)
    return [
      "<system-reminder>",
      `REPETITION DETECTED (${finding.kind}: ${pattern}): your output is degenerating into meaningless repetition.`,
      "",
      "STOP repeating. Before doing anything else, reply with:",
      "1. the task you are solving, in ONE line",
      "2. the single next concrete step",
      "Then continue normally — no sequences, no filler, no re-stated plans. If the task is actually complete, emit your final completion output instead of more text.",
      "</system-reminder>",
    ].join("\n")
  return [
    "<system-reminder>",
    `CRITICAL REPETITION (${finding.kind}: ${pattern}): you are STILL repeating after a previous recovery attempt.`,
    "",
    "You MUST:",
    "1. Abandon the line of output that is repeating entirely",
    "2. State what you were trying to produce and why it stalled",
    "3. Take a genuinely different route, or ask the user for guidance",
    "",
    "Do NOT continue the same output or reuse the same wording.",
    "</system-reminder>",
  ].join("\n")
}

export function noopBashRecoveryText(finding: DegenerateFinding): string {
  return [
    "<system-reminder>",
    `NO-OP TOOL CALLS DETECTED (${sanitizePattern(finding.pattern)}).`,
    "",
    "Bare echo/printf narration is NOT a tool call — echoing intent does not advance the task. STOP the echo loop. Do exactly ONE of:",
    "1. emit the REAL tool call your narration kept announcing (e.g. a Read/Edit), as an actual tool invocation with no echo markers",
    "2. if the task is actually complete, emit your final completion output",
    "",
    "Do not resume by echoing again.",
    "</system-reminder>",
  ].join("\n")
}

export class DegenerateGenerationMonitor {
  private textTail = ""
  private tools: NoopToolObservation[] = []

  constructor(
    private readonly toolRunMin: number = TOOL_RUN_MIN_DEFAULT,
    private readonly seqMin: number = SEQ_MIN_DEFAULT,
    private readonly minCopies: number = MIN_COPIES_DEFAULT,
  ) {}

  appendText(text: string): DegenerateFinding | undefined {
    if (!text) return undefined
    this.textTail += text
    if (this.textTail.length > TEXT_TAIL_MAX) this.textTail = this.textTail.slice(-TEXT_TAIL_MAX)
    return findTextDegeneration(this.textTail, this.seqMin, this.minCopies) ?? undefined
  }

  appendTool(tool: string, input: Record<string, unknown>): DegenerateFinding | undefined {
    const command = typeof input.command === "string" ? input.command : ""
    this.tools.push({ tool, command })
    if (this.tools.length > TOOL_OBS_MAX) this.tools = this.tools.slice(-TOOL_OBS_MAX)
    return findNoopBashRun(this.tools, this.toolRunMin) ?? undefined
  }

  reset(): void {
    this.textTail = ""
    this.tools = []
  }
}

export function createDegenerateGenerationMonitor(): DegenerateGenerationMonitor {
  return new DegenerateGenerationMonitor(
    Flag.MIMOCODE_DEGENERATE_TOOL_RUN_MIN,
    Flag.MIMOCODE_DEGENERATE_SEQ_MIN,
    Flag.MIMOCODE_DEGENERATE_MIN_COPIES,
  )
}

export function degenerateSignal(finding: DegenerateFinding) {
  return { _tag: "DegenerateGeneration" as const, finding }
}

export function isDegenerateSignal(value: unknown): value is { _tag: "DegenerateGeneration"; finding: DegenerateFinding } {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "DegenerateGeneration"
}
