export * as BuiltinWorkflow from "./builtin"

// These scripts are workflow FUNCTION BODIES, not modules — each ends in a
// top-level `return`, which is a syntax error to an ESM parser. The `.js.fn`
// extension says so, and keeps any loader from trying: a `.js` name here made
// `bun test` occasionally route one through the module parser (see
// docs/compose/spec/bun-text-import-esm-collision.md).
// `with { type: "text" }` makes Bun inline the SOURCE as a string and embed it
// into the compiled binary via `bun build --compile` (mirrors the
// `with { type: "file" }` asset pattern in script/build.ts) — so the built-in
// script ships with the binary. A `Bun.file(...).text()` fallback is
// intentionally NOT used: it reads the real filesystem at runtime, which does
// not exist inside a compiled standalone binary.
import DEEP_RESEARCH_SCRIPT from "./builtin/deep-research.js.fn" with { type: "text" }
import FACT_CHECK_SCRIPT from "./builtin/fact-check.js.fn" with { type: "text" }
import COMPOSE_SCRIPT from "./builtin/compose.js.fn" with { type: "text" }
import RESEARCH_EXPERIMENT_SCRIPT from "./builtin/research-experiment.js.fn" with { type: "text" }
import { parseMeta } from "./meta"

export type Entry = {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  script: string
}

// Built-in workflow scripts shipped with the binary. Each is parsed ONCE at
// module load (meta is static data, not executed). Add new built-ins here.
// `file` is carried so a malformed meta names the offending script — this throw
// runs at module init, so a broken built-in fails the whole app boot; the path
// tells the user which one.
const SCRIPTS: { file: string; script: string }[] = [
  { file: "deep-research.js.fn", script: DEEP_RESEARCH_SCRIPT },
  { file: "fact-check.js.fn", script: FACT_CHECK_SCRIPT },
  { file: "compose.js.fn", script: COMPOSE_SCRIPT },
  { file: "research-experiment.js.fn", script: RESEARCH_EXPERIMENT_SCRIPT },
]

// Null-prototype so the registry is a self-evidently closed set: a lookup like
// get("constructor")/get("toString") returns undefined, not an inherited
// Object.prototype member.
const REGISTRY: Record<string, Entry> = Object.create(null)
for (const { file, script } of SCRIPTS) {
  const parsed = parseMeta(script)
  if (!parsed.ok) throw new Error(`built-in workflow ${file} failed to parse meta: ${parsed.error}`)
  const meta = parsed.meta
  REGISTRY[meta.name] = {
    name: meta.name,
    description: meta.description,
    whenToUse: meta.whenToUse,
    phases: meta.phases,
    script,
  }
}

export function list(): Entry[] {
  return Object.values(REGISTRY).sort((a, b) => a.name.localeCompare(b.name))
}

export function get(name: string): Entry | undefined {
  return REGISTRY[name]
}
