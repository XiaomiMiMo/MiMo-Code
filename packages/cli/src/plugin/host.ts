import path from "path"
import * as sdk from "@mimo-ai/plugin"
import * as sdkTool from "@mimo-ai/plugin/tool"
import * as sdkTui from "@mimo-ai/plugin/tui"
import type { ConfigPlugin } from "@/config/plugin"
import { Flag } from "@/flag/flag"
import * as Filesystem from "@/util/filesystem"

export const SDK_SPECIFIERS = ["@mimo-ai/plugin", "@mimo-ai/plugin/*"]

const modules: Record<string, Record<string, unknown>> = {
  "@mimo-ai/plugin": sdk,
  "@mimo-ai/plugin/tool": sdkTool,
  "@mimo-ai/plugin/tui": sdkTui,
}

let provided = false

// Embedders may define a partial Bun global on Node (MiMo Desktop shims
// Bun.file and Bun.write), so probe the capability rather than the global.
function canServeSdk() {
  return typeof Bun !== "undefined" && typeof Bun.plugin === "function"
}

// External plugins resolve the SDK to the host's own copy, so they need no
// node_modules and share the host's zod and tool() instead of a second install.
export function provideSdk() {
  if (provided || !canServeSdk()) return
  provided = true
  Bun.plugin({
    name: "mimocode-host-sdk",
    setup(build) {
      for (const [id, exports] of Object.entries(modules)) {
        build.module(id, () => ({ exports, loader: "object" }))
      }
    },
  })
}

// Without a host SDK (the Node build) or when asked explicitly, only plugins
// shipped in MIMOCODE_CONFIG_DIR load; user plugins never load half-working.
export function onlyConfigDir() {
  return !canServeSdk() || Flag.MIMOCODE_ONLY_CONFIG_DIR_PLUGINS
}

function inConfigDir(file: string) {
  const root = Flag.MIMOCODE_CONFIG_DIR
  if (!root || !path.isAbsolute(file)) return false
  const rel = path.relative(Filesystem.resolve(root), Filesystem.resolve(file))
  // Across Windows drives path.relative returns an absolute path, not "..".
  return !path.isAbsolute(rel) && rel !== ".." && !rel.startsWith(`..${path.sep}`)
}

export function filterOrigins(origins: ConfigPlugin.Origin[]) {
  if (!onlyConfigDir()) return origins
  return origins.filter((origin) => inConfigDir(origin.source))
}

export function filterDirectories(dirs: string[]) {
  if (!onlyConfigDir()) return dirs
  return dirs.filter(inConfigDir)
}

export * as PluginHost from "./host"
