import { describe, expect, test } from "bun:test"

function read(value?: string, experimental?: string) {
  const env = { ...process.env }
  delete env.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL
  delete env.MIMOCODE_EXPERIMENTAL
  if (value !== undefined) env.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL = value
  if (experimental !== undefined) env.MIMOCODE_EXPERIMENTAL = experimental
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL))',
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("MIMOCODE_EXPERIMENTAL_WORKFLOW_TOOL", () => {
  test("is enabled by default and accepts explicit truthy values", () => {
    expect(read()).toBe("true")
    expect(read("true")).toBe("true")
    expect(read("1")).toBe("true")
  })

  test("remains enabled with the umbrella experimental flag", () => {
    expect(read(undefined, "true")).toBe("true")
  })

  test("false and zero explicitly disable the tool", () => {
    expect(read("false")).toBe("false")
    expect(read("0")).toBe("false")
    expect(read("false", "true")).toBe("false")
  })
})
