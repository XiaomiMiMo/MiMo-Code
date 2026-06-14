import { describe, expect, test } from "bun:test"
import { homedir } from "node:os"
import { join } from "node:path"

import { installCli, installCliCommand, type InstallCliRunner } from "./cli"

describe("desktop CLI install", () => {
  test("uses the official main-branch installer", () => {
    const command = installCliCommand()

    expect(command.command).toBe("bash")
    expect(command.args).toEqual([
      "-lc",
      "curl -fsSL https://raw.githubusercontent.com/SheriAkhtamov/Devora/main/install | bash",
    ])
  })

  test("returns the installed CLI path after the installer succeeds", async () => {
    const calls: Array<{ command: string; args: string[] }> = []
    const run: InstallCliRunner = async (command, args) => {
      calls.push({ command, args })
    }

    await expect(installCli(run)).resolves.toBe(join(homedir(), ".devora", "bin", "devora"))
    expect(calls).toEqual([installCliCommand()])
  })
})
