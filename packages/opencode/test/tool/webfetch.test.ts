import { afterEach, describe, expect, test } from "bun:test"
import path from "path"
import { Effect, Layer } from "effect"
import { FetchHttpClient } from "effect/unstable/http"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { Instance } from "../../src/project/instance"
import { WebFetchTool } from "../../src/tool/webfetch"
import { SessionID, MessageID } from "../../src/session/schema"

const projectRoot = path.join(import.meta.dir, "../..")

const firecrawlKey = process.env.FIRECRAWL_API_KEY
const firecrawlUrl = process.env.FIRECRAWL_API_URL

afterEach(() => {
  if (firecrawlKey === undefined) delete process.env.FIRECRAWL_API_KEY
  else process.env.FIRECRAWL_API_KEY = firecrawlKey
  if (firecrawlUrl === undefined) delete process.env.FIRECRAWL_API_URL
  else process.env.FIRECRAWL_API_URL = firecrawlUrl
})

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

function exec(args: { url: string; format: "text" | "markdown" | "html"; timeout?: number }) {
  return WebFetchTool.pipe(
    Effect.flatMap((info) => info.init()),
    Effect.flatMap((tool) => tool.execute(args, ctx)),
    Effect.provide(Layer.mergeAll(FetchHttpClient.layer, Truncate.defaultLayer, Agent.defaultLayer)),
    Effect.runPromise,
  )
}

describe("tool.webfetch", () => {
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

  test("falls back to firecrawl when the origin refuses the request", async () => {
    let scraped: string | undefined
    let authorization: string | null = null
    await withFetch(
      async (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") return new Response("forbidden", { status: 403 })
        authorization = req.headers.get("authorization")
        scraped = ((await req.json()) as { url?: string }).url
        return Response.json({
          success: true,
          data: { markdown: "# Fetched by Firecrawl", metadata: { statusCode: 200 } },
        })
      },
      async (url) => {
        process.env.FIRECRAWL_API_KEY = "fc-test"
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const target = new URL("/blocked", url).toString()
            const result = await exec({ url: target, format: "markdown" })
            expect(scraped).toBe(target)
            expect(authorization).toBe("Bearer fc-test")
            expect(result.output).toBe("# Fetched by Firecrawl")
            expect(result.title).toBe(`${target} (firecrawl)`)
          },
        })
      },
    )
  })

  test("uses an unauthenticated self-hosted firecrawl when only the url is set", async () => {
    let authorization: string | null = "unset"
    await withFetch(
      (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") return new Response("too many requests", { status: 429 })
        authorization = req.headers.get("authorization")
        return Response.json({ success: true, data: { markdown: "# Self hosted" } })
      },
      async (url) => {
        delete process.env.FIRECRAWL_API_KEY
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/blocked", url).toString(), format: "markdown" })
            expect(authorization).toBeNull()
            expect(result.output).toBe("# Self hosted")
          },
        })
      },
    )
  })

  test("rejects a firecrawl document whose page did not load", async () => {
    await withFetch(
      (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") return new Response("forbidden", { status: 403 })
        return Response.json({
          success: true,
          data: { markdown: "# Access denied", metadata: { statusCode: 403 } },
        })
      },
      async (url) => {
        process.env.FIRECRAWL_API_KEY = "fc-test"
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            await expect(exec({ url: new URL("/blocked", url).toString(), format: "markdown" })).rejects.toThrow(
              "the page returned 403",
            )
          },
        })
      },
    )
  })

  test("extracts text from a firecrawl document when text is requested", async () => {
    let requested: string[] | undefined
    await withFetch(
      async (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") return new Response("forbidden", { status: 403 })
        requested = ((await req.json()) as { formats?: string[] }).formats
        return Response.json({
          success: true,
          data: { html: "<html><body><h1>Heading</h1><p>Body copy</p></body></html>" },
        })
      },
      async (url) => {
        process.env.FIRECRAWL_API_KEY = "fc-test"
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/blocked", url).toString(), format: "text" })
            expect(requested).toEqual(["html"])
            expect(result.output).toBe("HeadingBody copy")
          },
        })
      },
    )
  })

  test("spends one timeout budget across the direct request and the fallback", async () => {
    let requested: number | undefined
    await withFetch(
      async (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") {
          await Bun.sleep(400)
          return new Response("forbidden", { status: 403 })
        }
        requested = ((await req.json()) as { timeout?: number }).timeout
        return Response.json({ success: true, data: { markdown: "# Within budget" } })
      },
      async (url) => {
        process.env.FIRECRAWL_API_KEY = "fc-test"
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/blocked", url).toString(), format: "markdown", timeout: 5 })
            expect(result.output).toBe("# Within budget")
            expect(requested).toBeGreaterThan(1000)
            expect(requested).toBeLessThan(5000)
          },
        })
      },
    )
  })

  test("retries a transient firecrawl failure", async () => {
    let attempts = 0
    await withFetch(
      (req) => {
        if (new URL(req.url).pathname !== "/v2/scrape") return new Response("forbidden", { status: 403 })
        attempts++
        if (attempts === 1) return new Response("unavailable", { status: 503 })
        return Response.json({ success: true, data: { markdown: "# Second attempt" } })
      },
      async (url) => {
        process.env.FIRECRAWL_API_KEY = "fc-test"
        process.env.FIRECRAWL_API_URL = url.origin
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            const result = await exec({ url: new URL("/blocked", url).toString(), format: "markdown" })
            expect(attempts).toBe(2)
            expect(result.output).toBe("# Second attempt")
          },
        })
      },
    )
  })

  test("keeps failing on a refused request when firecrawl is not configured", async () => {
    await withFetch(
      () => new Response("forbidden", { status: 403 }),
      async (url) => {
        delete process.env.FIRECRAWL_API_KEY
        delete process.env.FIRECRAWL_API_URL
        await Instance.provide({
          directory: projectRoot,
          fn: async () => {
            await expect(exec({ url: new URL("/blocked", url).toString(), format: "markdown" })).rejects.toThrow()
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
