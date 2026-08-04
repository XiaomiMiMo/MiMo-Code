export * as BuiltinWorkflow from "./builtin"

// The scripts are read at BUILD time by a macro (mirrors the `bundle.macro.ts` pattern
// used for built-in skills), so their source is inlined into the bundle and ships inside
// a compiled binary without a runtime filesystem read — which a standalone binary has no
// filesystem for. Going through a macro rather than an import also keeps these files out
// of the module graph: they are function bodies ending in a top-level `return`, which any
// ESM parser rejects, and `bun test` did occasionally route one there when they were
// imported (docs/compose/spec/bun-text-import-esm-collision.md).
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

// Macros are not expanded in every transpile path — under `bun test` the import is
// stripped without the call being replaced, which surfaces as a ReferenceError. Falling
// back to the same function imported normally is the pattern skill/builtin/extract.ts
// established.
function safeLoadBuiltinScripts() {
  try {
    return loadBuiltinScripts()
  } catch (e) {
    if (e instanceof ReferenceError) return loadBuiltinScriptsDev()
    throw e
  }
}
const SOURCES = safeLoadBuiltinScripts()

// Built-in workflow scripts shipped with the binary, and the closed set of them: the
// bundle carries whatever is in the directory, this list is what actually registers. Add
// new built-ins here. Each is parsed ONCE at module load (meta is static data, not
// executed). A missing file or a malformed meta throws at module init, so a broken
// built-in fails the whole app boot naming the offending script.
const SCRIPTS = ["deep-research.js", "fact-check.js", "compose.js", "research-experiment.js"].map((file) => {
  const script = SOURCES[file]
  if (!script) throw new Error(`built-in workflow ${file} is missing from the bundle`)
  return { file, script }
})

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
