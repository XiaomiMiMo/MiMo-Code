#!/usr/bin/env bun
/**
 * PPTX Preview — launcher and lifecycle manager.
 *
 * Spawns preview_server.ts as a detached background process, writes a PID
 * file, prints the URL, and exits immediately. Detects already-running
 * instances. Supports --stop to kill a running server.
 *
 * Usage:
 *   bun run scripts/preview.ts output.pptx              # start, default port 4200
 *   bun run scripts/preview.ts output.pptx --port 5000  # start on custom port
 *   bun run scripts/preview.ts --stop output.pptx       # stop running server
 */
import { resolve, dirname, basename } from "node:path"
import { existsSync, readFileSync, writeFileSync, unlinkSync, mkdirSync } from "node:fs"
import { parseArgs } from "node:util"

const { values, positionals } = parseArgs({
  args: Bun.argv.slice(2),
  options: {
    port: { type: "string", default: "4200" },
    stop: { type: "boolean", default: false },
  },
  allowPositionals: true,
})

const port = parseInt(values.port!, 10)

function previewDirFor(pptxPath: string) {
  return resolve(dirname(pptxPath), ".pptx-preview")
}

function pidFileFor(pptxPath: string) {
  return resolve(previewDirFor(pptxPath), "server.pid")
}

function isProcessAlive(pid: number): boolean {
  try { process.kill(pid, 0); return true } catch { return false }
}

function readPid(pidFile: string): { pid: number; port: number } | null {
  if (!existsSync(pidFile)) return null
  const content = readFileSync(pidFile, "utf-8").trim()
  const [pidStr, portStr] = content.split(":")
  const pid = parseInt(pidStr, 10)
  if (isNaN(pid)) return null
  return { pid, port: parseInt(portStr, 10) || 4200 }
}

// --- Stop mode ---
if (values.stop) {
  const source = positionals[0]
  if (!source) {
    console.error("Usage: bun run preview.ts --stop <file.pptx>")
    process.exit(2)
  }
  const pidFile = pidFileFor(resolve(source))
  const info = readPid(pidFile)
  if (info && isProcessAlive(info.pid)) {
    process.kill(info.pid, "SIGTERM")
    unlinkSync(pidFile)
    console.log(`Stopped preview server (pid ${info.pid})`)
  } else {
    if (existsSync(pidFile)) unlinkSync(pidFile)
    console.log("No running preview server for this file")
  }
  process.exit(0)
}

// --- Start mode ---
const source = positionals[0]
if (!source) {
  console.error("Usage: bun run preview.ts <file.pptx> [--port N]")
  console.error("       bun run preview.ts --stop <file.pptx>")
  process.exit(2)
}

const pptxPath = resolve(source)
if (!existsSync(pptxPath)) {
  console.error(`File not found: ${pptxPath}`)
  process.exit(1)
}

const previewDir = previewDirFor(pptxPath)
const pidFile = pidFileFor(pptxPath)
mkdirSync(previewDir, { recursive: true })

// Check if already running
const existing = readPid(pidFile)
if (existing && isProcessAlive(existing.pid)) {
  console.log(`Preview server already running (pid ${existing.pid})`)
  console.log(`  URL: http://localhost:${existing.port}`)
  process.exit(0)
}

// Spawn detached server
const scriptPath = resolve(import.meta.dir, "preview_server.ts")
const logFile = resolve(previewDir, "server.log")

const child = Bun.spawn(
  ["bun", "run", scriptPath, pptxPath, "--port", String(port)],
  {
    stdout: Bun.file(logFile),
    stderr: Bun.file(logFile),
    stdin: "ignore",
  },
)

// Detach child so this process can exit
child.unref()

// Write PID:port
writeFileSync(pidFile, `${child.pid}:${port}`)

console.log(`PPTX Preview Server started (pid ${child.pid})`)
console.log(`  Watching: ${pptxPath}`)
console.log(`  URL:      http://localhost:${port}`)
console.log(`  Log:      ${logFile}`)
console.log(`\n  Stop with: bun run scripts/preview.ts --stop ${basename(pptxPath)}`)
