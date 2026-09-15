import { Flag } from "@/flag/flag"

export const TEXT_NGRAM_MAX_RECOVERY = 2

export function tokenizeForNgram(text: string): string[] {
  return text
    .toLowerCase()
    .replace(/\s+/g, " ")
    .replace(/([　-ヿ㐀-䶿一-鿿豈-﫿＀-￯])/g, " $1 ")
    .trim()
    .split(" ")
    .filter(Boolean)
}

export function detectRepeatedNgram(tokens: readonly string[], n: number, threshold: number, minDistinct = 1): boolean {
  if (tokens.length < n || threshold < 2) return false
  const counts = new Map<string, { count: number; next: number }>()
  for (let i = 0; i <= tokens.length - n; i++) {
    const gram = tokens.slice(i, i + n).join("\0")
    const entry = counts.get(gram) ?? { count: 0, next: -1 }
    if (i < entry.next) continue
    entry.count++
    entry.next = i + n
    if (entry.count >= threshold && new Set(tokens.slice(i, i + n)).size >= minDistinct) return true
    counts.set(gram, entry)
  }
  return false
}

export function detectConsecutiveRepeat(
  tokens: readonly string[],
  minBlockSize: number,
  threshold: number,
  minDistinct: number = 3,
): boolean {
  if (threshold < 2 || tokens.length < minBlockSize * threshold) return false
  const maxPeriod = Math.floor(tokens.length / threshold)
  for (let p = minBlockSize; p <= maxPeriod; p++) {
    let run = 0
    for (let i = 0; i <= tokens.length - p - 1; i++) {
      if (tokens[i] === tokens[i + p]) {
        run++
        if (run >= p * (threshold - 1)) {
          const blockStart = i - run + 1
          const distinct = new Set(tokens.slice(blockStart, blockStart + p)).size
          if (distinct >= minDistinct) return true
          run = 0
        }
      } else {
        run = 0
      }
    }
  }
  return false
}

export class TextNgramMonitor {
  private buffer = ""
  private tokens: string[] = []
  private pending = 0

  constructor(
    private readonly n: number,
    private readonly threshold: number,
    private readonly windowTokens: number,
    private readonly minDistinct: number = 3,
    private readonly checkInterval: number = 0,
  ) {}

  append(text: string): boolean {
    if (!text) return false
    this.pending += tokenizeForNgram(text).length
    this.buffer += text
    const all = tokenizeForNgram(this.buffer)
    this.tokens = all.length > this.windowTokens ? all.slice(-this.windowTokens) : all
    if (all.length > this.windowTokens * 2) this.buffer = this.tokens.join(" ")
    if (this.checkInterval > 0 && this.pending < this.checkInterval) return false
    this.pending = 0
    return detectRepeatedNgram(this.tokens, this.n, this.threshold, this.minDistinct)
  }

  reset() {
    this.buffer = ""
    this.tokens = []
    this.pending = 0
  }
}

export function createTextNgramMonitor() {
  return new TextNgramMonitor(
    Flag.MIMOCODE_TEXT_NGRAM_N,
    Flag.MIMOCODE_TEXT_REPEAT_THRESHOLD,
    Flag.MIMOCODE_TEXT_WINDOW_TOKENS,
    3,
    Flag.MIMOCODE_TEXT_NGRAM_CHECK_INTERVAL,
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
