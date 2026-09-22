import { describe, expect, test } from "bun:test"

function read(value?: string) {
  const env = { ...process.env }
  delete env.MIMOCODE_CODEX_MODE
  if (value == null) delete env.MIMOCODE_PASCAL_CASE_TOOLS
  else env.MIMOCODE_PASCAL_CASE_TOOLS = value
  const result = Bun.spawnSync({
    cmd: [
      process.execPath,
      "-e",
      `import { Flag } from "./src/flag/flag.ts"
       import { usesPascalCaseTools } from "./src/tool/names.ts"
       process.stdout.write(JSON.stringify({
         flag: String(Flag.MIMOCODE_PASCAL_CASE_TOOLS),
         other: usesPascalCaseTools("test-model", "default"),
         variants: ["mimo-v2.6", "mimo-v2.6-flash", "mimo-v2.6-pro", "mimo-v2.6-pro-ultraspeed"].map(id => usesPascalCaseTools(id, "default")),
         alias: usesPascalCaseTools("test-model", "default", "provider/mimo-v2.6-pro"),
         codex: usesPascalCaseTools("mimo-v2.6-pro", "codex"),
         gpt: usesPascalCaseTools("gpt-5.4"),
       }))`,
    ],
    cwd: process.cwd(),
    env,
  })
  expect(result.exitCode).toBe(0)
  return JSON.parse(result.stdout.toString()) as {
    flag: string
    other: boolean
    variants: boolean[]
    alias: boolean
    codex: boolean
    gpt: boolean
  }
}

describe("MIMOCODE_PASCAL_CASE_TOOLS", () => {
  test("unset follows MiMo v2.6 model IDs and aliases while preserving other models", () => {
    expect(read()).toEqual({
      flag: "undefined",
      other: false,
      variants: [true, true, true, true],
      alias: true,
      codex: false,
      gpt: false,
    })
  })

  for (const value of ["true", "1"]) {
    test(`${value} enables the default harness while preserving GPT and Codex`, () => {
      expect(read(value)).toEqual({
        flag: "true",
        other: true,
        variants: [true, true, true, true],
        alias: true,
        codex: false,
        gpt: false,
      })
    })
  }

  for (const value of ["false", "0"]) {
    test(`${value} disables automatic PascalCase for MiMo v2.6`, () => {
      expect(read(value)).toEqual({
        flag: "false",
        other: false,
        variants: [false, false, false, false],
        alias: false,
        codex: false,
        gpt: false,
      })
    })
  }
})
