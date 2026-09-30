// Heuristic (shape-based) filter pipeline for bash tool output. Runs AFTER
// the common pipeline in `bash_token_efficient_pipeline.ts`. Each Shape
// recognises a command pattern or a body fingerprint and rewrites the body
// to strip predictable noise (build banners, dependency frames, redraw
// spinners baked into text, etc.).
//
// Selection order:
//   1. Command-layer passthrough — user is already projecting (`--json`,
//      `-o json`, `| tee`, `| xxd`, `| hexdump`, `--no-color`). Skip.
//   2. Command-name channel — match on the leading argv.
//   3. Body-fingerprint channel — fall back to head-of-output patterns.
//
// Public entry point: `cleanHeuristic(text, { command })`. Same never-worse
// contract as the common pipeline: any rewrite that fails to shrink bytes
// is discarded and the input is returned untouched.

export type ShapeContext = {
  command: string
  head4k: string
  tail4k: string
}

export interface Shape {
  id: string
  match: (ctx: ShapeContext) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

export type HeuristicOptions = {
  command?: string
}

export type HeuristicResult = {
  text: string
  bytesIn: number
  bytesOut: number
  shape: string | null
  degraded: boolean
}

const HEAD_TAIL_BYTES = 4096

// Command-layer passthrough — user already asked for machine-readable output
// or explicit teeing / hex dumping. Do not touch.
const PASSTHROUGH_PATTERNS: RegExp[] = [
  /(^|\s)--json(\s|=|$)/,
  /(^|\s)--format[= ]json(\s|$)/,
  /(^|\s)-o[= ]json(\s|$)/,
  /(^|\s)--no-color(\s|$)/,
  /\|\s*tee(\s|$)/,
  /\|\s*xxd(\s|$)/,
  /\|\s*hexdump(\s|$)/,
]

// Command-name channel. First hit wins.
const COMMAND_PATTERNS: Array<[RegExp, string]> = [
  [/^\s*pytest(\s|$)/, "pytest"],
  [/^\s*(?:npm|pnpm|yarn)\s+(?:install|i|add)(\s|$)/, "npm"],
  [/^\s*(?:make|cmake|automake)(\s|$)/, "make"],
  [/^\s*git\s+(?:diff|show)(\s|$)/, "gitdiff"],
  [/^\s*tsc(\s|$)/, "tsc"],
  [/^\s*kubectl\s+get\s+pods?(\s|$)/, "kubectl"],
  [/^\s*go\s+test.*-json/, "gostest"],
  [/^\s*gh\s+(?:pr|issue)\s+view(\s|$)/, "md"],
]

// Body-fingerprint channel. Used when command-name channel misses.
const BODY_FINGERPRINTS: Array<[RegExp, string]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m, "gitdiff"],
  [/^Traceback \(most recent call last\)/m, "stacktrace"],
  [/^\s*at .+:\d+:\d+/m, "stacktrace"],
  [/^error\[E\d+\]:/m, "stacktrace"],
]

function shouldPassthrough(command: string | undefined): boolean {
  if (!command) return false
  return PASSTHROUGH_PATTERNS.some((re) => re.test(command))
}

function shapeFor(ctx: ShapeContext): string | null {
  for (const [re, id] of COMMAND_PATTERNS) {
    if (re.test(ctx.command)) return id
  }
  for (const [re, id] of BODY_FINGERPRINTS) {
    if (re.test(ctx.head4k)) return id
  }
  if (/^\s*[\{\[]/.test(ctx.head4k)) return "json"
  return null
}

// ---- Shape: git diff / git show ----------------------------------------
// Whitelist noisy paths (lockfiles / minified / dist / generated). For a
// whitelisted file the hunk body is suppressed and replaced with the file's
// diff header plus a `+A -R` line count.
const GITDIFF_NOISE_PATHS =
  /(?:^|\/)(?:package-lock\.json|pnpm-lock\.yaml|yarn\.lock|composer\.lock|Cargo\.lock|Gemfile\.lock|poetry\.lock|uv\.lock|.*\.min\.js|.*\.min\.css|dist\/.*|build\/.*|node_modules\/.*|.*\.generated\..*)$/

const S_gitdiff: Shape = {
  id: "gitdiff",
  match: () => false,
  apply(body) {
    const files = body.split(/(?=^diff --git )/m)
    const out: string[] = []
    for (const file of files) {
      if (!file.startsWith("diff --git")) {
        out.push(file)
        continue
      }
      const pathMatch = file.match(/^diff --git a\/(\S+) b\/(\S+)/m)
      const targetPath = pathMatch?.[2] ?? pathMatch?.[1] ?? ""
      const header: string[] = []
      const hunks: string[] = []
      let inHunk = false
      const lines = file.split("\n")
      for (const line of lines) {
        if (line.startsWith("@@")) {
          inHunk = true
          hunks.push(line)
          continue
        }
        if (!inHunk) {
          header.push(line)
          continue
        }
        hunks.push(line)
      }

      if (targetPath && GITDIFF_NOISE_PATHS.test(targetPath)) {
        let added = 0
        let removed = 0
        for (const line of hunks) {
          if (line.startsWith("+") && !line.startsWith("+++")) added++
          else if (line.startsWith("-") && !line.startsWith("---")) removed++
        }
        out.push(`${header.join("\n")}\n<hunks suppressed: generated/lockfile — +${added} -${removed}>`)
        continue
      }

      // Cap single-hunk length at 100 lines.
      const cappedHunkLines: string[] = []
      let currentHunkStart = -1
      let currentHunkLen = 0
      for (let i = 0; i < hunks.length; i++) {
        const line = hunks[i]
        if (line.startsWith("@@")) {
          currentHunkStart = cappedHunkLines.length
          currentHunkLen = 0
          cappedHunkLines.push(line)
          continue
        }
        currentHunkLen++
        if (currentHunkLen <= 100) {
          cappedHunkLines.push(line)
          continue
        }
        if (currentHunkLen === 101 && currentHunkStart >= 0) {
          cappedHunkLines.push(`<hunk elided: ${hunks.length - i} more lines>`)
        }
      }

      let added = 0
      let removed = 0
      for (const line of cappedHunkLines) {
        if (line.startsWith("+") && !line.startsWith("+++")) added++
        else if (line.startsWith("-") && !line.startsWith("---")) removed++
      }
      const tail = `<file summary: +${added} -${removed}>`
      out.push([...header, ...cappedHunkLines, tail].join("\n"))
    }
    return out.join("")
  },
}

// ---- Shape: pytest ------------------------------------------------------
// State machine: Header → TestProgress → Failures → Summary. Keep only:
//   - `collected N items`
//   - `E   ...` (assertion detail)
//   - `<file>:<line>:` (locations)
//   - `FAILED <test>` lines
//   - short test summary block
const S_pytest: Shape = {
  id: "pytest",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    type Phase = "header" | "progress" | "failures" | "summary"
    let phase: Phase = "header"
    const out: string[] = []
    for (const line of lines) {
      if (/^={5,}\s+test session starts\s+={5,}/.test(line)) {
        phase = "header"
        out.push(line)
        continue
      }
      if (/^={3,}\s+FAILURES\s+={3,}/.test(line)) {
        phase = "failures"
        out.push(line)
        continue
      }
      if (/^={3,}\s+short test summary info\s+={3,}/.test(line)) {
        phase = "summary"
        out.push(line)
        continue
      }
      if (/^={3,}\s+.*(?:passed|failed|error).*={3,}$/.test(line)) {
        out.push(line)
        continue
      }
      if (phase === "header") {
        if (/^collected \d+ item/.test(line) || /^platform |^rootdir:|^plugins:/.test(line)) {
          out.push(line)
        }
        // Transition on any content line that looks like a progress row.
        if (/\.\.\s+\[\s*\d+%\]$/.test(line) || /^\S+\.py\s+[.FEsx]+/.test(line)) {
          phase = "progress"
        }
        continue
      }
      if (phase === "progress") {
        // Drop dot progress rows. Keep FAILED markers.
        if (line.startsWith("FAILED ")) out.push(line)
        continue
      }
      if (phase === "failures") {
        if (line.startsWith("E ") || line.startsWith("E\t")) {
          out.push(line)
          continue
        }
        if (/^[^\s].*\.py:\d+:/.test(line) || /^\S+:\d+:/.test(line)) {
          out.push(line)
          continue
        }
        if (line.startsWith("FAILED ")) out.push(line)
        continue
      }
      if (phase === "summary") {
        out.push(line)
      }
    }
    return out.join("\n")
  },
}

// ---- Shape: npm / pnpm / yarn install -----------------------------------
const S_npm: Shape = {
  id: "npm",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    const out: string[] = []
    const deprecated: string[] = []
    const flush = () => {
      if (deprecated.length === 0) return
      const top = deprecated.slice(0, 3).join(", ")
      out.push(`<[×${deprecated.length}] deprecation warnings: top: ${top}>`)
      deprecated.length = 0
    }
    const deprecationRe = /^(?:npm\s+warn|npm\s+WARN)\s+deprecated\s+([^\s@:]+)/
    for (const line of lines) {
      const m = line.match(deprecationRe)
      if (m) {
        deprecated.push(m[1])
        continue
      }
      flush()
      if (/^added \d+ packages?/.test(line)) {
        out.push(line)
        continue
      }
      if (/^\s*\d+ vulnerabilit/.test(line) || /found \d+ vulnerabilit/.test(line)) {
        out.push(line)
        continue
      }
      if (/^\s*\d+ packages? are looking for funding/.test(line)) {
        out.push(line)
        continue
      }
      if (/^npm\s+(?:warn|err|WARN|ERR)/.test(line) && !deprecationRe.test(line)) {
        out.push(line)
        continue
      }
      // Drop other install chatter (tarball urls, progress).
      if (!line.trim()) out.push(line)
    }
    flush()
    return out.join("\n")
  },
}

// ---- Shape: make / cmake / automake -------------------------------------
const S_make: Shape = {
  id: "make",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    const out: string[] = []
    for (let i = 0; i < lines.length; i++) {
      const line = lines[i]
      if (/^make(?:\[\d+\])?: (?:Entering|Leaving) directory/.test(line)) continue
      // Skip bare compile commands: cc/gcc/clang/g\+\+/ld/ar with flags.
      if (/^(?:cc|gcc|clang|clang\+\+|g\+\+|ld|ar)\b.*(?:-o|-c|-I)/.test(line)) continue
      // Skip caret pointer lines.
      if (/^\s*\^~*\s*$/.test(line)) continue
      out.push(line)
    }
    return out.join("\n")
  },
}

// ---- Shape: stacktrace (Python / Node / Rust) ---------------------------
const DEP_FRAME_RE =
  /(?:site-packages|\.venv\/|node_modules\/|\/dist-packages\/|python\d+\.\d+\/(?:lib|http|urllib|logging|socket|threading|asyncio)\/|\/std\/|\/rustc\/)/
const S_stacktrace: Shape = {
  id: "stacktrace",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    const out: string[] = []
    let depRun = 0
    const flush = () => {
      if (depRun === 0) return
      out.push(`  <[${depRun} dependency frame(s) suppressed]>`)
      depRun = 0
    }
    for (const line of lines) {
      const isFrame =
        /^\s*File "/.test(line) || /^\s*at .+:\d+/.test(line) || /^\s*\d+:\s*\d+\s+/.test(line)
      if (isFrame && DEP_FRAME_RE.test(line)) {
        depRun++
        continue
      }
      flush()
      out.push(line)
    }
    flush()
    return out.join("\n")
  },
}

// ---- Shape: tsc ---------------------------------------------------------
const TSC_LINE_RE = /^(.+?)\((\d+),(\d+)\):\s+error\s+(TS\d+):\s+(.+)$/
const S_tsc: Shape = {
  id: "tsc",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    const byCode = new Map<string, { count: number; sample: string }>()
    const byFile = new Map<string, { count: number; sample: string }>()
    const passthrough: string[] = []
    for (const line of lines) {
      const m = line.match(TSC_LINE_RE)
      if (!m) {
        if (line.trim()) passthrough.push(line)
        continue
      }
      const [, file, , , code] = m
      const codeSlot = byCode.get(code) ?? { count: 0, sample: line }
      codeSlot.count++
      byCode.set(code, codeSlot)
      const fileSlot = byFile.get(file) ?? { count: 0, sample: line }
      fileSlot.count++
      byFile.set(file, fileSlot)
    }
    if (byCode.size === 0) return body
    const topCodes = [...byCode.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 5)
    const topFiles = [...byFile.entries()].sort((a, b) => b[1].count - a[1].count).slice(0, 8)
    const out: string[] = []
    out.push("<tsc: top errors by code>")
    for (const [code, { count, sample }] of topCodes) {
      out.push(`  ${code} ×${count}  |  ${sample}`)
    }
    out.push("<tsc: top files>")
    for (const [file, { count, sample }] of topFiles) {
      out.push(`  ${file} ×${count}  |  ${sample}`)
    }
    if (passthrough.length > 0) {
      out.push("<tsc: other>")
      out.push(...passthrough.slice(0, 20))
    }
    return out.join("\n")
  },
}

// ---- Shape: kubectl get pods --------------------------------------------
const S_kubectl: Shape = {
  id: "kubectl",
  match: () => false,
  apply(body) {
    const lines = body.split("\n")
    const out: string[] = []
    let run = 0
    const runRe = /\s+Running\s+.*\s+0\s+/
    const flush = () => {
      if (run < 2) {
        out.push(...bufferedRun)
      } else {
        out.push(`<[${run} pods folded — all Running, 0 restarts]>`)
      }
      bufferedRun = []
      run = 0
    }
    let bufferedRun: string[] = []
    for (const line of lines) {
      if (runRe.test(line)) {
        run++
        bufferedRun.push(line)
        continue
      }
      flush()
      out.push(line)
    }
    flush()
    out.push("<tip: rerun with -o json for a machine-readable projection>")
    return out.join("\n")
  },
}

// ---- Shape: json body ---------------------------------------------------
const JSON_HEAVY_KEYS = new Set([
  "embedding",
  "embeddings",
  "raw_html",
  "rawHtml",
  "body",
  "content",
  "base64",
  "data",
])
function trimJsonHeavy(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(trimJsonHeavy)
  if (value && typeof value === "object") {
    const out: Record<string, unknown> = {}
    for (const [key, sub] of Object.entries(value as Record<string, unknown>)) {
      if (JSON_HEAVY_KEYS.has(key) && typeof sub === "string" && sub.length > 200) {
        out[key] = `<elided ${sub.length} chars>`
        continue
      }
      if (JSON_HEAVY_KEYS.has(key) && Array.isArray(sub) && sub.length > 20) {
        out[key] = `<elided ${sub.length} items>`
        continue
      }
      out[key] = trimJsonHeavy(sub)
    }
    return out
  }
  return value
}
const S_json: Shape = {
  id: "json",
  match: () => false,
  apply(body) {
    const trimmed = body.trim()
    if (!trimmed) return body
    try {
      const parsed = JSON.parse(trimmed)
      const shrunk = trimJsonHeavy(parsed)
      return JSON.stringify(shrunk, null, 2)
    } catch {
      return body
    }
  },
}

// ---- Shape: markdown (gh pr view / gh issue view) -----------------------
const S_md: Shape = {
  id: "md",
  match: () => false,
  apply(body) {
    let out = body
    // HTML comments.
    out = out.replace(/<!--[\s\S]*?-->/g, "")
    // Shields.io / img.shields.io badge lines.
    out = out
      .split("\n")
      .filter((line) => !/!\[.*?\]\(https?:\/\/(?:img\.shields\.io|badge\.fury\.io)/.test(line))
      .filter((line) => !/^!\[[^\]]*\]\([^)]+\)\s*$/.test(line))
      .filter((line) => !/^\s*-{3,}\s*$/.test(line))
      .join("\n")
    // Collapse ≥3 blank lines to 1.
    out = out.replace(/\n{3,}/g, "\n\n")
    return out
  },
}

// ---- Shape: go test -json (NDJSON) --------------------------------------
type GoTestEvent = { Action?: string; Package?: string; Output?: string; Test?: string }
const S_gostest: Shape = {
  id: "gostest",
  match: () => false,
  apply(body) {
    const per = new Map<string, { pass: number; fail: number; skip: number; output: string[] }>()
    for (const rawLine of body.split("\n")) {
      if (!rawLine.trim()) continue
      let evt: GoTestEvent
      try {
        evt = JSON.parse(rawLine)
      } catch {
        continue
      }
      const pkg = evt.Package ?? "<unknown>"
      const slot = per.get(pkg) ?? { pass: 0, fail: 0, skip: 0, output: [] }
      if (evt.Action === "pass" && !evt.Test) slot.pass++
      else if (evt.Action === "fail" && !evt.Test) slot.fail++
      else if (evt.Action === "skip" && !evt.Test) slot.skip++
      if (evt.Action === "output" && evt.Output) slot.output.push(evt.Output)
      per.set(pkg, slot)
    }
    if (per.size === 0) return body
    const out: string[] = []
    for (const [pkg, { pass, fail, skip, output }] of per) {
      const marker = fail > 0 ? "FAIL" : skip > 0 ? "SKIP" : "PASS"
      out.push(`${marker} ${pkg} (pass=${pass} fail=${fail} skip=${skip})`)
      if (fail > 0) {
        const cause = output.slice(-20).join("").trim()
        if (cause) out.push(cause)
      }
    }
    return out.join("\n")
  },
}

const SHAPES: Record<string, Shape> = {
  gitdiff: S_gitdiff,
  pytest: S_pytest,
  npm: S_npm,
  make: S_make,
  stacktrace: S_stacktrace,
  tsc: S_tsc,
  kubectl: S_kubectl,
  json: S_json,
  md: S_md,
  gostest: S_gostest,
}

export function detectShape(text: string, command: string): string | null {
  if (shouldPassthrough(command)) return null
  const head4k = text.slice(0, HEAD_TAIL_BYTES)
  const tail4k = text.slice(-HEAD_TAIL_BYTES)
  return shapeFor({ command, head4k, tail4k })
}

export function cleanHeuristic(text: string, options: HeuristicOptions = {}): HeuristicResult {
  const bytesIn = Buffer.byteLength(text, "utf-8")
  if (!text) return { text, bytesIn, bytesOut: bytesIn, shape: null, degraded: false }
  const command = options.command ?? ""
  if (shouldPassthrough(command)) {
    return { text, bytesIn, bytesOut: bytesIn, shape: null, degraded: false }
  }
  const shape = detectShape(text, command)
  if (!shape) return { text, bytesIn, bytesOut: bytesIn, shape: null, degraded: false }
  const impl = SHAPES[shape]
  if (!impl) return { text, bytesIn, bytesOut: bytesIn, shape: null, degraded: false }
  const rewritten = impl.apply(text, { command })
  const bytesOut = Buffer.byteLength(rewritten, "utf-8")
  if (bytesOut >= bytesIn) {
    return { text, bytesIn, bytesOut: bytesIn, shape, degraded: true }
  }
  return { text: rewritten, bytesIn, bytesOut, shape, degraded: false }
}
