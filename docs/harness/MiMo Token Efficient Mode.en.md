# MiMo Token Efficient Mode

**One-line summary**: Uses a generic regex filter pipeline + heuristic filter pipeline to strip redundant tokens from Bash output (experimental feature, disabled by default).

## 1. Background & Goals

The bash tool's stdout/stderr are often "blown up" with the following noise:

- ANSI color codes, OSC hyperlinks, DCS terminal control sequences

- `\r` progress bar multi-frame overlays

- Accidentally printed API keys / JWTs / PEM certificates

- Ultra-long lines like minified JS / single-line JSON

- Useless info from pytest/go test/...

**Core constraint**: Cleaning only targets the LLM view; TUI live preview and on-disk archives keep the raw bytes intact for human debugging.

## 2. Overall Flow

The diagram below shows the end-to-end cleanup path for bash tool output from capture to delivery to the LLM. It integrates the generic filter pipeline (Chapter 3), heuristic filter pipeline (Chapter 4), and the three-way split constraints for inline / on-disk / TUI (Chapter 5).

The three core constraints and where they sit in the diagram:

- **Clean inline only, not on-disk** — the two leftmost paths at the entrance split (disk archive / TUI preview) bypass the entire pipeline.

- **Never-worse gate** — unified rollback at the pipeline tail: any stage that makes the output larger is discarded, falling back to the Raw path.

- **Single flag, off by default** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` is the only switch that enters the cleanup pipeline, and it's disabled by default; otherwise output goes straight through Raw.




## 3. Generic Filter Pipeline



|**Layer**|**Responsibility**|**Key regex / algorithm**|**Ordering constraint**|
|---|---|---|---|
|clean_progress_pipeline|Per-line, collapse \r progress bars, keep only the last frame|Split by lines, take the segment after the last \r on each line|Must run before clean_ansi_pipeline|
|clean_ansi_pipeline|Strip ANSI CSI/OSC/DCS, backspace overstrike, control bytes|4 ESC sequence regexes + control-byte character class|After progress, before downstream regexes|
|clean_redact_pipeline|PEM, Bearer, JWT, AWS/GH/OpenAI/Anthropic/Slack keys|8 regex groups + cross-line PEM block whole-match replacement|Must run before dedup/truncation|
|clean_longline_pipeline|Compress single lines over 500 chars to a 160-char head + elision hint|Per-line scan, length-threshold check|Placed last as a safety net|
|never-worse gate|If cleanup didn't shrink bytes, roll back to original text|When bytesOut ≥ bytesIn, return the original text|Pipeline tail|

### 3.1 Regex Quick Reference per Layer

The constants below correspond directly to the implementation in `packages/opencode/src/tool/bash_token_efficient.ts`. L1 / L4 are per-line scan algorithms with no standalone regex; L0 / L3 together define 14 regexes (4 ESC + 1 control byte + 1 cross-line PEM + 8 inline secrets).

**L0 clean_ansi — 4 ESC regexes + 1 control-byte character class**

```ts
const ANSI_CSI   = /\x1b\[[0-?]*[ -/]*[@-~]/g              // CSI sequence  ESC[ ... terminator
const ANSI_OSC   = /\x1b\][^\x07\x1b]*(?:\x07|\x1b\\)/g    // OSC sequence  ESC] ... BEL or ESC\
const ANSI_DCS   = /\x1b[PX^_][\s\S]*?\x1b\\/g             // DCS/SOS/PM/APC cross-line sequence
const BACKSPACE  = /[^\n]\x08/g                            // Backspace overstrike  loop-replace until no matches
const CTRL_BYTES = /[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g     // Control bytes  keep \t \n \r
```

**L3 clean_redact — 1 cross-line PEM whole block + 8 inline secret patterns**

```ts
// Cross-line PEM block whole replacement → <redacted-pem-block>
const PEM_BLOCK = /-----BEGIN [A-Z ]+-----[\s\S]*?-----END [A-Z ]+-----/g

const REDACT_PATTERNS: Array<[RegExp, string]> = [
  // Bearer / Token <opaque>
  [/\b(Bearer|Token)\s+[A-Za-z0-9._\-+/=]{16,}/gi,                          "$1 <redacted>"],
  // JWT  eyJ three base64url segments (each ≥10 chars)
  [/\beyJ[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}\.[A-Za-z0-9_\-]{10,}/g,    "<redacted-jwt>"],
  // AWS access key  AKIA / ASIA prefix + 16 uppercase alphanumeric
  [/\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/g,                                        "<redacted-aws-key>"],
  // GitHub fine-grained / classic  gh[pousr]_ + ≥20 chars
  [/\bgh[pousr]_[A-Za-z0-9]{20,}\b/g,                                       "<redacted-gh-token>"],
  // OpenAI  sk- + ≥20 chars
  [/\bsk-[A-Za-z0-9_\-]{20,}\b/g,                                           "<redacted-openai-key>"],
  // Anthropic  sk-ant- + ≥20 chars
  [/\bsk-ant-[A-Za-z0-9_\-]{20,}\b/g,                                       "<redacted-anthropic-key>"],
  // Slack  xox[abprs]- + ≥10 chars
  [/\bxox[abprs]-[A-Za-z0-9\-]{10,}\b/g,                                    "<redacted-slack-token>"],
  // Generic KEY=VALUE / "key": "value"  value ≥12 chars
  [
    /\b((?:api|access|refresh|secret|client|auth)[_-]?(?:key|token|secret|password))(\s*[:=]\s*)["']?[A-Za-z0-9._\-+/=]{12,}["']?/gi,
    "$1$2<redacted>",
  ],
]
```

**L1 clean_progress — Per-line collapse of `\r` progress bars**

```ts
// Algorithm  no standalone regex
text.split("\n").map(line => {
  const stripped = line.endsWith("\r") ? line.slice(0, -1) : line
  const idx = stripped.lastIndexOf("\r")
  return idx === -1 ? stripped : stripped.slice(idx + 1)   // keep only the last frame
}).join("\n")
```

**L4 clean_longline — Ultra-long single-line compression**

```ts
const MAX_LINE_CHARS = 500
const LINE_HEAD_KEEP = 160

text.split("\n").map(line => {
  if (line.length <= MAX_LINE_CHARS) return line
  return `${line.slice(0, LINE_HEAD_KEEP)}…<elided ${line.length - LINE_HEAD_KEEP} chars>`
}).join("\n")
```

**never-worse gate — Pipeline-tail rollback**

```ts
const bytesOut = Buffer.byteLength(out, "utf-8")
if (bytesOut + NEVER_WORSE_MARGIN >= bytesIn) {
  return { text, bytesIn, bytesOut: bytesIn, degraded: true }   // no savings  return original
}
```

## 4. Heuristic Filter Pipeline

### 4.1 Two-Channel Shape Detection

We can't rely on the command name alone (users often nest pipes: `bash -c "cd x && pytest"`), nor on the start of the output alone (the first 30 lines might be all ANSI noise). Two channels run in series:

```ts
// Command-name channel
const COMMAND_PATTERNS: Array<[RegExp, ShapeID]> = [
  [/^pytest(\s|$)/,                "pytest"],
  [/^(npm|pnpm|yarn)\s+(install|i|add)/, "npm"],
  [/^(make|cmake|automake)/,       "make"],
  [/^git\s+diff/,                  "gitdiff"],
  [/^tsc(\s|$)/,                   "tsc"],
  [/^kubectl\s+get\s+pods?/,       "kubectl"],
  [/^go\s+test.*-json/,            "gostest"],
  [/^gh\s+(pr|issue)\s+view/,      "md"],
]

// Content-fingerprint channel (fallback when command name doesn't match)
const BODY_FINGERPRINTS: Array<[RegExp, ShapeID]> = [
  [/^={5,}\s+test session starts\s+={5,}/m, "pytest"],
  [/^diff --git /m,                          "gitdiff"],
  [/^Traceback \(most recent call last\)/m,  "stacktrace"],
  [/^\s*at .+:\d+:\d+/m,                     "stacktrace"],
  [/^error\[E\d+\]:/m,                       "stacktrace"],
]
```

### 4.2 Shape Strategy Quick Reference

|**Command match**|**Core trimming rule**|**Expected reduction**|
|---|---|---|
|git diff / git show|Whole-block suppress by lockfile / min.js / dist path allowlist; single-hunk 100-line cap; append +added -removed at file tail|85%|
|pytest|4-state machine Header → TestProgress → Failures → Summary, keep collected / E lines / file:line: / FAILED / short summary|90%|
|npm/pnpm/yarn install|Fold consecutive "npm warn deprecated" into [×N deprecation warnings: top: A, B, C], keep added/vuln/funding summary|65%|
|make / cmake / automake|Drop Entering/Leaving directory, bare compile commands, carets; keep file:line:col: error: and the note: below|53%|
|Traceback / at ...:N:N / error[E...]|Fold site-packages / .venv / node_modules / stdlib frames; merge ≥2 consecutive into [N dependency frame(s) suppressed]|69%|
|tsc|Group by error code Top-5 with one-line summary; group by file Top-8; keep 1 sample per group|80%|
|kubectl get pods|Trailer suggests -o json; client-side only folds "all Running/0 restart" consecutive lines, doesn't rewrite columns|70%|
|Output starting with { or [|Two modes: default trims embedding/raw_html/body/content/base64 large fields; schema-only mode infers keys plus types|95%|
|gh pr view / gh issue view|Clean HTML comments, badge lines, pure image lines, decorative ---, extra blank lines|~50%|
|go test ... -json|NDJSON stream aggregation: accumulate pass/fail/skip per pkg; on fail use accumulated output as cause|90%|

### 4.2 Command-Level Passthrough

Let output through unmodified when the user is already doing projection:

- Command contains `--json` / `--format json` / `-o json` / `--no-color`

- Command tail contains `| tee` / `| xxd` / `| hexdump`

- Command contains `# nofilter` / `# raw` (already implemented)

### 4.5 Extension Contract

New shapes just need to implement the `Shape { match, apply }` interface, no changes needed at the main entry point:

```TypeScript
export interface Shape {
  id: string
  match: (command: string, head4k: string, tail4k: string) => boolean
  apply: (body: string, ctx: { command: string }) => string
}

const SHAPES = [S_gitdiff, S_pytest, S_npm, S_make, S_stacktrace,
                S_tsc, S_kubectl, S_json, S_md, S_gostest]
```



## 5. Other Details

**Clean inline only, not on-disk** — as soon as output reaches the truncation file (either early streaming overflow or the final `trunc.write(raw)`), cleanup is skipped. Disk archives preserve raw bytes for human grep; only inline output enters the cleanup pipeline, spending the byte savings on the most-frequently-read path.

**TUI preview untouched** — `metadata.output` is the TUI live-preview field, kept as the raw streaming snapshot; only the final `output` goes through cleanup. This avoids cleanup side effects interfering with a human reading the original terminal output.

**Single flag, off by default** — `MIMOCODE_EXPERIMENTAL_TOKEN_EFFICIENCY` is a standalone flag controlling the switch, off by default, not derived from `MIMOCODE_EXPERIMENTAL=1`. Explicit opt-in avoids silently changing the default output.

