import { describe, expect, test } from "bun:test"
import path from "path"
import { deriveNamespace } from "../../src/skill/index"

const loc = (...parts: string[]) => path.join("/home/user/.config/mimocode", ...parts)

describe("deriveNamespace", () => {
  test("top-level skill has no namespace", () => {
    expect(deriveNamespace(loc("skills", "agent-eval", "SKILL.md"), "agent-eval")).toBeUndefined()
  })

  test("parent folder becomes the namespace", () => {
    expect(deriveNamespace(loc("skills", "ECC", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("deep nesting uses the first segment after skills/", () => {
    expect(deriveNamespace(loc("skills", "ECC", "tools", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("singular skill/ marker works", () => {
    expect(deriveNamespace(loc("skill", "ECC", "agent-eval", "SKILL.md"), "agent-eval")).toBe("ECC")
  })

  test("name containing a colon gets no namespace", () => {
    expect(deriveNamespace(loc("skills", "ECC", "agent-eval", "SKILL.md"), "compose:plan")).toBeUndefined()
  })

  test("namespace with whitespace is rejected", () => {
    expect(deriveNamespace(loc("skills", "My Group", "agent-eval", "SKILL.md"), "agent-eval")).toBeUndefined()
  })

  test("no skills/ marker yields no namespace", () => {
    expect(
      deriveNamespace(path.join("/home/user/.mimo-skills", "ECC", "agent-eval", "SKILL.md"), "agent-eval"),
    ).toBeUndefined()
  })
})
