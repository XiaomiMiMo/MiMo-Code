import { Flag } from "@/flag/flag"
import { Hono } from "hono"
import { getMimeType } from "hono/utils/mime"
import fs from "node:fs/promises"

const embeddedUIPromise = Flag.MIMOCODE_DISABLE_EMBEDDED_WEB_UI
  ? Promise.resolve(null)
  : // @ts-expect-error - generated file at build time
    import("opencode-web-ui.gen.ts").then((module) => module.default as Record<string, string>).catch(() => null)

const DEFAULT_CSP =
  "default-src 'self'; script-src 'self' 'wasm-unsafe-eval'; style-src 'self' 'unsafe-inline'; img-src 'self' data: https:; font-src 'self' data:; media-src 'self' data:; connect-src 'self' data:"

const MISSING_EMBEDDED_WEB_UI = `<!doctype html>
<html lang="en">
  <head>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
    <title>MiMo Code Web UI unavailable</title>
    <style>
      body {
        margin: 0;
        min-height: 100vh;
        display: grid;
        place-items: center;
        background: #fcfaf8;
        color: #26251e;
        font-family: ui-sans-serif, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", sans-serif;
      }
      main {
        max-width: 520px;
        padding: 32px;
      }
      h1 {
        margin: 0 0 12px;
        font-size: 24px;
      }
      p {
        margin: 0;
        color: #504f49;
        line-height: 1.6;
      }
    </style>
  </head>
  <body>
    <main>
      <h1>MiMo Code Web UI unavailable</h1>
      <p>The embedded MiMo Code Web UI is missing from this build. Reinstall MiMo Code or rebuild the CLI without skipping the embedded web UI.</p>
    </main>
  </body>
</html>`

export const UIRoutes = (): Hono =>
  new Hono().all("/*", async (c) => {
    const embeddedWebUI = await embeddedUIPromise
    const path = c.req.path

    if (embeddedWebUI) {
      const match = embeddedWebUI[path.replace(/^\//, "")] ?? embeddedWebUI["index.html"] ?? null
      if (!match) return c.json({ error: "Not Found" }, 404)

      if (await fs.exists(match)) {
        const mime = getMimeType(match) ?? "text/plain"
        c.header("Content-Type", mime)
        if (mime.startsWith("text/html")) {
          c.header("Content-Security-Policy", DEFAULT_CSP)
        }
        return c.body(new Uint8Array(await fs.readFile(match)))
      } else {
        return c.json({ error: "Not Found" }, 404)
      }
    }

    c.header("Content-Security-Policy", DEFAULT_CSP)
    return c.html(MISSING_EMBEDDED_WEB_UI, 503)
  })
