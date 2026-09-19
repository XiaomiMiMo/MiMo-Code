import { describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { WebFetchTool, assertReadableHTML } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

const projectRoot = path.join(import.meta.dir, "../..")

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make("message"),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

async function withFetch(fetch: (req: Request) => Response | Promise<Response>, fn: (url: URL) => Promise<void>) {
  using server = Bun.serve({ port: 0, fetch })
  await fn(server.url)
}

function exec(args: { url: string; format: "text" | "markdown" | "html" }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.webfetch", () => {
  test("distinguishes browser shells from small useful documents", () => {
    for (const html of [
      '<html><body><script src="app.js"></script></body></html>',
      '<html><title>Google Search</title><body>Please enable JavaScript. <a href="/retry">Click here</a></body></html>',
      '<html><title>Just a moment...</title><body>Checking your browser</body></html>',
      '<html><title>Sign in</title><body><form><input type="password"></form></body></html>',
    ]) expect(() => assertReadableHTML(html)).toThrow("Page content unavailable")
    expect(() => assertReadableHTML('<html><body><h1>Status</h1><p>All services operational.</p></body></html>')).not.toThrow()
    expect(() => assertReadableHTML('<html><body><h1>How to enable JavaScript</h1><p>Open Settings, then enable JavaScript.</p></body></html>')).not.toThrow()
    expect(() => assertReadableHTML('<html><title>Sign in</title><body><p>Use the account menu to sign in.</p></body></html>')).not.toThrow()
    expect(() => assertReadableHTML('<html><title>Guide</title><body><h1>How to enable JavaScript</h1><p>' + 'Useful instructions. '.repeat(100) + '</p></body></html>')).not.toThrow()
  })
  test("HTTP 200 shells fail and rendered HTML remains readable", async () => {
    await withFetch((req) => new Response(new URL(req.url).pathname === "/shell"
      ? '<html><body><script src="app.js"></script></body></html>'
      : '<html><body><h1>Result</h1><p>Useful page content.</p></body></html>',
    { headers: { "content-type": "text/html" } }), async (url) => {
      await Instance.provide({ directory: projectRoot, fn: async () => {
        for (const format of ["text", "markdown", "html"] as const) {
          await expect(exec({ url: new URL("/shell", url).toString(), format })).rejects.toThrow("Page content unavailable")
          expect((await exec({ url: url.toString(), format })).output).toContain("Useful page content.")
        }
      } })
    })
  })
  test("returns image responses as file attachments", async () => {
    const bytes = new Uint8Array([137, 80, 78, 71, 13, 10, 26, 10])
    await withFetch(
      () => new Response(bytes, { status: 200, headers: { "content-type": "IMAGE/PNG; charset=binary" } }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.png", url).toString(), format: "markdown" })
            expect(result.output).toBe("Image fetched successfully")
            expect(result.attachments).toBeDefined()
            expect(result.attachments?.length).toBe(1)
            expect(result.attachments?.[0].type).toBe("file")
            expect(result.attachments?.[0].mime).toBe("image/png")
            expect(result.attachments?.[0].url.startsWith("data:image/png;base64,")).toBe(true)
            expect(result.attachments?.[0]).not.toHaveProperty("id")
            expect(result.attachments?.[0]).not.toHaveProperty("sessionID")
            expect(result.attachments?.[0]).not.toHaveProperty("messageID")
          },
        })
      },
    )
  })

  test("keeps svg as text output", async () => {
    const svg = '<svg xmlns="http://www.w3.org/2000/svg"><text>hello</text></svg>'
    await withFetch(
      () =>
        new Response(svg, {
          status: 200,
          headers: { "content-type": "image/svg+xml; charset=UTF-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/image.svg", url).toString(), format: "html" })
            expect(result.output).toContain("<svg")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })

  test("keeps text responses as text output", async () => {
    await withFetch(
      () =>
        new Response("hello from webfetch", {
          status: 200,
          headers: { "content-type": "text/plain; charset=utf-8" },
        }),
      async (url) => {
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/file.txt", url).toString(), format: "text" })
            expect(result.output).toBe("hello from webfetch")
            expect(result.attachments).toBeUndefined()
          },
        })
      },
    )
  })
})
