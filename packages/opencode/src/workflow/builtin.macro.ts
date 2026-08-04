import fs from "fs"
import path from "path"

// Built-in workflow scripts, read at BUILD time so their source is inlined into the bundle
// and the files never enter the module graph. They are function bodies ending in a top-level
// `return`, which an ESM parser rejects; staying out of the graph is what keeps any loader
// from trying. The directory is the registry, as it is for built-in skills.
// Takes no arguments because macro call sites must be statically known, which rules out a
// per-filename signature.
export function loadBuiltinScripts() {
  const dir = path.resolve(import.meta.dir, "builtin")
  return fs
    .readdirSync(dir)
    .filter((file) => file.endsWith(".js"))
    .sort()
    .map((file) => ({ file, script: fs.readFileSync(path.join(dir, file), "utf8") }))
}
