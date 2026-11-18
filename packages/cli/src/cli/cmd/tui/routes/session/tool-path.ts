import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

/**
 * `part.state.input` is persisted model output, so every field the TUI reads
 * from it is untrusted at runtime even when the tool's schema says `string`.
 * A persisted `read` part whose `file_path` was `{"limit":120,"offset":161}`
 * reaches the renderer on every replay; `path.isAbsolute` / `path.extname`
 * then throw `TypeError: The "path" property must be of type string, got
 * object`, which kills the whole TUI. An object is truthy, so the old
 * `if (!input) return ""` guard never caught it.
 */
export function toolPathString(value: unknown): string | undefined {
  if (typeof value !== "string") return undefined
  if (value.length === 0) return undefined
  return value
}

export function filetype(value: unknown): string {
  const input = toolPathString(value)
  if (!input) return "none"
  const ext = path.extname(input)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}

/**
 * Relative when the path resolves inside cwd, absolute when it does not. Pass
 * `home` to collapse paths outside cwd but under the user's home directory to
 * their `~` form instead of printing the absolute path.
 */
export function normalizePath(value: unknown, options?: { home?: string }): string {
  const input = toolPathString(value)
  if (!input) return ""

  const cwd = process.cwd()
  const home = options?.home
  const absolute = path.isAbsolute(input) ? input : path.resolve(cwd, input)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ when a home directory is known, else absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}
