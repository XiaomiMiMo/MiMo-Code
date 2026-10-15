import os from "os"
import path from "path"
import { LANGUAGE_EXTENSIONS } from "@/lsp/language"

function pathString(input: unknown): string {
  return typeof input === "string" ? input : ""
}

function homeDir(): string {
  // Mirrors Global.Path.home: HOME/USERPROFILE read directly because Bun caches
  // os.homedir() at startup, and tests set these env vars to isolate.
  return process.env.HOME || process.env.USERPROFILE || os.homedir()
}

export function normalizePath(input: unknown): string {
  const value = pathString(input)
  if (!value) return ""

  const cwd = process.cwd()
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use absolute
  return absolute
}

export function normalizePermissionPath(input: unknown): string {
  const value = pathString(input)
  if (!value) return ""

  const cwd = process.cwd()
  const home = homeDir()
  const absolute = path.isAbsolute(value) ? value : path.resolve(cwd, value)
  const relative = path.relative(cwd, absolute)

  if (!relative) return "."
  if (!relative.startsWith("..")) return relative

  // outside cwd - use ~ or absolute
  if (home && (absolute === home || absolute.startsWith(home + path.sep))) {
    return absolute.replace(home, "~")
  }
  return absolute
}

export function normalizeRunPath(input: unknown): string {
  const value = pathString(input)
  if (!value) return ""
  if (path.isAbsolute(value)) return path.relative(process.cwd(), value) || "."
  return value
}

export function filetype(input: unknown): string | undefined {
  const value = pathString(input)
  if (!value) return "none"
  const ext = path.extname(value)
  const language = LANGUAGE_EXTENSIONS[ext]
  if (["typescriptreact", "javascriptreact", "javascript"].includes(language)) return "typescript"
  return language
}
