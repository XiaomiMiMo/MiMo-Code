import { describe, expect, test } from "bun:test"
import type { Skill } from "../../../../src/skill"
import { skillCommandOptions } from "../../../../src/cli/cmd/tui/component/skill-command"

const skill = (input: Partial<Skill.Info> & Pick<Skill.Info, "name">): Skill.Info => ({
  name: input.name,
  description: input.description ?? `Description for ${input.name}`,
  location: input.location ?? `/tmp/${input.name}/SKILL.md`,
  content: input.content ?? "# Skill",
  hidden: input.hidden,
})

describe("skill command options", () => {
  test("creates slash commands for visible discovered skills", () => {
    const selected: string[] = []
    let cleared = false
    const options = skillCommandOptions(
      [
        skill({
          name: "gpt",
          description: 'Use when user says "/gpt" to delegate a task.',
        }),
        skill({
          name: "compose:plan",
        }),
        skill({
          name: "hidden-skill",
          hidden: true,
        }),
      ],
      {
        isCompose: false,
        onSelect: (name) => selected.push(name),
      },
    )

    expect(options.map((option) => option.slash?.name)).toEqual(["gpt"])
    expect(options[0].description).toBe('Use when user says "/gpt" to delegate a task.')
    expect(options[0].value).toBe("skill.gpt")

    options[0].onSelect?.({
      clear: () => {
        cleared = true
      },
    } as Parameters<NonNullable<(typeof options)[number]["onSelect"]>>[0])

    expect(selected).toEqual(["gpt"])
    expect(cleared).toBe(true)
  })
})
