import path from "node:path"
import { createHash } from "node:crypto"
import { mkdir, readFile, writeFile, open, rm, realpath } from "node:fs/promises"
import { spawn } from "node:child_process"
import z from "zod"
import { Flock } from "@mimo-ai/shared/util/flock"
import { Global } from "@/global"
import { Flag, generateServerPassword } from "@/flag/flag"
import type { Listener } from "./server"

const Record = z.object({
  pid: z.number().int().positive(),
  directory: z.string(),
  url: z.url(),
  password: z.string(),
  startedAt: z.number(),
})
export type Record = z.infer<typeof Record>
export const root = (directory: string) =>
  path.join(Global.Path.state, "daemon", createHash("sha256").update(directory).digest("hex").slice(0, 20))
const file = (directory: string) => path.join(root(directory), "service.json")
async function record(directory: string) {
  const text = await readFile(file(directory), "utf8").catch(() => "null")
  try {
    const result = Record.safeParse(JSON.parse(text))
    return result.success ? result.data : undefined
  } catch {
    return
  }
}
function alive(pid: number) {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}
export const headers = (service: Record) => ({
  Authorization: `Basic ${Buffer.from(`${process.env.MIMOCODE_SERVER_USERNAME ?? "mimocode"}:${service.password}`).toString("base64")}`,
})
export async function status(directory: string) {
  const current = await record(directory)
  if (!current || current.directory !== directory || !alive(current.pid)) return
  const url = new URL(current.url)
  if (url.hostname !== "127.0.0.1") throw new Error("Invalid local daemon address")
  try {
    const response = await fetch(new URL("/global/health", url), {
      headers: headers(current),
      signal: AbortSignal.timeout(1500),
    })
    if (response.ok) return current
  } catch {
    /* A starting or unavailable process is not a usable service. */
  }
}
export function launchCommand() {
  const entry = process.argv[1]
  if (entry && /\.(?:ts|js|mjs)$/.test(entry)) {
    const options = process.execArgv.filter((arg) => arg !== "run")
    if (entry.endsWith(".ts") && process.versions.bun)
      options.push("--preload", import.meta.resolve("@opentui/solid/preload"))
    return [process.execPath, ...options, path.resolve(entry)]
  }
  return [process.execPath]
}
export async function ensure(directory: string) {
  directory = await realpath(directory)
  await mkdir(root(directory), { recursive: true, mode: 0o700 })
  await using _lock = await Flock.acquire(`daemon:${directory}`, { timeoutMs: 30000, staleMs: 30000 })
  const existing = await status(directory)
  if (existing) return existing
  const previous = await record(directory)
  if (previous && alive(previous.pid))
    throw new Error(
      `The workspace service is alive but unavailable (PID ${previous.pid}). Inspect ${path.join(root(directory), "service.log")} before restarting it.`,
    )
  const logFile = path.join(root(directory), "service.log")
  const log = await open(logFile, "a", 0o600)
  const [executable, ...args] = launchCommand()
  const child = spawn(executable, [...args, "serve", "--hostname", "127.0.0.1", "--port", "0"], {
    cwd: directory,
    detached: true,
    stdio: ["ignore", log.fd, log.fd],
    env: { ...process.env, MIMOCODE_DAEMON_DIRECTORY: directory, MIMOCODE_PROCESS_ROLE: "daemon" },
  })
  const failure: { value?: Error; exited?: boolean } = {}
  child.on("error", (error) => {
    failure.value = error
  })
  child.on("exit", () => {
    failure.exited = true
  })
  child.unref()
  await log.close()
  const deadline = Date.now() + 30000
  while (Date.now() < deadline) {
    if (failure.value) throw failure.value
    const ready = await status(directory)
    if (ready && ready.pid === child.pid) return ready
    if (failure.exited) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  throw new Error(`Background MiMo Server did not become ready. Inspect ${logFile}`)
}
export function prepare() {
  if (process.env.MIMOCODE_DAEMON_DIRECTORY) generateServerPassword()
}
export async function publish(service: Listener) {
  const directory = process.env.MIMOCODE_DAEMON_DIRECTORY
  if (!directory) return
  const record: Record = {
    pid: process.pid,
    directory,
    url: service.url.toString(),
    password: Flag.MIMOCODE_SERVER_PASSWORD ?? "",
    startedAt: Date.now(),
  }
  await mkdir(root(directory), { recursive: true, mode: 0o700 })
  await writeFile(file(directory), JSON.stringify(record), { mode: 0o600 })
}
export async function withdraw() {
  const directory = process.env.MIMOCODE_DAEMON_DIRECTORY
  if (!directory) return
  const current = await record(directory)
  if (current?.pid === process.pid) await rm(file(directory), { force: true })
}
export async function stop(directory: string) {
  const service = await status(await realpath(directory))
  if (!service) return false
  process.kill(service.pid, "SIGTERM")
  return true
}
