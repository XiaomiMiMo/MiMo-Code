import { describe, expect, test } from "bun:test"
import path from "path"

const BUNDLE = path.join(import.meta.dir, "../../src/skill/builtin/.bundle")

describe("builtin skill frontmatter", () => {
  test("every bundled SKILL.md has strictly valid YAML frontmatter", async () => {
    const failures: string[] = []
    let checked = 0

    for await (const relative of new Bun.Glob("**/SKILL.md").scan({ cwd: BUNDLE })) {
      checked++
      const file = path.join(BUNDLE, relative)
      const content = await Bun.file(file).text()
      const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---/)?.[1]

      if (frontmatter === undefined) {
        failures.push(`${relative}: no frontmatter block`)
        continue
      }

      let data: unknown
      try {
        data = Bun.YAML.parse(frontmatter)
      } catch (err) {
        failures.push(`${relative}: ${err instanceof Error ? err.message : String(err)}`)
        continue
      }

      if (typeof data !== "object" || data === null) {
        failures.push(`${relative}: frontmatter is not a mapping`)
        continue
      }

      const { name, description } = data as { name?: unknown; description?: unknown }
      if (typeof name !== "string" || name.length === 0) {
        failures.push(`${relative}: frontmatter has no string name`)
      }
      if (typeof description !== "string" || description.length === 0) {
        failures.push(`${relative}: frontmatter has no string description`)
      }
    }

    expect(checked).toBeGreaterThan(0)
    expect(failures).toEqual([])
  })
})
