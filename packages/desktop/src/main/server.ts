import { app } from "electron"
import { DEFAULT_SERVER_URL_KEY, WSL_ENABLED_KEY } from "./constants"
import { getUserShell, loadShellEnv } from "./shell-env"
import { getStore } from "./store"
import fs from "fs"
import path from "path"

/**
 * Polyfill Bun-specific APIs for the Node.js (Electron) runtime.
 * The opencode dist bundle contains Bun.file() / Bun.write() calls that
 * are not available outside the Bun runtime. This shim provides minimal
 * Node.js-backed equivalents so the server works in Electron.
 */
function installBunPolyfill() {
  if (typeof (globalThis as any).Bun !== "undefined") return // already available

  const fileCache = new Map<string, { stat: () => Promise<fs.Stats>; text: () => Promise<string>; exists: () => Promise<boolean>; arrayBuffer: () => Promise<ArrayBuffer> }>()

  function bunFile(filePath: string) {
    if (fileCache.has(filePath)) return fileCache.get(filePath)!
    const entry = {
      async stat() { return fs.promises.stat(filePath) },
      async text() { return fs.promises.readFile(filePath, "utf-8") },
      async exists() {
        try { await fs.promises.access(filePath); return true } catch { return false }
      },
      async arrayBuffer(): Promise<ArrayBuffer> {
        const buf = await fs.promises.readFile(filePath)
        return buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength) as ArrayBuffer
      },
    }
    fileCache.set(filePath, entry)
    return entry
  }

  async function bunWrite(filePath: string, data: string | Blob | ArrayBuffer | Uint8Array): Promise<number> {
    const dir = path.dirname(filePath)
    await fs.promises.mkdir(dir, { recursive: true })
    if (typeof data === "string") {
      await fs.promises.writeFile(filePath, data, "utf-8")
      return data.length
    }
    const buf = Buffer.from(data instanceof Uint8Array ? data : new Uint8Array(data instanceof ArrayBuffer ? data : await data.arrayBuffer()))
    await fs.promises.writeFile(filePath, buf)
    return buf.length
  }

  ;(globalThis as any).Bun = {
    file: bunFile,
    write: bunWrite,
  }
}

export type WslConfig = { enabled: boolean }

export type HealthCheck = { wait: Promise<void> }

export function getDefaultServerUrl(): string | null {
  const value = getStore().get(DEFAULT_SERVER_URL_KEY)
  return typeof value === "string" ? value : null
}

export function setDefaultServerUrl(url: string | null) {
  if (url) {
    getStore().set(DEFAULT_SERVER_URL_KEY, url)
    return
  }

  getStore().delete(DEFAULT_SERVER_URL_KEY)
}

export function getWslConfig(): WslConfig {
  const value = getStore().get(WSL_ENABLED_KEY)
  return { enabled: typeof value === "boolean" ? value : false }
}

export function setWslConfig(config: WslConfig) {
  getStore().set(WSL_ENABLED_KEY, config.enabled)
}

export async function spawnLocalServer(hostname: string, port: number, password: string) {
  prepareServerEnv(password)
  installBunPolyfill()
  
  console.log("[desktop] Spawning local server...", { hostname, port })
  
  // Try to import the server module
  let Log: any
  let Server: any
  
  try {
    // First try the virtual module (for packaged builds)
    const virtual = await import("virtual:opencode-server")
    Log = virtual.Log
    Server = virtual.Server
    console.log("[desktop] Using virtual:opencode-server module")
  } catch (err) {
    console.log("[desktop] Virtual module failed, using direct import:", err)
    // Fallback: import directly from opencode source
    const serverModule = await import("../../../opencode/dist/node/node.js")
    Log = serverModule.Log
    Server = serverModule.Server
    console.log("[desktop] Using direct import from opencode")
  }
  
  await Log.init({ level: "INFO" })
  console.log("[desktop] Log initialized, starting server...")
  
  const listener = await Server.listen({
    port,
    hostname,
    username: "opencode",
    password,
    cors: ["oc://renderer", "http://localhost:*"],
  })
  
  console.log("[desktop] Server started, listener:", listener)

  const wait = (async () => {
    const url = `http://${hostname}:${port}`
    console.log("[desktop] Waiting for server health check at:", url)

    const ready = async () => {
      let attempts = 0
      while (true) {
        await new Promise((resolve) => setTimeout(resolve, 500))
        attempts++
        const healthy = await checkHealth(url, password)
        console.log(`[desktop] Health check attempt ${attempts}: ${healthy}`)
        if (healthy) return
      }
    }

    await ready()
    console.log("[desktop] Server is healthy!")
  })()

  return { listener, health: { wait } }
}

function prepareServerEnv(password: string) {
  const shell = process.platform === "win32" ? null : getUserShell()
  const shellEnv = shell ? (loadShellEnv(shell) ?? {}) : {}
  const env = {
    ...process.env,
    ...shellEnv,
    OPENCODE_EXPERIMENTAL_ICON_DISCOVERY: "true",
    OPENCODE_EXPERIMENTAL_FILEWATCHER: "true",
    OPENCODE_CLIENT: "desktop",
    OPENCODE_SERVER_USERNAME: "opencode",
    OPENCODE_SERVER_PASSWORD: password,
    XDG_STATE_HOME: app.getPath("userData"),
  }
  Object.assign(process.env, env)
}

export async function checkHealth(url: string, password?: string | null): Promise<boolean> {
  let healthUrl: URL
  try {
    healthUrl = new URL("/global/health", url)
  } catch {
    return false
  }

  const headers = new Headers()
  if (password) {
    const auth = Buffer.from(`opencode:${password}`).toString("base64")
    headers.set("authorization", `Basic ${auth}`)
  }

  try {
    const res = await fetch(healthUrl, {
      method: "GET",
      headers,
      signal: AbortSignal.timeout(3000),
    })
    return res.ok
  } catch {
    return false
  }
}
