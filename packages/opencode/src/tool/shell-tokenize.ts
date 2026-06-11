import { Effect } from "effect"
import { parse as shellQuoteParse } from "shell-quote"

export interface Argv {
  line: number
  tokens: string[]
}

export interface ParseError {
  kind: "unclosed-quote" | "unsupported-operator" | "unclosed-heredoc" | "internal"
  line: number
  detail: string
}

// Null-byte delimited placeholder that shell-quote passes through verbatim.
function heredocPlaceholder(n: number) {
  return `\x00HD${n}\x00`
}

type HeredocResult =
  | { ok: true; stripped: string; bodies: string[] }
  | { ok: false; error: ParseError }

function extractHeredocs(script: string): HeredocResult {
  const bodies: string[] = []
  let out = ""
  let quote: '"' | "'" | null = null
  let i = 0
  let line = 1

  while (i < script.length) {
    const ch = script[i]

    // --- Inside a quoted string: pass through verbatim ---
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < script.length) {
        out += ch + script[i + 1]
        if (script[i + 1] === "\n") line++
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        out += ch
        i++
        continue
      }
      if (ch === "\n") line++
      out += ch
      i++
      continue
    }

    // --- At top level ---
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      continue
    }

    // Check for `<<` at top level (but not `<<<` herestring)
    if (ch === "<" && script[i + 1] === "<") {
      // `<<<` herestring: pass all three chars through so the existing operator
      // check rejects them.
      if (script[i + 2] === "<") {
        out += "<<< "
        i += 3
        // Skip to newline so the rest of the line goes through normally
        while (i < script.length && script[i] !== "\n") i++
        continue
      }

      // Try to read a marker name starting at i+2
      let j = i + 2
      const markerStart = j
      // Marker must start with letter or underscore
      if (j < script.length && /[A-Za-z_]/.test(script[j])) {
        while (j < script.length && /[A-Za-z0-9_]/.test(script[j])) j++
        const marker = script.slice(markerStart, j)

        // After marker: only optional whitespace, then newline (or EOF)
        let k = j
        while (k < script.length && (script[k] === " " || script[k] === "\t")) k++

        if (k < script.length && script[k] !== "\n") {
          // Non-whitespace after <<MARKER on the same line
          return {
            ok: false,
            error: {
              kind: "unsupported-operator",
              line,
              detail: "tokens after <<MARKER on the same line are not supported",
            },
          }
        }

        // Valid heredoc open: emit placeholder on the same line in output.
        // Body lines and the closing marker are replaced with empty lines so
        // that splitTopLevelLines sees the correct original line numbers.
        const bodyIndex = bodies.length
        const openLine = line
        out += heredocPlaceholder(bodyIndex) + "\n"
        // Advance past <<MARKER + optional whitespace + \n
        i = k + 1
        line++

        // Collect body lines until we see a line that trims to exactly `marker`
        const bodyLines: string[] = []
        let closed = false
        while (i < script.length) {
          // Read one line (up to but not including its \n, or EOF)
          let lineEnd = i
          while (lineEnd < script.length && script[lineEnd] !== "\n") lineEnd++
          const bodyLine = script.slice(i, lineEnd)
          // Emit a blank line to preserve original line numbering
          out += "\n"
          if (bodyLine.trim() === marker) {
            // Closing line — consume it (and trailing \n if present)
            i = lineEnd + (lineEnd < script.length ? 1 : 0)
            line++
            closed = true
            break
          }
          bodyLines.push(bodyLine)
          i = lineEnd + (lineEnd < script.length ? 1 : 0)
          line++
        }

        if (!closed) {
          return {
            ok: false,
            error: {
              kind: "unclosed-heredoc",
              line: openLine,
              detail: `unclosed heredoc <<${marker}`,
            },
          }
        }

        bodies.push(bodyLines.join("\n"))
        continue
      }

      // `<<` without a valid marker — pass through so the existing operator
      // check rejects it.
      out += ch
      i++
      continue
    }

    out += ch
    if (ch === "\n") line++
    i++
  }

  return { ok: true, stripped: out, bodies }
}

// Regex matching a heredoc placeholder token produced by extractHeredocs.
const HD_RE = /^\x00HD(\d+)\x00$/

// POSIX-style comment pre-pass: operates on the post-heredoc-extraction text so
// heredoc bodies are already removed. Drops word-boundary `#` to end-of-line,
// escapes mid-token `#` so shell-quote treats it as a literal character.
function preprocessComments(input: string): string {
  let out = ""
  let i = 0
  let quote: '"' | "'" | null = null
  let prevWasBoundary = true // start of input is a word boundary
  while (i < input.length) {
    const ch = input[i]
    if (quote) {
      out += ch
      if (ch === "\\" && quote === '"' && i + 1 < input.length) {
        out += input[i + 1]
        i += 2
        continue
      }
      if (ch === quote) quote = null
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      out += ch
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === "\\") {
      if (i + 1 < input.length && input[i + 1] === "#") {
        // Explicit \# escape: pass through verbatim so shell-quote produces literal #
        out += "\\#"
        i += 2
        prevWasBoundary = false
        continue
      }
      // Other backslash: pass through
      out += ch
      i++
      prevWasBoundary = false
      continue
    }
    if (ch === "#") {
      if (prevWasBoundary) {
        // word-boundary # → real comment, drop to end of line (don't consume the \n)
        while (i < input.length && input[i] !== "\n") i++
        continue
      }
      // mid-token # → escape so shell-quote treats as literal
      out += "\\#"
      i++
      prevWasBoundary = false
      continue
    }
    out += ch
    prevWasBoundary = ch === "\n" || /\s/.test(ch)
    i++
  }
  return out
}

export function tokenize(script: string): Effect.Effect<Argv[], ParseError> {
  return Effect.suspend(() => {
    if (script.trim() === "") return Effect.succeed([] as Argv[])

    const heredocResult = extractHeredocs(script)
    if (!heredocResult.ok) return Effect.fail(heredocResult.error)
    const { stripped, bodies } = heredocResult

    const segments = splitTopLevelLines(preprocessComments(stripped)).filter((seg) => seg.text.trim() !== "")
    const out: Argv[] = []
    for (const seg of segments) {
      const unclosed = scanUnclosedQuote(seg.text)
      if (unclosed) {
        return Effect.fail<ParseError>({
          kind: "unclosed-quote",
          line: seg.line,
          detail: `unclosed ${unclosed}-quoted string`,
        })
      }
      const segTokens = shellQuoteParse(seg.text, (name: string) => "$" + name, { escape: "\\" })
      const stringTokens: string[] = []
      for (const t of segTokens) {
        if (typeof t === "string") {
          const match = HD_RE.exec(t)
          if (match) {
            stringTokens.push(bodies[parseInt(match[1], 10)])
            continue
          }
          stringTokens.push(t)
          continue
        }
        if (typeof t === "object" && t !== null && "op" in t) {
          const tok = t as { op: string; pattern?: string }
          const detail =
            tok.op === "glob" && tok.pattern != null
              ? `unsupported glob pattern: ${tok.pattern}`
              : `unsupported shell operator: ${tok.op}`
          return Effect.fail<ParseError>({
            kind: "unsupported-operator",
            line: seg.line,
            detail,
          })
        }
      }
      if (stringTokens.length > 0) out.push({ line: seg.line, tokens: stringTokens })
    }
    return Effect.succeed(out)
  })
}

function scanUnclosedQuote(segment: string): '"' | "'" | null {
  let quote: '"' | "'" | null = null
  for (let i = 0; i < segment.length; i++) {
    const ch = segment[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < segment.length) {
        i++
        continue
      }
      if (ch === quote) quote = null
      continue
    }
    if (ch === '"' || ch === "'") quote = ch
  }
  return quote
}

// Split the script into segments separated by line breaks that are NOT inside
// quoted strings. Returns each segment's starting line (1-indexed) and text.
function splitTopLevelLines(script: string): Array<{ line: number; text: string }> {
  const segments: Array<{ line: number; text: string }> = []
  let buf = ""
  let segStart = 1
  let line = 1
  let quote: '"' | "'" | null = null
  let i = 0
  while (i < script.length) {
    const ch = script[i]
    if (quote) {
      if (ch === "\\" && quote === '"' && i + 1 < script.length) {
        buf += ch + script[i + 1]
        if (script[i + 1] === "\n") line++
        i += 2
        continue
      }
      if (ch === quote) {
        quote = null
        buf += ch
        i++
        continue
      }
      if (ch === "\n") line++
      buf += ch
      i++
      continue
    }
    if (ch === '"' || ch === "'") {
      quote = ch
      buf += ch
      i++
      continue
    }
    if (ch === "\\" && i + 1 < script.length && script[i + 1] === "\n") {
      // POSIX line continuation: \<LF> disappears, next physical line continues this command
      line++
      i += 2
      continue
    }
    if (ch === "\n") {
      segments.push({ line: segStart, text: buf })
      buf = ""
      line++
      segStart = line
      i++
      continue
    }
    buf += ch
    i++
  }
  if (buf.length > 0) segments.push({ line: segStart, text: buf })
  return segments
}
