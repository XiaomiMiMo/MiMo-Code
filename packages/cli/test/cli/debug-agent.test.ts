import { expect, test } from "bun:test"
import path from "node:path"
import { fileURLToPath, pathToFileURL } from "node:url"
import { tmpdir } from "../fixture/fixture"

test.each([
  { codex: false, params: { name: "Example" } },
  { codex: true, params: { name: "Example" } },
  { codex: false, params: {} },
])(
  "validates and executes a bundled plugin tool in debug mode (%j)",
  async (input) => {
    await using tmp = await tmpdir({ outsideGit: true })
    const file = path.join(tmp.path, "plugin.js")
    const build = Bun.spawn({
      cmd: [
        process.execPath,
        "build",
        path.resolve(import.meta.dirname, "../../../../examples/plugins/greeting/src/server.ts"),
        "--target=node",
        "--format=esm",
        "--outfile",
        file,
      ],
      stdout: "ignore",
      stderr: "inherit",
    })
    expect(await build.exited).toBe(0)
    const proc = Bun.spawn({
      cmd: [
        process.execPath,
        "--preload",
        fileURLToPath(import.meta.resolve("@opentui/solid/preload")),
        path.resolve(import.meta.dirname, "../../src/index.ts"),
        "debug",
        "agent",
        "build",
        "--tool",
        "greet",
        "--params",
        JSON.stringify(input.params),
      ],
      cwd: tmp.path,
      env: {
        ...process.env,
        MIMOCODE_HOME: path.join(tmp.path, "home"),
        MIMOCODE_CODEX_MODE: String(input.codex),
        MIMOCODE_DISABLE_MODELS_FETCH: "1",
        MIMOCODE_DISABLE_CLAUDE_CODE: "1",
        MIMOCODE_CONFIG_CONTENT: JSON.stringify({
          model: "test/model",
          provider: {
            test: {
              npm: "@ai-sdk/openai-compatible",
              options: { apiKey: "test", baseURL: "http://127.0.0.1:1/v1" },
              models: { model: { name: "Test", limit: { context: 32000, output: 1000 } } },
            },
          },
          plugin: [pathToFileURL(file).href],
          lsp: false,
          formatter: false,
        }),
      },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
    })
    try {
      const [code, stdout, stderr] = await Promise.all([
        proc.exited,
        new Response(proc.stdout).text(),
        new Response(proc.stderr).text(),
      ])
      if (!("name" in input.params)) {
        expect(code).not.toBe(0)
        expect(stderr).toContain("name")
        expect(stdout).not.toContain("Hello,")
        return
      }
      expect(code).toBe(0)
      expect(JSON.parse(stdout)).toMatchObject({
        tool: "greet",
        input: { name: "Example" },
        result: { output: "Hello, Example!" },
      })
    } finally {
      proc.kill()
    }
  },
  30000,
)
