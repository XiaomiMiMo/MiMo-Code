import path from "path"
import { Effect } from "effect"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Flag } from "@/flag/flag"
import { Path as GlobalPath } from "@/global"
import { InstallationLocal, InstallationVersion } from "@/installation/version"
import { Log } from "@/util"
import { loadBuiltinBundle } from "./bundle.macro" with { type: "macro" }
import { loadBuiltinBundle as loadBuiltinBundleDev } from "./bundle.macro"

export const DOCUMENT_SKILL_NAMES = new Set(["docx-official", "pdf-official", "pptx-official", "xlsx-official"])

const DOCUMENT_SKILL_TRIGGERS: Array<{
  skill: string
  mimes: readonly string[]
  filenameRe: RegExp
}> = [
  {
    skill: "pdf-official",
    mimes: ["application/pdf"],
    filenameRe: /\.pdf$/i,
  },
  {
    skill: "docx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
      "application/vnd.openxmlformats-officedocument.wordprocessingml.template",
      "application/msword",
    ],
    filenameRe: /\.(docx|dotx)$/i,
  },
  {
    skill: "xlsx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.spreadsheetml.sheet",
      "application/vnd.openxmlformats-officedocument.spreadsheetml.template",
      "application/vnd.ms-excel",
      "application/vnd.ms-excel.sheet.macroenabled.12",
      "text/csv",
      "text/tab-separated-values",
    ],
    filenameRe: /\.(xlsx|xlsm|xltx|csv|tsv)$/i,
  },
  {
    skill: "pptx-official",
    mimes: [
      "application/vnd.openxmlformats-officedocument.presentationml.presentation",
      "application/vnd.ms-powerpoint",
    ],
    filenameRe: /\.pptx$/i,
  },
]

export function builtinSkillRoot() {
  return path.join(GlobalPath.data, "builtin_skills", InstallationVersion, "skills")
}

export function matchDocumentSkills(candidates: Array<{ mime?: string; filename?: string }>): string[] {
  const hits = new Set<string>()
  for (const candidate of candidates) {
    for (const trigger of DOCUMENT_SKILL_TRIGGERS) {
      if (candidate.mime && trigger.mimes.includes(candidate.mime)) {
        hits.add(trigger.skill)
        continue
      }
      if (candidate.filename && trigger.filenameRe.test(candidate.filename)) {
        hits.add(trigger.skill)
      }
    }
  }
  return DOCUMENT_SKILL_TRIGGERS.filter((t) => hits.has(t.skill)).map((t) => t.skill)
}

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
  const skillsRoot = builtinSkillRoot()
  const root = path.dirname(skillsRoot)
  const marker = path.join(root, ".extracted")

  if (!InstallationLocal && (yield* fsys.existsSafe(marker))) return root

  for (const [skillName, files] of Object.entries(BUILTIN_BUNDLE)) {
    if (Flag.MIMOCODE_DISABLE_DOCUMENT_SKILLS && DOCUMENT_SKILL_NAMES.has(skillName)) continue
    const skillDir = path.join(skillsRoot, skillName)
    for (const [relPath, content] of Object.entries(files)) {
      yield* fsys.writeWithDirs(path.join(skillDir, relPath), content)
    }
  }
  yield* fsys.writeWithDirs(marker, InstallationVersion)
  log.info("extracted builtin skills", { root })
  return root
})
