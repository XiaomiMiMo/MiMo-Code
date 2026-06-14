export * as BuiltinWorkflow from "./builtin"

// `with { type: "text" }` makes Bun inline the .js file's SOURCE as a string
// (not import it as a module) and embeds it into the compiled binary via
// `bun build --compile` (mirrors the `with { type: "file" }` asset pattern in
// script/build.ts) — so the built-in script ships with the binary. The Bun
// runtime and bundler both honour this, but tsgo resolves the .js as a real
// module and flags TS1192 ("no default export"); the suppression is scoped to
// this single import. A `Bun.file(...).text()` fallback is intentionally NOT
// used: it reads the real filesystem at runtime, which does not exist inside a
// compiled standalone binary.
// @ts-expect-error TS1192: import-attribute text loader, resolved by Bun not tsgo
import DEEP_RESEARCH_SCRIPT from "./builtin/deep-research.js" with { type: "text" }
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
const SCRIPTS: { file: string; script: string }[] = [{ file: "deep-research.js", script: DEEP_RESEARCH_SCRIPT }]

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
