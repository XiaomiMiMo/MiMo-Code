import { describe, expect, test } from "bun:test"

function read(env: Record<string, string | undefined>) {
  const merged = { ...process.env }
  delete merged.MIMOCODE_ENABLE_TOOL_SCRIPT
  delete merged.MIMOCODE_EXPERIMENTAL
  for (const [k, v] of Object.entries(env)) {
    if (v === undefined) delete merged[k]
    else merged[k] = v
  }
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_ENABLE_TOOL_SCRIPT))',
    ],
    cwd: process.cwd(),
    env: merged,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("MIMOCODE_ENABLE_TOOL_SCRIPT", () => {
  test("is disabled by default and accepts explicit truthy values", () => {
    expect(read({})).toBe("false")
    expect(read({ MIMOCODE_ENABLE_TOOL_SCRIPT: "true" })).toBe("true")
    expect(read({ MIMOCODE_ENABLE_TOOL_SCRIPT: "1" })).toBe("true")
  })

  test("false and zero keep it disabled", () => {
    expect(read({ MIMOCODE_ENABLE_TOOL_SCRIPT: "false" })).toBe("false")
    expect(read({ MIMOCODE_ENABLE_TOOL_SCRIPT: "0" })).toBe("false")
  })

  test("umbrella MIMOCODE_EXPERIMENTAL enables it", () => {
    expect(read({ MIMOCODE_EXPERIMENTAL: "true" })).toBe("true")
  })
})
