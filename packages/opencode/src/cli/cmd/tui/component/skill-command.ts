import type { Skill } from "@/skill"
import type { DialogSelectOption } from "@tui/ui/dialog-select"
import type { CommandOption } from "./dialog-command"

const skillDescription = (skill: Skill.Info) => skill.description.replace(/\s+/g, " ").trim()

export function skillSelectOptions(
  skills: Skill.Info[],
  input: {
    isCompose: boolean
    onSelect: (name: string) => void
  },
): DialogSelectOption<string>[] {
  const list = skills.filter((skill) => !skill.hidden && (input.isCompose || !skill.name.startsWith("compose:")))
  const maxWidth = Math.max(0, ...list.map((skill) => skill.name.length))
  return list.map((skill) => ({
    title: skill.name.padEnd(maxWidth),
    description: skillDescription(skill),
    value: skill.name,
    category: "Skills",
    onSelect: () => input.onSelect(skill.name),
  }))
}

export function skillCommandOptions(
  skills: Skill.Info[],
  input: {
    isCompose: boolean
    onSelect: (name: string) => void
  },
): CommandOption[] {
  return skillSelectOptions(skills, input).map((option) => ({
    ...option,
    value: `skill.${option.value}`,
    slash: {
      name: option.value,
    },
    onSelect: (dialog) => {
      input.onSelect(option.value)
      dialog.clear()
    },
  }))
}
