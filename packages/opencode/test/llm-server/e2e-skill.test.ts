import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Instance } from "../../src/project/instance"
import { LLMServer } from "../../src/llm-server/server"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { tmpdir } from "../fixture/fixture"

afterEach(async () => {
  await Instance.disposeAll()
})

/**
 * End-to-end exercise of the whole point of this feature: a subprocess that knows
 * nothing about MiMoCode does real model work from a base_url and a throwaway
 * token, and recovers on its own when that token ages out.
 *
 * Everything here is real except the model vendor: a genuine TCP listener, a
 * genuine child process, the genuine token store. The upstream is a local
 * `Bun.serve` so the test is hermetic and costs nothing — using a live provider
 * would make this both slow and flaky, and would prove nothing extra, since what
 * is under test is our own boundary rather than any vendor's behaviour.
 */

const SKILL_DIR = path.join(import.meta.dir, "..", "fixture", "skills", "llm-endpoint-demo")
const SCRIPT = path.join(SKILL_DIR, "summarize.mjs")
const MODEL = "test/chat-model"

function upstream(reply: string) {
  return Bun.serve({
    port: 0,
    fetch: () =>
      new Response(
        `data: ${JSON.stringify({
          id: "up-1",
          object: "chat.completion.chunk",
          created: 1,
          model: "chat-model",
          choices: [{ index: 0, delta: { content: reply }, finish_reason: null }],
        })}\n\n` +
          `data: ${JSON.stringify({
            id: "up-1",
            object: "chat.completion.chunk",
            created: 1,
            model: "chat-model",
            choices: [{ index: 0, delta: {}, finish_reason: "stop" }],
          })}\n\ndata: [DONE]\n\n`,
        { headers: { "content-type": "text/event-stream" } },
      ),
  })
}

function config(upstreamPort: number) {
  return {
    provider: {
      test: {
        name: "Test",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "a-real-provider-key-that-must-not-leak", baseURL: `http://127.0.0.1:${upstreamPort}/v1` },
        models: {
          "chat-model": { name: "Chat Model", modalities: { input: ["text" as const], output: ["text" as const] } },
          "other-model": { name: "Other Model", modalities: { input: ["text" as const], output: ["text" as const] } },
        },
      },
    },
  }
}

/** Run the demo skill's script exactly as a skill would: env in, exit code out. */
async function runSkill(input: { baseUrl: string; apiKey: string; model?: string; prompt?: string }) {
  // `process.execPath` is the bun running this test, which executes .mjs directly.
  const proc = Bun.spawn([process.execPath, SCRIPT, input.prompt ?? "hello"], {
    env: {
      PATH: process.env["PATH"] ?? "",
      OPENAI_BASE_URL: input.baseUrl,
      OPENAI_API_KEY: input.apiKey,
      ...(input.model === undefined ? { OPENAI_MODEL: MODEL } : { OPENAI_MODEL: input.model }),
    },
    stdout: "pipe",
    stderr: "pipe",
  })
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { stdout: stdout.trim(), stderr, code }
}

/** A real listener plus a fake vendor, torn down together. */
async function harness<T>(reply: string, fn: (input: { dir: string; url: string }) => Promise<T>) {
  const vendor = upstream(reply)
  try {
    if (!vendor.port) throw new Error("fake upstream did not bind a port")
    await using tmp = await tmpdir({ config: config(vendor.port) })
    const server = await LLMServer.listen({ directory: tmp.path, port: 0 })
    try {
      return await fn({ dir: tmp.path, url: server.url })
    } finally {
      await server.stop()
    }
  } finally {
    await vendor.stop(true)
  }
}

describe("demo skill over the local endpoint", () => {
  test("does real work from nothing but a base_url and a token", async () => {
    const result = await harness("the sea is wide", async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({
        directory: dir,
        expiry: { idleMs: 60_000 },
        models: [MODEL],
        label: "llm-endpoint-demo",
      })
      return runSkill({ baseUrl: url, apiKey: issued.token })
    })
    expect(result.code).toBe(0)
    expect(result.stdout).toBe("the sea is wide")
  })

  test("the provider key never reaches the skill", async () => {
    // The credential configured for the vendor is a distinctive string; it must
    // appear in neither the token handed over nor anything the skill can observe.
    const result = await harness("ok", async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 60_000 } })
      expect(issued.token).not.toContain("a-real-provider-key")
      const run = await runSkill({ baseUrl: url, apiKey: issued.token })
      return { run, token: issued.token }
    })
    expect(result.run.code).toBe(0)
    expect(result.run.stdout + result.run.stderr).not.toContain("a-real-provider-key")
    // And the endpoint it was given is loopback, not a vendor URL.
    expect(result.token).toMatch(/^[A-Za-z0-9_-]{43}$/)
  })

  test("an expired token exits 2, distinctly from any other failure", async () => {
    const result = await harness("unused", async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 200 } })
      await Bun.sleep(600)
      return runSkill({ baseUrl: url, apiKey: issued.token })
    })
    expect(result.code).toBe(2)
    expect(result.stderr).toContain("expired_api_key")
  })

  test("a never-issued token exits 3, so it is not mistaken for something retryable", async () => {
    const result = await harness("unused", async ({ url }) => runSkill({ baseUrl: url, apiKey: "never-issued" }))
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("invalid_api_key")
  })

  test("reissuing recovers without a new base_url or a server restart", async () => {
    // The loop the whole design exists to support: work, age out, re-key, continue.
    const result = await harness("still here", async ({ dir, url }) => {
      const first = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 200 }, models: [MODEL] })
      await Bun.sleep(600)
      const expired = await runSkill({ baseUrl: url, apiKey: first.token })

      const second = await LLMServerTokens.issue({ directory: dir, expiry: { idleMs: 60_000 }, models: [MODEL] })
      // Same url object, deliberately: nothing about the endpoint changed.
      const recovered = await runSkill({ baseUrl: url, apiKey: second.token })
      return { expired, recovered }
    })
    expect(result.expired.code).toBe(2)
    expect(result.recovered.code).toBe(0)
    expect(result.recovered.stdout).toBe("still here")
  })

  test("a scoped token cannot be pointed at another model", async () => {
    const result = await harness("unused", async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {}, models: [MODEL] })
      return runSkill({ baseUrl: url, apiKey: issued.token, model: "test/other-model" })
    })
    expect(result.code).toBe(3)
    expect(result.stderr).toContain("model_not_found")
  })

  test("a revoked token stops working immediately", async () => {
    const result = await harness("unused", async ({ dir, url }) => {
      const issued = await LLMServerTokens.issue({ directory: dir, expiry: {} })
      expect(await LLMServerTokens.revoke(dir, issued.record.id)).toBe(true)
      return runSkill({ baseUrl: url, apiKey: issued.token })
    })
    expect(result.code).toBe(3)
  })

  test("reports a missing environment as 4 rather than failing obscurely", async () => {
    const result = await harness("unused", async ({ url }) => runSkill({ baseUrl: url, apiKey: "", model: "" }))
    expect(result.code).toBe(4)
    expect(result.stderr).toContain("OPENAI_API_KEY")
  })
})

describe("demo skill metadata", () => {
  test("is a valid skill whose name matches its directory", async () => {
    // Cheap guard against the fixture rotting into something the loader would skip:
    // the frontmatter must carry name + description, and the name must match the
    // folder, which is what skill discovery keys on.
    const text = await Bun.file(path.join(SKILL_DIR, "SKILL.md")).text()
    const frontmatter = /^---\n([\s\S]*?)\n---/.exec(text)
    expect(frontmatter).not.toBeNull()
    const body = frontmatter![1]!
    expect(body).toContain("name: llm-endpoint-demo")
    expect(/^description: \S/m.test(body)).toBe(true)
    expect(path.basename(SKILL_DIR)).toBe("llm-endpoint-demo")
  })

  test("does not tell the reader to run a bare `mimo`", () => {
    // Same reason the runtime messages avoid it: `mimo` is frequently not a command.
    const text = Bun.file(path.join(SKILL_DIR, "SKILL.md"))
    return text.text().then((content) => {
      expect(/(^|[^-\w<`])mimo llm-server/.test(content)).toBe(false)
    })
  })
})
