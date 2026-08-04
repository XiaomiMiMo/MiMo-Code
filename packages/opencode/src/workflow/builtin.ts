export * as BuiltinWorkflow from "./builtin"

// Read at BUILD time by a macro, so the sources are inlined into the bundle and ship inside
// a compiled binary, which has no filesystem to read them from. Going through a macro rather
// than an import is also what keeps these files out of the module graph: they are function
// bodies ending in a top-level `return`, which any ESM parser rejects, and `bun test` did
// occasionally route one there when they were imported
// (docs/compose/spec/bun-text-import-esm-collision.md).
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

// Macros are not expanded in every transpile path — under `bun test` the import is stripped
// without the call being replaced, which surfaces as a ReferenceError. Falling back to the
// same function imported normally is the pattern skill/builtin/extract.ts established.
function safeLoadBuiltinScripts() {
  try {
    return loadBuiltinScripts()
  } catch (e) {
    if (e instanceof ReferenceError) return loadBuiltinScriptsDev()
    throw e
  }
}

// Each script is parsed ONCE at module load (meta is static data, not executed). `file` is
// carried so a malformed meta names the offending script — that throw runs at module init, so
// a broken built-in fails the whole app boot and says which one.
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
