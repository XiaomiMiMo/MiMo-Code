import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

const root = path.join(import.meta.dir, "../..")

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-free-login-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

function jwt(exp: number) {
  const encode = (value: unknown) => Buffer.from(JSON.stringify(value)).toString("base64url")
  return `${encode({ alg: "none" })}.${encode({ exp })}.sig`
}

function runLogin(input: { home: string; baseUrl: string }) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const child = spawn(
      process.execPath,
      ["--conditions=browser", "src/index.ts", "providers", "login", "--provider", "mimo-free"],
      {
        cwd: root,
        env: {
          ...process.env,
          MIMOCODE_HOME: input.home,
          MIMO_FREE_BASE_URL: input.baseUrl,
          MIMOCODE_DISABLE_CLAUDE_IMPORT: "1",
          MIMOCODE_DISABLE_MODELS_FETCH: "1",
          MIMOCODE_DISABLE_PROVIDER_ENV: "1",
          NO_COLOR: "1",
        },
        stdio: ["ignore", "pipe", "pipe"],
      },
    )
    let stdout = ""
    let stderr = ""
    const timeout = setTimeout(() => child.kill(), 15_000)
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      clearTimeout(timeout)
      resolve({ code, stdout, stderr })
    })
  })
}

describe("mimo-free provider login", () => {
  test("persists the anonymous channel and selects mimo-auto for subsequent sessions", async () => {
    await using tmp = await tmpdir()
    const exp = Math.floor(Date.now() / 1000) + 3600
    using server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname === "/api/free-ai/bootstrap") {
          return Response.json({ jwt: jwt(exp) })
        }
        return Response.json({ error: "unexpected" }, { status: 404 })
      },
    })

    const result = await runLogin({
      home: tmp.path,
      baseUrl: server.url.origin,
    })

    expect(result.code, result.stderr).toBe(0)

    const auth = await Bun.file(path.join(tmp.path, "data", "auth.json")).json()
    expect(auth.mimo).toEqual({
      type: "api",
      key: "anonymous",
      metadata: {
        mode: "free",
        endpoint: `${server.url.origin}/api/free-ai/openai/chat`,
        fingerprint: expect.any(String),
        token_exp: new Date(exp * 1000).toISOString(),
      },
    })

    const model = await Bun.file(path.join(tmp.path, "state", "model.json")).json()
    expect(model.recent[0]).toEqual({ providerID: "mimo", modelID: "mimo-auto" })
  }, 20_000)
})
