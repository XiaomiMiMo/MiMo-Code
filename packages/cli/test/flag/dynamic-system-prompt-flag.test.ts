import { describe, expect, test } from "bun:test"

function read(value?: string) {
  const env = { ...process.env }
  if (value === undefined) delete env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT
  else env.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT = value
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT))',
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("MIMOCODE_ENABLE_DYNAMIC_SYSTEM_PROMPT", () => {
  test("is disabled by default and accepts explicit truthy values", () => {
    expect(read()).toBe("false")
    expect(read("true")).toBe("true")
    expect(read("1")).toBe("true")
  })

  test("false and zero keep dynamic system prompt injection disabled", () => {
    expect(read("false")).toBe("false")
    expect(read("0")).toBe("false")
  })
})
