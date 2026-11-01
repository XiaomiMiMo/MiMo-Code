export * as ConfigHost from "./host"

import path from "path"
import { Flag } from "@/flag/flag"
import { Global } from "@/global"
import * as Filesystem from "@/util/filesystem"

// Desktop can provide a partial Bun shim on Node; only the plugin capability
// distinguishes a runtime that supports unrestricted external configuration.
export function canServePluginSdk() {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function"
}

export function onlyConfigDir() {
  return !canServePluginSdk() || Flag.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
}

function within(root: string | undefined, source: string) {
  if (!root || !path.isAbsolute(source)) return false
  const rel = path.relative(Filesystem.resolve(root), Filesystem.resolve(source))
  // Different Windows drives produce an absolute relative path.
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
}

export function inConfigDir(source: string) {
  return within(Flag.MIMOCODE_CONFIG_DIR, source)
}

// The user's own global config directory is as trusted as the host directory:
// the restriction targets project-supplied configuration. Paths are resolved,
// so a global file symlinked into a project stays rejected.
export function inGlobalConfigDir(source: string) {
  return within(Global.Path.config, source)
}

export function allowsExecution(source: string) {
  if (!onlyConfigDir()) return true
  if (source === "MIMOCODE_CONFIG_CONTENT" || source === "MIMOCODE_CONFIG_DEFAULTS") return true
  return inConfigDir(source) || inGlobalConfigDir(source)
}
