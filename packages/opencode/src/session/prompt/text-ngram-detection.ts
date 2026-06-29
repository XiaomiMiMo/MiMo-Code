import { Flag } from "@/flag/flag"

export const TEXT_NGRAM_MAX_RECOVERY = 2

export function tokenizeForNgram(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

function isMarkdownListLine(line: string): boolean {
  return /^\s*([-*+]|\d+[.)])\s+/.test(line)
}

function isMarkdownTableRow(line: string): boolean {
  const trimmed = line.trim()
  return /^\|.*\|$/.test(trimmed) && (trimmed.match(/\|/g)?.length ?? 0) >= 2
}

function isMarkdownTableSeparator(line: string): boolean {
  return /^\|?\s*:?-{3,}:?\s*(\|\s*:?-{3,}:?\s*)+\|?$/.test(line.trim())
}

function structuredMarkdownLineIndexes(lines: readonly string[]): Set<number> {
  const indexes = new Set<number>()
  lines.forEach((line, index) => {
    if (isMarkdownListLine(line)) indexes.add(index)
    if (!isMarkdownTableSeparator(line)) return
    for (let i = index; i >= 0 && isMarkdownTableRow(lines[i]); i--) indexes.add(i)
    for (let i = index + 1; i < lines.length && isMarkdownTableRow(lines[i]); i++) indexes.add(i)
  })
  return indexes
}

function removeStructuredMarkdownBlocks(text: string): string {
  const lines = text.split(/\r?\n/)
  const indexes = structuredMarkdownLineIndexes(lines)
  if (indexes.size < 3) return text
  const counts = new Map<string, number>()
  lines.forEach((line, index) => {
    if (indexes.has(index)) counts.set(line.trim(), (counts.get(line.trim()) ?? 0) + 1)
  })
  return lines.filter((line, index) => !indexes.has(index) || (counts.get(line.trim()) ?? 0) >= 3).join("\n")
}

export function detectRepeatedNgram(tokens: readonly string[], n: number, threshold: number): boolean {
  if (tokens.length < n || threshold < 2) return false
  const counts = new Map<string, number>()
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join("\0")
    const next = (counts.get(gram) ?? 0) + 1
    if (next >= threshold) return true
    counts.set(gram, next)
  }
  return false
}

export class TextNgramMonitor {
  private buffer = ""
  private tokens: string[] = []

  constructor(
    private readonly n: number,
    private readonly threshold: number,
    private readonly windowTokens: number,
  ) {}

  append(text: string): boolean {
    if (!text) return false
    this.buffer += text
    const all = tokenizeForNgram(removeStructuredMarkdownBlocks(this.buffer))
    this.tokens = all.length > this.windowTokens ? all.slice(-this.windowTokens) : all
    if (all.length > this.windowTokens * 2) this.buffer = this.tokens.join(" ")
    return detectRepeatedNgram(this.tokens, this.n, this.threshold)
  }

  reset() {
    this.buffer = ""
    this.tokens = []
  }
}

export function createTextNgramMonitor() {
  return new TextNgramMonitor(
    Flag.MIMOCODE_TEXT_NGRAM_N,
    Flag.MIMOCODE_TEXT_REPEAT_THRESHOLD,
    Flag.MIMOCODE_TEXT_WINDOW_TOKENS,
  )
}

export function textNgramRepeat() {
  return { _tag: "TextNgramRepeat" as const }
}

export function isTextNgramRepeat(value: unknown): value is { _tag: "TextNgramRepeat" } {
  return typeof value === "object" && value !== null && "_tag" in value && value._tag === "TextNgramRepeat"
}

export const TEXT_NGRAM_RECOVERY_REMIND = `<system-reminder>
REPETITION DETECTED: Your recent output contains repeated phrases (sliding n-gram match within your last ${Flag.MIMOCODE_TEXT_WINDOW_TOKENS} tokens).

STOP repeating yourself and retry with a different approach:
- Vary your wording and reasoning — do not reuse the same phrases
- If you were about to call a tool, try a different tool or different arguments
- If you are blocked, explain what is blocking you instead of looping

Do NOT output the same phrases again.
</system-reminder>`

export const TEXT_NGRAM_RECOVERY_REPLAN = `<system-reminder>
CRITICAL REPETITION: You are STILL repeating phrases after a recovery attempt.

You MUST completely replan before continuing:
1. Abandon your current approach entirely — it is stuck in repetition
2. Write out a NEW plan with different steps and a different strategy
3. State what you were trying to do, why it failed, and how your new plan differs

Do NOT continue the same line of reasoning or reuse the same wording.
</system-reminder>`
