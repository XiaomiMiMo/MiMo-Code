import { dict as zh } from "../cli/cmd/tui/i18n/zh"
import { dict as zht } from "../cli/cmd/tui/i18n/zht"
import type { Skill } from "."

const dictionaries: Record<string, string>[] = [zh, zht]

export function localizedAliases(skill: Skill.Info) {
  if (!skill.bundled || skill.name.startsWith("compose:")) return []
  return [
    ...new Set(
      dictionaries.flatMap((dict) =>
        (dict[`tui.skill.${skill.name}.slash`] ?? "")
          .split("|")
          .map((alias) => alias.trim())
          .filter(Boolean),
      ),
    ),
  ]
}
