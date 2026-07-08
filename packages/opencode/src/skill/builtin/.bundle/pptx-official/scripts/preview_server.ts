#!/usr/bin/env bun
/**
 * PPTX Preview — long-running server process.
 * Watches the directory containing a .pptx file for changes, converts to
 * PDF via LibreOffice, serves in the browser's native viewer with WebSocket
 * refresh.
 *
 * Not meant to be run directly — use preview.ts to start/stop.
 *
 * Usage:
 *   bun run scripts/preview_server.ts output.pptx --port 4200
 */
import { watch } from "node:fs"
import { resolve, basename, dirname } from "node:path"
import { mkdirSync, existsSync } from "node:fs"
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: { port: { type: "string", default: "4200" } },
  allowPositionals: true,
})

const source = positionals[0]
if (!source) {
  console.error("Usage: bun run preview_server.ts <file.pptx> [--port N]")
  process.exit(2)
}

const pptxPath = resolve(source)
if (!existsSync(pptxPath)) {
  console.error(`File not found: ${pptxPath}`)
  process.exit(1)
}

const port = parseInt(values.port!, 10)
const previewDir = resolve(dirname(pptxPath), ".pptx-preview")
mkdirSync(previewDir, { recursive: true })
const pdfPath = resolve(previewDir, basename(pptxPath, ".pptx") + ".pdf")

function findSoffice(): string {
  const candidates = [
    "/Applications/LibreOffice.app/Contents/MacOS/soffice",
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/usr/local/bin/soffice",
  ]
  for (const c of candidates) {
    if (existsSync(c)) return c
  }
  const which = Bun.spawnSync(["which", "soffice"])
  if (which.exitCode === 0) return which.stdout.toString().trim()
  console.error("soffice not found. Install LibreOffice.")
  process.exit(1)
}

const soffice = findSoffice()
const sofficeProfile = resolve(previewDir, "libreoffice_profile")
mkdirSync(sofficeProfile, { recursive: true })
let converting = false
let pendingConvert = false
let debounceTimer: ReturnType<typeof setTimeout> | null = null
const clients = new Set<{ send(msg: string): void }>()

async function convertToPdf() {
  if (converting) { pendingConvert = true; return }
  converting = true
  broadcast(JSON.stringify({ status: "converting" }))

  if (!await Bun.file(pptxPath).exists()) { converting = false; return }

  const proc = Bun.spawn([
    soffice, "--headless", "--invisible", "--norestore",
    `-env:UserInstallation=file://${sofficeProfile}`,
    "--convert-to", "pdf",
    "--outdir", previewDir,
    pptxPath,
  ], { stdout: "pipe", stderr: "pipe" })

  await proc.exited
  converting = false

  if (proc.exitCode === 0 && existsSync(pdfPath)) {
    broadcast(JSON.stringify({ status: "updated", ts: Date.now() }))
  } else {
    const err = await new Response(proc.stderr).text()
    broadcast(JSON.stringify({ status: "error", message: err.slice(0, 200) }))
  }

  if (pendingConvert) { pendingConvert = false; scheduleConvert() }
}

function broadcast(msg: string) {
  for (const ws of clients) ws.send(msg)
}

function scheduleConvert() {
  if (debounceTimer) clearTimeout(debounceTimer)
  debounceTimer = setTimeout(convertToPdf, 800)
}

watch(dirname(pptxPath), (_, filename) => {
  if (filename === basename(pptxPath)) scheduleConvert()
})

const HTML = `<!DOCTYPE html>
<html><head>
<meta charset="utf-8">
<title>PPTX Preview</title>
<style>
* { margin: 0; padding: 0; box-sizing: border-box; }
html, body { height: 100%; overflow: hidden; }
body { display: flex; flex-direction: column; background: #1a1a1a; color: #eee; font-family: system-ui, sans-serif; }
#status { height: 28px; line-height: 28px; padding: 0 12px; font-size: 12px; background: #2a2a2a; border-bottom: 1px solid #333; display: flex; align-items: center; gap: 8px; flex-shrink: 0; }
#status .dot { width: 7px; height: 7px; border-radius: 50%; }
#status .dot.watching { background: #4caf50; }
#status .dot.converting { background: #ff9800; animation: pulse 0.8s infinite; }
#status .dot.error { background: #f44336; }
@keyframes pulse { 0%,100%{opacity:1} 50%{opacity:0.4} }
#pdf-frame { flex: 1; border: none; width: 100%; }
</style>
</head><body>
<div id="status"><span class="dot watching"></span><span id="status-text">Watching — ${basename(pptxPath)}</span></div>
<iframe id="pdf-frame" src="/preview.pdf"></iframe>
<script>
const frame = document.getElementById("pdf-frame");
const statusDot = document.querySelector(".dot");
const statusText = document.getElementById("status-text");

const ws = new WebSocket("ws://" + location.host + "/ws");
ws.onmessage = (e) => {
  const msg = JSON.parse(e.data);
  if (msg.status === "converting") {
    statusDot.className = "dot converting";
    statusText.textContent = "Converting...";
  } else if (msg.status === "updated") {
    statusDot.className = "dot watching";
    statusText.textContent = "Updated " + new Date(msg.ts).toLocaleTimeString();
    frame.src = "/preview.pdf?t=" + msg.ts;
  } else if (msg.status === "error") {
    statusDot.className = "dot error";
    statusText.textContent = "Error: " + msg.message;
  }
};
ws.onclose = () => { statusDot.className = "dot error"; statusText.textContent = "Server disconnected"; };
</script>
</body></html>`;

Bun.serve({
  port,
  fetch(req, server) {
    const url = new URL(req.url)
    if (url.pathname === "/ws") {
      if (server.upgrade(req)) return undefined
      return new Response("WebSocket upgrade failed", { status: 400 })
    }
    if (url.pathname === "/preview.pdf") {
      if (!existsSync(pdfPath)) return new Response("Not ready — waiting for first conversion", { status: 404 })
      return new Response(Bun.file(pdfPath), { headers: { "Content-Type": "application/pdf", "Cache-Control": "no-store" } })
    }
    return new Response(HTML, { headers: { "Content-Type": "text/html" } })
  },
  websocket: {
    open(ws) { clients.add(ws) },
    close(ws) { clients.delete(ws) },
    message() {},
  },
})

console.log(`PPTX Preview Server running`)
console.log(`  Watching: ${pptxPath}`)
console.log(`  URL:      http://localhost:${port}`)

process.on("SIGTERM", () => process.exit(0))
process.on("SIGINT", () => process.exit(0))

// Initial conversion
convertToPdf()
