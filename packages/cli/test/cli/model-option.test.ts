import { describe, expect, test } from "bun:test"
import yargs from "yargs"
import { modelOption } from "../../src/cli/model-option"

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
})

describe("commands accepting --model", () => {
  test.each([
    ["tui", async () => (await import("../../src/cli/cmd/tui/thread")).TuiThreadCommand],
    ["run", async () => (await import("../../src/cli/cmd/run")).RunCommand],
  ])("%s keeps the last of a repeated --model", async (_, load) => {
    const command = await load()
    const builder = command.builder as (argv: ReturnType<typeof yargs>) => ReturnType<typeof yargs>
    const args = builder(yargs([])).parseSync(["-m", "test/first", "-m", "test/model"])
    expect(args.model).toBe("test/model")
  })
})
