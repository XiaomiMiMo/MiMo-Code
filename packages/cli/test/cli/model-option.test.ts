import { describe, expect, test } from "bun:test"
import yargs from "yargs/yargs"
import { modelOption } from "../../src/cli/model-option"
import { RunCommand } from "../../src/cli/cmd/run"
import { TuiThreadCommand } from "../../src/cli/cmd/tui/thread"

function parse(argv: string[]) {
  return yargs([]).option("model", modelOption).parseSync(argv).model
}

describe("--model option", () => {
  test("a repeated --model keeps the last value", () => {
    expect(parse(["-m", "test/first", "--model", "test/model"])).toBe("test/model")
  })

  test("a single --model is unchanged", () => {
    expect(parse(["-m", "test/model"])).toBe("test/model")
  })

  test("an absent --model stays undefined", () => {
    expect(parse([])).toBeUndefined()
  })

  test.each([
    ["tui", TuiThreadCommand],
    ["run", RunCommand],
  ])("%s keeps the last of a repeated --model", async (_name, command) => {
    if (typeof command.builder !== "function") throw new Error("command builder is not a function")

    const args = await (await command.builder(yargs([]))).parseAsync(["-m", "test/first", "-m", "test/model"])

    expect(args.model).toBe("test/model")
  })
})
