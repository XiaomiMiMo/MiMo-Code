import { describe, expect, test } from "bun:test"
import { resolvePromptCommand } from "../../../src/cli/cmd/tui/component/prompt/part"

const commands = [
  { name: "review", source: "skill", bundled: true },
  { name: "custom-skill", source: "skill" },
  { name: "build", source: "command" },
]
const t = (key: string) => (key === "tui.skill.review.slash" ? "审查|检查" : "")

describe("skill picker submit routing", () => {
  test.each(["review", "custom-skill"])("routes picker prefix /%s to command with empty arguments", (skill) => {
    expect(resolvePromptCommand(`/${skill} `, commands, t)).toEqual({ command: skill, arguments: "" })
  })

  test("strips only the command prefix and preserves multiline arguments", () => {
    expect(resolvePromptCommand("/review inspect src\nthen test /review", commands, t)).toEqual({
      command: "review",
      arguments: "inspect src\nthen test /review",
    })
    expect(resolvePromptCommand("/custom-skill  keep  spacing", commands, t)).toEqual({
      command: "custom-skill",
      arguments: " keep  spacing",
    })
  })

  test("resolves a synchronized bundled skill alias to its canonical command", () => {
    expect(resolvePromptCommand("/审查 文件\n第二行", commands, t)).toEqual({
      command: "review",
      arguments: "文件\n第二行",
    })
  })

  test("prefers an exact registered command over a skill alias", () => {
    expect(resolvePromptCommand("/审查 file", [...commands, { name: "审查", source: "command" }], t)).toEqual({
      command: "审查",
      arguments: "file",
    })
  })

  test.each([
    "/unknown request",
    "/review-extra request",
    "/tmp/project/file.ts",
    "/review/file.ts",
    "./src/file.ts",
    "src/file.ts",
    "please /review this",
    " /review this",
    "/review\tfile",
  ])("leaves %j on the prompt path", (input) => {
    expect(resolvePromptCommand(input, commands, t)).toBeUndefined()
  })

  test("uses the edited prefix rather than retaining the picker selection", () => {
    let input = "/review "
    expect(resolvePromptCommand(input, commands, t)?.command).toBe("review")
    input = "/custom-skill changed"
    expect(resolvePromptCommand(input, commands, t)).toEqual({ command: "custom-skill", arguments: "changed" })
    input = "/build changed"
    expect(resolvePromptCommand(input, commands, t)).toEqual({ command: "build", arguments: "changed" })
    input = "/missing changed"
    expect(resolvePromptCommand(input, commands, t)).toBeUndefined()
    input = "review changed"
    expect(resolvePromptCommand(input, commands, t)).toBeUndefined()
  })

  test("a picker-confirmed skill routes to command while the catalog is pending", () => {
    expect(resolvePromptCommand("/review inspect", [], t, "review")).toEqual({ command: "review", arguments: "inspect" })
    expect(resolvePromptCommand("/review ", [], t, "review")).toEqual({ command: "review", arguments: "" })
    expect(resolvePromptCommand("/other inspect", [], t, "review")).toBeUndefined()
    expect(resolvePromptCommand("/review/file.ts", [], t, "review")).toBeUndefined()
    expect(resolvePromptCommand("/review-extra inspect", [], t, "review")).toBeUndefined()
  })

  test("an unselected slash requires a synchronized command list",  () => {
    const input = "/review inspect"
    expect(resolvePromptCommand(input, [], t)).toBeUndefined()
    expect(resolvePromptCommand("/审查 inspect", [], t)).toBeUndefined()
    expect(resolvePromptCommand(input, commands, t)).toEqual({ command: "review", arguments: "inspect" })
    expect(resolvePromptCommand(input, commands.filter((command) => command.name !== "review"), t)).toBeUndefined()
  })
})
