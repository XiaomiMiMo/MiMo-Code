import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Path as GlobalPath } from "@/global"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { Log } from "@/util"
import { loadComposeBundle } from "./bundle.macro" with { type: "macro" }
import { loadComposeBundle as loadComposeBundleDev } from "./bundle.macro"

/// Bun macros only resolve in the static import graph of an entry point.
/// In dynamic import() chains (e.g. plugin tests), the macro is unavailable —
/// fall back to a normal runtime import of the same function.
/// `typeof loadComposeBundle` is always "undefined" even after macro expansion
/// (Bun replaces the call site, not the binding), so use try/catch instead.
function safeLoadComposeBundle() {
  try {
    return loadComposeBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadComposeBundleDev()
    }
    throw e
  }
}
const COMPOSE_BUNDLE = safeLoadComposeBundle()

const log = Log.create({ service: "skill.compose" })

export const extractComposeBundle = Effect.fn("Skill.extractComposeBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const root = path.join(GlobalPath.data, "compose", InstallationVersion)
  const marker = path.join(root, ".extracted")

  if (!InstallationLocal && (yield* fsys.existsSafe(marker))) return root

  for (const [skillName, files] of Object.entries(COMPOSE_BUNDLE)) {
    const skillDir = path.join(root, "skills", skillName)
    for (const [relPath, content] of Object.entries(files)) {
      yield* fsys.writeWithDirs(path.join(skillDir, relPath), content)
    }
  }
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted compose skills", { root })
  return root
})

