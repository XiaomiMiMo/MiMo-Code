import { describe, expect, test } from "bun:test"
import yargs from "yargs/yargs"
import { RunCommand } from "../../src/cli/cmd/run"
import { TuiThreadCommand } from "../../src/cli/cmd/tui/thread"

describe("--yolo", () => {
  test.each([
    ["tui", TuiThreadCommand],
    ["run", RunCommand],
  ])("aliases --dangerously-skip-permissions for %s", async (_name, command) => {
    if (typeof command.builder !== "function") throw new Error("command builder is not a function")

    const args = await (await command.builder(yargs([]))).parseAsync(["--yolo"])

    expect(args.yolo).toBe(true)
    expect(args["dangerously-skip-permissions"]).toBe(true)
  })
})
