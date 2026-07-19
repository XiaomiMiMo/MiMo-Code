import path from "path"
import { pathToFileURL } from "url"
import { Effect } from "effect"
import * as Stream from "effect/Stream"
import type { Ripgrep } from "../file/ripgrep"
import { Flag } from "../flag/flag"
import type { Skill } from "../skill"

export const renderSkillContent = Effect.fn("SkillContent.render")(function* (
  info: Skill.Info,
  rg: Ripgrep.Interface,
  signal: AbortSignal,
) {
  const dir = path.dirname(info.location)
  const files = yield* rg.files({ cwd: dir, follow: false, hidden: true, signal }).pipe(
    Stream.filter((file) => !file.includes("SKILL.md")),
    Stream.map((file) => path.resolve(dir, file)),
    Stream.take(Flag.MIMOCODE_SKILL_SEARCH_FILE_SAMPLE_LIMIT),
    Stream.runCollect,
    Effect.map((chunk) => [...chunk].map((file) => `<file>${file}</file>`).join("\n")),
  )

  return {
    dir,
    output: [
      `<skill_content name="${info.name}">`,
      `# Skill: ${info.name}`,
      "",
      info.content.trim(),
      "",
      `Base directory for this skill: ${pathToFileURL(dir).href}`,
      "Relative paths in this skill (e.g., scripts/, reference/) are relative to this base directory.",
      "Note: file list is sampled.",
      "",
      "<skill_files>",
      files,
      "</skill_files>",
      "</skill_content>",
    ].join("\n"),
  }
})
