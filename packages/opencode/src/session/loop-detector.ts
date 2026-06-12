// Only the trailing window is scanned, so memory and per-check cost are
// constant regardless of how much text streams through.
const WINDOW = 8192
// Deltas are buffered and the periodicity scan only runs once this many new
// characters have accumulated, keeping the amortized cost per character tiny.
const CHECK_INTERVAL = 256

export type LoopCheck = { loop: false } | { loop: true; period: number; count: number }

export class OutputLoopError extends Error {
  constructor(
    readonly period: number,
    readonly count: number,
  ) {
    super(`Model output entered a loop (${period}-character pattern repeated ${count} times); response truncated.`)
  }
}

const NO_LOOP: LoopCheck = { loop: false }

/**
 * Detects runaway repetition in streamed model output.
 *
 * The trailing window is scanned with a prefix function (KMP) computed over
 * the reversed tail, which yields the smallest period of every suffix in one
 * O(WINDOW) pass. A loop is reported when a suffix consists of enough exact
 * repetitions of a pattern, with thresholds graded by pattern length so that
 * legitimate repetition (dividers, indentation, boilerplate) stays below them.
 *
 * Detection is deliberately conservative inside fenced code blocks, where
 * repetitive content (fixtures, matrices, generated data) is normal.
 */
export class LoopDetector {
  private buffer = ""
  private pending = 0
  private fences = 0
  private carry = ""
  private readonly tail = new Uint16Array(WINDOW)
  private readonly pi = new Int32Array(WINDOW)

  /** Call when a new output part starts so patterns cannot span unrelated parts. */
  reset() {
    this.buffer = ""
    this.pending = 0
    this.fences = 0
    this.carry = ""
  }

  append(text: string): LoopCheck {
    if (text.length === 0) return NO_LOOP

    const scan = this.carry + text
    for (let i = scan.indexOf("```"); i !== -1; i = scan.indexOf("```", i + 3)) this.fences++
    this.carry = scan.slice(-2)

    this.buffer += text
    if (this.buffer.length > WINDOW * 2) this.buffer = this.buffer.slice(-WINDOW)
    this.pending += text.length
    if (this.pending < CHECK_INTERVAL) return NO_LOOP
    this.pending = 0
    return this.check()
  }

  private check(): LoopCheck {
    const n = Math.min(this.buffer.length, WINDOW)
    if (n < 16) return NO_LOOP
    const inCode = this.fences % 2 === 1

    // Prefix function over the reversed tail: prefixes of the reversed string
    // are suffixes of the output, so pi gives every suffix's smallest period
    // without re-scanning per candidate length.
    const s = this.tail
    const last = this.buffer.length - 1
    for (let i = 0; i < n; i++) s[i] = this.buffer.charCodeAt(last - i)
    const pi = this.pi
    pi[0] = 0
    for (let i = 1; i < n; i++) {
      let j = pi[i - 1]
      while (j > 0 && s[i] !== s[j]) j = pi[j - 1]
      if (s[i] === s[j]) j++
      pi[i] = j
    }

    for (let i = 1; i < n; i++) {
      if (pi[i] === 0) continue
      const length = i + 1
      const period = length - pi[i]
      const count = Math.floor(length / period)
      if (count < 2) continue
      if (isLoop(period, count, inCode)) return { loop: true, period, count }
    }
    return NO_LOOP
  }
}

// Thresholds are tuned so a false positive (which kills the turn) is far less
// likely than a false negative (which merely lets the loop run longer).
function isLoop(period: number, count: number, inCode: boolean): boolean {
  if (inCode) return period >= 30 && count >= 24
  if (period === 1) return count >= 300
  if (period < 5) return count >= 80
  if (period < 15) return count >= 40
  if (period < 50) return count >= 16
  if (period < 200) return count >= 8
  return count >= 5
}
