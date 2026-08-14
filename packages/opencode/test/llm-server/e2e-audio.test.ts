import { afterEach, beforeAll, describe, expect, test } from "bun:test"
import path from "path"
import { mkdtempSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs"
import os from "node:os"
import { Instance } from "../../src/project/instance"
import { LLMServerTokens } from "../../src/llm-server/tokens"

/**
 * End to end, with nothing faked but the model vendor.
 *
 * A real `mimo serve` process, a real HTTP socket, and the demo skill's real scripts as
 * subprocesses that know only a `base_url` and a token. That combination is what the earlier
 * in-process tests cannot check: the routes' mount point, the auth carve-out, and the
 * middleware chain they sit behind are exactly what changed when this moved off a standalone
 * listener, so testing them through a hand-assembled app would test the assembly instead.
 *
 * The server runs with cwd set to the project directory rather than being handed one. That is
 * not a workaround — `InstanceMiddleware` refuses a directory outside `process.cwd()` when no
 * server password is set, so a subprocess is how a caller legitimately scopes an unsecured
 * loopback server to one project.
 *
 * Covers both audio directions as a ROUND TRIP: text in, audio out, those exact bytes back
 * in, text out. A skill that completes it has never held a provider credential.
 */

const SKILL = path.join(import.meta.dir, "..", "fixture", "skills", "llm-endpoint-demo")
const ENTRY = path.join(import.meta.dir, "..", "..", "src", "index.ts")
/**
 * The JSX preload this package's `bunfig.toml` normally supplies.
 *
 * bunfig is read from the CWD, and this server deliberately runs with the CWD set to the
 * project directory — so the preload has to be passed explicitly or the TUI entry resolves
 * React's JSX runtime instead of Solid's and the process dies before printing a port.
 */
const PRELOAD = path.join(import.meta.dir, "..", "..", "node_modules", "@opentui", "solid", "scripts", "preload.ts")

afterEach(async () => {
  await Instance.disposeAll()
})

/** A wav header plus a marker, so a fake vendor's echo is recognisable in the assertions. */
function wav(marker: string) {
  return Buffer.concat([Buffer.from("RIFF"), Buffer.from("....WAVEfmt "), Buffer.from(marker)])
}

/**
 * A vendor that speaks the audio-over-chat convention in both directions.
 *
 * Returns audio when asked to synthesize (the request carries an `audio` object) and text
 * when asked to transcribe (the request carries an `input_audio` part), which is exactly how
 * the real convention distinguishes them.
 */
function vendor(transcript: string) {
  const seen: Record<string, unknown>[] = []
  const server = Bun.serve({
    port: 0,
    fetch: async (req) => {
      const body = (await req.json()) as Record<string, unknown>
      seen.push(body)
      const wantsAudio = body["audio"] !== undefined && body["audio"] !== null
      const message = wantsAudio
        ? { role: "assistant", content: "", audio: { data: wav("SYNTH").toString("base64"), id: "a1" } }
        : { role: "assistant", content: transcript }
      return new Response(JSON.stringify({ choices: [{ index: 0, message, finish_reason: "stop" }] }), {
        headers: { "content-type": "application/json" },
      })
    },
  })
  // Narrowed once here rather than asserted at each use: `Bun.serve` types `port` as optional
  // even though `port: 0` always assigns one, and a throw states that expectation where it can
  // actually be checked.
  if (server.port === undefined) throw new Error("fake vendor did not get a port")
  return { server, seen, port: server.port }
}

function projectConfig(vendorPort: number) {
  return {
    provider: {
      demo: {
        name: "Demo audio",
        npm: "@ai-sdk/openai-compatible",
        options: { apiKey: "vendor-key-never-leaves-the-server", baseURL: `http://127.0.0.1:${vendorPort}/v1` },
        models: {
          tts: { name: "TTS", modalities: { input: ["text"], output: ["audio"] } },
          asr: { name: "ASR", modalities: { input: ["audio"], output: ["text"] } },
        },
      },
    },
  }
}

/** Start a real server in `directory` and return its base URL. */
async function serve(directory: string) {
  // `--conditions=browser` mirrors the package's own `dev` script; without it the entry
  // resolves a different set of exports and exits before printing anything.
  const proc = Bun.spawn(
    [
      process.execPath,
      "--conditions=browser",
      `--preload=${PRELOAD}`,
      ENTRY,
      "serve",
      "--port",
      "0",
      "--hostname",
      "127.0.0.1",
    ],
    {
      cwd: directory,
      stdout: "pipe",
      stderr: "pipe",
      env: { ...process.env, MIMOCODE_DISABLE_PROVIDER_ENV: "1" },
    },
  )

  // Read stdout until the line that names the port. A fixed sleep would either be flaky or
  // slow, and the process tells us exactly when it is ready.
  const reader = proc.stdout.getReader()
  const decoder = new TextDecoder()
  let buffered = ""
  const deadline = Date.now() + 60_000
  while (Date.now() < deadline) {
    const { value, done } = await reader.read()
    if (done) break
    buffered += decoder.decode(value, { stream: true })
    const found = /listening on (http:\/\/\S+)/.exec(buffered)
    if (found) {
      reader.releaseLock()
      return { proc, url: found[1]!, output: () => buffered }
    }
  }
  reader.releaseLock()
  proc.kill()
  const errors = await new Response(proc.stderr as ReadableStream).text()
  throw new Error(`server did not report a port within 60s.\nstdout:\n${buffered}\nstderr:\n${errors}`)
}

type Ctx = { url: string; token: string; dir: string; seen: Record<string, unknown>[] }

async function withEndpoint<T>(transcript: string, fn: (ctx: Ctx) => Promise<T>): Promise<T> {
  const up = vendor(transcript)
  // A plain temp dir, not the shared `tmpdir` fixture: the server subprocess needs this to be
  // its cwd, and it has to outlive the fixture's own disposal ordering.
  // `realpathSync` is load-bearing on macOS, not hygiene: `os.tmpdir()` hands back
  // `/var/folders/...` while a subprocess's own `process.cwd()` resolves to the real
  // `/private/var/folders/...`. Two spellings of one directory means two token stores, and the
  // symptom is a freshly issued token being rejected as invalid.
  const dir = realpathSync(mkdtempSync(path.join(os.tmpdir(), "llm-api-e2e-")))
  try {
    writeFileSync(path.join(dir, "mimocode.json"), JSON.stringify(projectConfig(up.port)))
    const issued = await Instance.provide({
      directory: dir,
      fn: () => LLMServerTokens.issue({ directory: dir, expiry: {} }),
    })
    const server = await serve(dir)
    try {
      return await fn({ url: server.url, token: issued.token, dir, seen: up.seen })
    } finally {
      server.proc.kill()
      await server.proc.exited
    }
  } finally {
    await up.server.stop(true)
    rmSync(dir, { recursive: true, force: true })
  }
}

function runScript(script: string, ctx: Ctx, args: string[], env: Record<string, string>) {
  const proc = Bun.spawn([process.execPath, path.join(SKILL, script), ...args], {
    cwd: ctx.dir,
    stdout: "pipe",
    stderr: "pipe",
    // Deliberately minimal: a base_url, a token, a model. No provider key, and nothing else
    // inherited that could stand in for one.
    env: {
      PATH: process.env["PATH"] ?? "",
      OPENAI_BASE_URL: `${ctx.url}/v1`,
      OPENAI_API_KEY: ctx.token,
      ...env,
    },
  })
  return proc
}

async function finish(proc: Bun.Subprocess) {
  const [code, stdout, stderr] = await Promise.all([
    proc.exited,
    new Response(proc.stdout as ReadableStream).text(),
    new Response(proc.stderr as ReadableStream).text(),
  ])
  return { code, stdout, stderr }
}

beforeAll(() => {
  // The scripts are executed by bun, so nothing needs installing — but they must exist, and a
  // missing one should fail here rather than as a confusing non-zero exit later.
  for (const script of ["speak.mjs", "transcribe.mjs"]) {
    expect(readFileSync(path.join(SKILL, script), "utf8").length).toBeGreaterThan(0)
  }
})

describe("the demo skill over a real server", () => {
  test(
    "completes a speech round trip from nothing but a base_url and a token",
    async () => {
      await withEndpoint("the quick brown fox", async (ctx) => {
        const audioPath = path.join(ctx.dir, "spoken.wav")

        const spoke = await finish(
          runScript("speak.mjs", ctx, ["hello from the demo skill"], {
            OPENAI_TTS_MODEL: "demo/tts",
            OPENAI_TTS_OUT: audioPath,
          }),
        )
        expect(spoke.stderr).toBe("")
        expect(spoke.code).toBe(0)
        // Real bytes on disk, written by a subprocess that never saw a provider key.
        expect(readFileSync(audioPath).subarray(0, 4).toString()).toBe("RIFF")

        const heard = await finish(runScript("transcribe.mjs", ctx, [audioPath], { OPENAI_ASR_MODEL: "demo/asr" }))
        expect(heard.stderr).toBe("")
        expect(heard.code).toBe(0)
        expect(heard.stdout).toBe("the quick brown fox")

        // Both directions reached the vendor over the convention, and the synthesis half is
        // the one that carries an `audio` object.
        expect(ctx.seen.length).toBe(2)
        expect(ctx.seen[0]["audio"]).toBeDefined()
        expect(ctx.seen[1]["audio"]).toBeUndefined()
      })
    },
    120_000,
  )

  test(
    "the provider key never reaches the skill",
    async () => {
      await withEndpoint("x", async (ctx) => {
        const audioPath = path.join(ctx.dir, "spoken.wav")
        const spoke = await finish(
          runScript("speak.mjs", ctx, ["hi"], { OPENAI_TTS_MODEL: "demo/tts", OPENAI_TTS_OUT: audioPath }),
        )
        expect(spoke.code).toBe(0)
        // The credential the server used upstream must appear nowhere the skill can see: not
        // in what it was given, not in what it printed.
        const exposed = [spoke.stdout, spoke.stderr, ctx.token].join("\n")
        expect(exposed).not.toContain("vendor-key-never-leaves-the-server")
      })
    },
    120_000,
  )

  test(
    "a revoked token stops working immediately, with a code the skill can act on",
    async () => {
      await withEndpoint("x", async (ctx) => {
        await Instance.provide({ directory: ctx.dir, fn: () => LLMServerTokens.revokeAll(ctx.dir) })
        const heard = await finish(
          runScript("transcribe.mjs", ctx, [path.join(SKILL, "transcribe.mjs")], { OPENAI_ASR_MODEL: "demo/asr" }),
        )
        // 3, not 2: revoked is not "reissue and retry", and conflating them would make a
        // skill spin against a token that will never work again.
        expect(heard.code).toBe(3)
      })
    },
    120_000,
  )

  test(
    "a token scoped to one model cannot be pointed at another",
    async () => {
      await withEndpoint("x", async (ctx) => {
        const scoped = await Instance.provide({
          directory: ctx.dir,
          fn: () => LLMServerTokens.issue({ directory: ctx.dir, expiry: {}, models: ["demo/tts"] }),
        })
        const heard = await finish(
          runScript(
            "transcribe.mjs",
            { ...ctx, token: scoped.token },
            [path.join(SKILL, "transcribe.mjs")],
            { OPENAI_ASR_MODEL: "demo/asr" },
          ),
        )
        // 4: the endpoint refused the request. A scoped-out model is not an auth failure —
        // the token is perfectly valid, it just does not reach that model.
        expect(heard.code).toBe(4)
      })
    },
    120_000,
  )
})
