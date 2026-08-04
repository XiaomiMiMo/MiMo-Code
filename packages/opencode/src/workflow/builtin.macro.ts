import fs from "fs"
import path from "path"

// Build-time reader for the built-in workflow scripts, consumed as a Bun macro so the
// source is inlined at transpile and the files never enter the module graph. They are
// function bodies ending in a top-level `return`, so an ESM parser would reject them;
// staying out of the graph is what keeps any loader from trying.
// Takes no arguments on purpose: macro call sites must be statically known, so a
// per-filename signature cannot be wrapped in the dev fallback builtin.ts needs.
export function loadBuiltinScripts(): Record<string, string> {
  const dir = path.resolve(import.meta.dir, "builtin")
  return Object.fromEntries(
    fs
      .readdirSync(dir)
      .filter((file) => file.endsWith(".js"))
      .map((file) => [file, fs.readFileSync(path.join(dir, file), "utf8")]),
  )
}
