import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Path as GlobalPath } from "@/global"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { Log } from "@/util"
import { loadBuiltinBundle } from "./bundle.macro" with { type: "macro" }
import { loadBuiltinBundle as loadBuiltinBundleDev } from "./bundle.macro"

function safeLoadBuiltinBundle() {
  try {
    return loadBuiltinBundle()
  } catch(e) {
    if (e instanceof ReferenceError) {
      return loadBuiltinBundleDev()
    }
    throw e
  }
}
const BUILTIN_BUNDLE = safeLoadBuiltinBundle()

const log = Log.create({ service: "skill.builtin" })

export const extractBuiltinBundle = Effect.fn("Skill.extractBuiltinBundle")(function* (
  fsys: AppFileSystem.Interface,
) {
  const root = path.join(GlobalPath.data, "builtin_skills", InstallationVersion)
  const marker = path.join(root, ".extracted")

  if (!InstallationLocal && (yield* fsys.existsSafe(marker))) return root

  for (const [skillName, files] of Object.entries(BUILTIN_BUNDLE)) {
    const skillDir = path.join(root, "skills", skillName)
    for (const [relPath, content] of Object.entries(files)) {
      yield* fsys.writeWithDirs(path.join(skillDir, relPath), content)
    }
  }
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted builtin skills", { root })
  return root
})
