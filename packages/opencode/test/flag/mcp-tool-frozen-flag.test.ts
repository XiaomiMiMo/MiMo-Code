import { describe, expect, test } from "bun:test"

function read(value?: string) {
  const env = { ...process.env }
  if (value === undefined) delete env.MIMOCODE_MCP_TOOL_FROZEN
  else env.MIMOCODE_MCP_TOOL_FROZEN = value
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_MCP_TOOL_FROZEN))',
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("MIMOCODE_MCP_TOOL_FROZEN", () => {
  test("is enabled by default and accepts explicit truthy values", () => {
    expect(read()).toBe("true")
    expect(read("true")).toBe("true")
    expect(read("1")).toBe("true")
  })

  test("false and zero disable MCP tool freeze", () => {
    expect(read("false")).toBe("false")
    expect(read("0")).toBe("false")
  })
})
