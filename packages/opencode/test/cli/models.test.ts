import { expect, test } from "bun:test"
import path from "node:path"
import { Hash } from "@mimo-ai/shared/util/hash"
import { Global } from "../../src/global"
import { tmpdir } from "../fixture/fixture"

const model = {
  id: "model",
  name: "Test model",
  release_date: "2026-01-01",
  attachment: false,
  reasoning: false,
  temperature: true,
  tool_call: true,
  limit: { context: 32000, output: 2000 },
}
const baseline = {
  test: {
    id: "test",
    name: "Test",
    env: [],
    npm: "@ai-sdk/openai-compatible",
    models: { model },
  },
}

for (const mode of ["success", "failure", "pinned"] as const) {
  test(`models --refresh reports ${mode} and preserves the correct catalog`, async () => {
    await using tmp = await tmpdir()
    let requests = 0
    const next = {
      test: {
        ...baseline.test,
        models: { ...baseline.test.models, next: { ...model, id: "next", name: "Next model" } },
      },
    }
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port: 0,
      fetch: () => {
        requests++
        return mode === "failure" ? new Response("unavailable", { status: 503 }) : Response.json(next)
      },
    })
    try {
      const cache = path.join(tmp.path, "cache", `models-${Hash.fast(server.url.origin)}.json`)
      const pinned = path.join(tmp.path, "pinned.json")
      await Bun.write(path.join(tmp.path, "cache", "version"), Bun.file(path.join(Global.Path.cache, "version")))
      await Bun.write(cache, JSON.stringify(baseline))
      await Bun.write(pinned, JSON.stringify(baseline))
      const child = Bun.spawn(
        [process.execPath, "run", "--conditions=browser", path.resolve("src/index.ts"), "models", "test", "--refresh"],
        {
          cwd: process.cwd(),
          env: {
            ...process.env,
            MIMOCODE_HOME: tmp.path,
            MIMOCODE_CONFIG: undefined,
            MIMOCODE_CONFIG_DIR: undefined,
            MIMOCODE_CONFIG_CONTENT: JSON.stringify({
              enabled_providers: ["test"],
              provider: { test: { options: { apiKey: "test-key" } } },
            }),
            MIMOCODE_DISABLE_PROJECT_CONFIG: "true",
            MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
            MIMOCODE_DISABLE_MODELS_FETCH: "true",
            MIMOCODE_MODELS_URL: server.url.origin,
            MIMOCODE_MODELS_PATH: mode === "pinned" ? pinned : undefined,
          },
          stdout: "pipe",
          stderr: "pipe",
        },
      )
      const [code, stdout, stderr] = await Promise.all([
        child.exited,
        new Response(child.stdout).text(),
        new Response(child.stderr).text(),
      ])
      const output = stdout + stderr
      expect(code, output).toBe(mode === "failure" ? 1 : 0)
      expect(requests).toBe(mode === "pinned" ? 0 : 1)
      if (mode === "success") {
        expect(output).toContain("Models cache refreshed")
        expect(stdout).toContain("test/next")
        expect(await Bun.file(cache).json()).toHaveProperty("test.models.next")
        return
      }
      expect(output).not.toContain("Models cache refreshed")
      expect(await Bun.file(cache).json()).toEqual(baseline)
      if (mode === "failure") expect(output).toContain("Failed to refresh models cache: models.dev HTTP 503")
      if (mode === "pinned") {
        expect(output).toContain("MIMOCODE_MODELS_PATH")
        expect(stdout).toContain("test/model")
        expect(stdout).not.toContain("test/next")
      }
    } finally {
      await server.stop(true)
    }
  }, 30000)
}
