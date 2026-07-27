import { describe, expect, test } from "bun:test"

const names = [
  "MIMOCODE_ENABLE_TITLE_GENERATION",
  "MIMOCODE_ENABLE_CHECKPOINT",
  "MIMOCODE_ENABLE_DREAM",
  "MIMOCODE_ENABLE_DISTILL",
  "MIMOCODE_ENABLE_PREDICT_NEXT_PROMPT",
] as const

function read(value?: string) {
  const env = { ...process.env }
  for (const name of names) {
    if (value === undefined) delete env[name]
    else env[name] = value
  }
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { Flag } from "./src/flag/flag.ts"; process.stdout.write(JSON.stringify(${JSON.stringify(names)}.map((name) => Flag[name])))`,
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as boolean[]
}

describe("RL auxiliary generation flags", () => {
  test("are disabled by default", () => {
    expect(read()).toEqual(names.map(() => false))
  }, 15_000)

  test("can be enabled explicitly", () => {
    expect(read("true")).toEqual(names.map(() => true))
  }, 15_000)

  test("automatic compaction is enabled by default and supports explicit opt-out", () => {
    const run = (enable?: string, disable?: string) => {
      const env = { ...process.env }
      if (enable === undefined) delete env.MIMOCODE_ENABLE_COMPACTION
      else env.MIMOCODE_ENABLE_COMPACTION = enable
      if (disable === undefined) delete env.MIMOCODE_DISABLE_AUTOCOMPACT
      else env.MIMOCODE_DISABLE_AUTOCOMPACT = disable
      return Bun.spawnSync({
        cmd: [
          process.execPath,
          "-e",
          'import { Flag } from "./src/flag/flag.ts"; process.stdout.write(String(Flag.MIMOCODE_DISABLE_AUTOCOMPACT))',
        ],
        cwd: process.cwd(),
        env,
      }).stdout.toString()
    }
    expect(run()).toBe("false")
    expect(run("true")).toBe("false")
    expect(run("false")).toBe("true")
    expect(run("true", "true")).toBe("true")
  }, 15_000)
})
