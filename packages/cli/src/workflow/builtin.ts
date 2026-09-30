export * as BuiltinWorkflow from "./builtin"

// A macro, not an import, so these function bodies never enter the module graph and no ESM
// parser can reach them. docs/compose/spec/bun-text-import-esm-collision.md explains why.
import { loadBuiltinScripts } from "./builtin.macro" with { type: "macro" }
import { loadBuiltinScripts as loadBuiltinScriptsDev } from "./builtin.macro"
import { parseMeta } from "./meta"

export type Entry = {
  name: string
  description: string
  whenToUse?: string
  phases?: { title: string; detail?: string }[]
  script: string
}

// `bun test` strips the macro import without replacing the call, so fall back to the same
// function imported normally — the pattern skill/builtin/extract.ts established.
function safeLoadBuiltinScripts() {
  try {
    return loadBuiltinScripts()
  } catch (e) {
    if (e instanceof ReferenceError) return loadBuiltinScriptsDev()
    throw e
  }
}

// Parsed ONCE at module load; `file` names the offending script if a meta is malformed.
const SCRIPTS = safeLoadBuiltinScripts()

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
