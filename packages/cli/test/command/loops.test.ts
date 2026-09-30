import { describe, expect, test } from "bun:test"
import path from "path"
import { Command } from "../../src/command"

describe("/loops command", () => {
  test("Default has the loops name", () => {
    expect(Command.Default.LOOPS).toBe("loops")
  })

  test("template instructs cron list, table rendering, cancel handling, and arguments slot", async () => {
    const template = await Bun.file(
      path.join(import.meta.dir, "..", "..", "src", "command", "template", "loops.txt"),
    ).text()
    expect(template.toLowerCase()).toContain("cron")
    expect(template.toLowerCase()).toContain("list")
    expect(template).toContain("$ARGUMENTS")
    expect(template.toLowerCase()).toContain("cancel")
    expect(template.toLowerCase()).toContain("prompt-preview")
  })
})
