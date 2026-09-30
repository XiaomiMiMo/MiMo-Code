// Token-efficient post-cleanse pipeline for bash tool output.
//
// Architecture: a Pipeline composed from CleanPlugin instances via a factory.
// Each plugin is a single pass over the text; `createPipeline` chains them and
// wraps the chain with a never-worse guard (if the cleaned output isn't
// strictly shorter than the original, the original is returned unchanged).
//
// Default plugin chain — order matters:
//   progress  fold \r-redrawn lines, keep only the last frame
//   ansi      strip ANSI CSI/OSC/DCS, backspace overstrike, control bytes
//   redact    mask Bearer/JWT/PEM/AWS/GH/OpenAI/Anthropic/Slack/KEY=VALUE
//   longline  collapse lines >MAX_LINE_CHARS to `<…N chars elided…>`
//
// progress must precede ansi (CR carries state across ANSI sequences). redact
// must run before longline so a long secret isn't elided mid-pattern. New
// filters drop in via:
//
//   createPipeline([...defaultPlugins(), myPlugin()]).run(text, { command })
//
// This is the extension point used by the heuristic shape plugins (gitdiff /
// pytest / npm / make / tsc / stacktrace / kubectl / json / md / gostest).
//
// Opt-out: `# nofilter` / `# raw` in the command, or env MIMOCODE_BASH_RAW=1.
//
// Tunables (positive ints via env; defaults shown):
//   MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_MAX_LINE_CHARS=500
//   MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_LINE_HEAD_KEEP=160
//   MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_NEVER_WORSE_MARGIN=0

import { Flag } from "@/flag/flag"

const MAX_LINE_CHARS = Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_MAX_LINE_CHARS
const LINE_HEAD_KEEP = Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_LINE_HEAD_KEEP
const NEVER_WORSE_MARGIN = Flag.MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY_NEVER_WORSE_MARGIN

const ANSI_CSI = /\x1b\[[0-?]*[ -/]*[@-~]/g
const ANSI_OSC = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g
const ANSI_DCS = /\x1b[PX^_][\s\S]*?\x1b\\/g
const BACKSPACE = /[^\n]\x08/g
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi, "$1 <redacted>"],
  // JWT (three base64url segments separated by dots, >=10 chars each)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g, "<redacted-jwt>"],
  // AWS access keys
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g, "<redacted-aws-key>"],
  // GitHub fine-grained / classic tokens
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g, "<redacted-gh-token>"],
  // OpenAI keys
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-openai-key>"],
  // Anthropic keys
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g, "<redacted-anthropic-key>"],
  // Slack tokens
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g, "<redacted-slack-token>"],
  // Generic api/secret/password/token assignments: KEY=VALUE / "key": "value"
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]

// Replace embedded PEM blocks (possibly multi-line) with a single marker.
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const SKIP_MARKERS = ["# nofilter", "# raw"]

export type CleanOptions = {
  command?: string
}

export type CleanResult = {
  text: string
  bytesIn: number
  bytesOut: number
  degraded: boolean
}

export type CleanPlugin = {
  name: string
  apply: (text: string, ctx: CleanOptions) => string
}

export type CleanPipeline = {
  plugins: ReadonlyArray<CleanPlugin>
  run: (text: string, options?: CleanOptions) => CleanResult
}

function shouldSkip(command: string | undefined): boolean {
  if (process.env["MIMOCODE_BASH_RAW"] === "1") return true
  if (!command) return false
  return SKIP_MARKERS.some((mark) => command.includes(mark))
}

// L1 — fold \r-redrawn lines. Per line, when carriage returns redraw the same
// position, only the segment after the LAST `\r` survives — that's the final
// rendered frame. No-op when the text contains no `\r`.
export const progressPlugin = (): CleanPlugin => ({
  name: "progress",
  apply(text) {
    if (!text.includes("\r")) return text
    return text
      .split("\n")
      .map((line) => {
        const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
        const idx = stripped.lastIndexOf("\r")
        return idx === -1 ? stripped : stripped.slice(idx + 1)
      })
      .join("\n")
  },
})

// L0 — strip ANSI escapes (CSI/OSC/DCS), backspace overstrike, control bytes.
// The backspace `while` loop collapses `x\b` repeatedly: `ab\b\bcd` → `cd`.
export const ansiPlugin = (): CleanPlugin => ({
  name: "ansi",
  apply(text) {
    let out = text.replace(ANSI_CSI, "").replace(ANSI_OSC, "").replace(ANSI_DCS, "")
    while (BACKSPACE.test(out)) out = out.replace(BACKSPACE, "")
    return out.replace(CTRL_BYTES, "")
  },
})

// L3 — re-mask common secret shapes. PEM block runs first (single cross-line
// match), then the per-shape replacements fold in via reduce.
export const redactPlugin = (): CleanPlugin => ({
  name: "redact",
  apply(text) {
    return REDACT_PATTERNS.reduce(
      (acc, [pattern, replacement]) => acc.replace(pattern, replacement),
      text.replace(PEM_BLOCK, "<redacted-pem-block>"),
    )
  },
})

// L4 — long-line elide. Lines longer than MAX_LINE_CHARS keep their head and
// get a `<elided N chars>` tail marker. Short-circuit when the whole text is
// already shorter than the threshold.
export const longLinePlugin = (): CleanPlugin => ({
  name: "longline",
  apply(text) {
    if (text.length <= MAX_LINE_CHARS) return text
    return text
      .split("\n")
      .map((line) => {
        if (line.length <= MAX_LINE_CHARS) return line
        return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
      })
      .join("\n")
  },
})

// Default plugin chain. Returns a fresh array each call so callers can safely
// splice/extend without mutating shared state.
export const defaultPlugins = (): CleanPlugin[] => [
  progressPlugin(),
  ansiPlugin(),
  redactPlugin(),
  longLinePlugin(),
]

// Pipeline factory. Composes the injected plugins into a runnable pipeline:
// skip-check → fold plugins via reduce → never-worse guard. The guard runs at
// the tail because individual plugins may temporarily inflate the text (e.g.
// short secrets expanding to their `<redacted-*>` marker); only the chain as a
// whole must shrink.
export const createPipeline = (plugins: CleanPlugin[] = defaultPlugins()): CleanPipeline => ({
  plugins,
  run(text, options = {}) {
    const bytesIn = Buffer.byteLength(text, "utf-8")
    if (!text || shouldSkip(options.command)) {
      return { text, bytesIn, bytesOut: bytesIn, degraded: false }
    }
    const out = plugins.reduce((acc, plugin) => plugin.apply(acc, options), text)
    const bytesOut = Buffer.byteLength(out, "utf-8")
    if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
      return { text, bytesIn, bytesOut: bytesIn, degraded: true }
    }
    return { text: out, bytesIn, bytesOut, degraded: false }
  },
})

const defaultPipeline = createPipeline()

// Public entry point used by the bash tool. Backward-compatible signature.
export function clean(text: string, options: CleanOptions = {}): CleanResult {
  return defaultPipeline.run(text, options)
}
