import { describe, expect, test } from "bun:test"

function read(value?: string) {
  const env = { ...process.env }
  if (value === undefined) delete env.MIMOCODE_ENABLE_SKILL_SEARCH_REMINDER
  else env.MIMOCODE_ENABLE_SKILL_SEARCH_REMINDER = value
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_ENABLE_SKILL_SEARCH_REMINDER))',
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return result.stdout.toString()
}

describe("MIMOCODE_ENABLE_SKILL_SEARCH_REMINDER", () => {
  test("is enabled by default", () => {
    expect(read()).toBe("true")
  })

  test("accepts false and zero to disable reminder injection", () => {
    expect(read("false")).toBe("false")
    expect(read("0")).toBe("false")
  })
})
