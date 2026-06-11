import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import { Log } from "../util"
import { Global } from "../global"
import crypto from "crypto"
import os from "os"
import path from "path"
import fs from "fs"

const log = Log.create({ service: "plugin.mimo-free" })

const DEFAULT_BASE_URL = "https://api.xiaomimimo.com/"
const BASE_URL = (process.env.MIMO_FREE_BASE_URL || DEFAULT_BASE_URL).replace(/\/+$/, "")
const BOOTSTRAP_URL = `${BASE_URL}/api/free-ai/bootstrap`
const CHAT_BASE_URL = `${BASE_URL}/api/free-ai/openai`

let fingerprintCache: string | undefined
function getClientFingerprint(): string {
  if (fingerprintCache) return fingerprintCache
  const file = path.join(Global.Path.data, "mimo-free-client")
  try {
    const existing = fs.readFileSync(file, "utf-8").trim()
    if (existing) {
      fingerprintCache = existing
      return existing
    }
  } catch {}
  const cpu = os.cpus()[0]?.model ?? "unknown-cpu"
  const username = (() => {
    try {
      return os.userInfo().username
    } catch {
      return "unknown-user"
    }
  })()
  const seed = [os.hostname(), process.platform, process.arch, cpu, username].join("|")
  const fingerprint = crypto.createHash("sha256").update(seed).digest("hex")
  try {
    fs.writeFileSync(file, fingerprint, { mode: 0o600 })
  } catch (err) {
    log.warn("could not persist fingerprint", { error: err })
  }
  fingerprintCache = fingerprint
  return fingerprint
}

let cached: { jwt: string; exp: number } | null = null
let inflight: Promise<{ jwt: string; exp: number }> | null = null

function parseExp(jwt: string): number {
  const parts = jwt.split(".")
  if (parts.length < 2) return Date.now() + 50 * 60_000
  try {
    const payload = JSON.parse(Buffer.from(parts[1], "base64url").toString("utf-8"))
    if (typeof payload.exp === "number") return payload.exp * 1000
  } catch {}
  return Date.now() + 50 * 60_000
}

async function bootstrap(): Promise<{ jwt: string; exp: number }> {
  const res = await fetch(BOOTSTRAP_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ client: getClientFingerprint() }),
  })
  if (!res.ok) {
    const body = await res.text().catch(() => "")
    throw new Error(`mimo-free bootstrap failed: ${res.status} ${body.slice(0, 200)}`)
  }
  const data = (await res.json()) as { jwt?: string }
  if (!data.jwt) throw new Error("mimo-free bootstrap response missing jwt")
  return { jwt: data.jwt, exp: parseExp(data.jwt) }
}

const JWT_REFRESH_BUFFER_MS = 5 * 60_000

async function getJwt(): Promise<string> {
  if (cached && cached.exp - Date.now() > JWT_REFRESH_BUFFER_MS) return cached.jwt
  if (inflight) return (await inflight).jwt
  cached = null
  inflight = bootstrap()
  try {
    cached = await inflight
    return cached.jwt
  } finally {
    inflight = null
  }
}

export const MimoFree = {
  baseUrl: BASE_URL,
  bootstrapUrl: BOOTSTRAP_URL,
  chatBaseUrl: CHAT_BASE_URL,
  fingerprint: () => getClientFingerprint(),
  async verify() {
    cached = null
    const result = await bootstrap()
    cached = result
    return { jwt: result.jwt, exp: result.exp, fingerprint: getClientFingerprint() }
  },
}

function buildHeaders(init: any, jwt: string): Headers {
  const headers = new Headers(init?.headers)
  headers.set("Authorization", `Bearer ${jwt}`)
  headers.set("X-Mimo-Source", "mimocode-cli-free")
  return headers
}

async function wrappedFetch(input: any, init?: any): Promise<Response> {
  const url = typeof input === "string" || input instanceof URL ? String(input) : input.url
  const rewritten = url.replace(/\/chat\/completions(\?|$)/, "/chat$1")

  const jwt = await getJwt()
  const response = await fetch(rewritten, { ...init, headers: buildHeaders(init, jwt) })
  if (response.status !== 401 && response.status !== 403) return response

  cached = null
  const retryJwt = await getJwt()
  return fetch(rewritten, { ...init, headers: buildHeaders(init, retryJwt) })
}

export async function MimoFreeAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (input) => {
      input.provider ??= {}
      input.provider.mimo ??= {
        name: "MiMo Auto (free)",
        npm: "@ai-sdk/openai-compatible",
        api: CHAT_BASE_URL,
        options: {
          apiKey: "anonymous",
          fetch: wrappedFetch,
        },
        models: {
          "mimo-auto": {
            name: "MiMo Auto",
            attachment: true,
            reasoning: true,
            tool_call: true,
            temperature: true,
            modalities: { input: ["text", "image"], output: ["text"] },
            limit: { context: 1_000_000, output: 128_000 },
            cost: { input: 0, output: 0 },
          },
        },
      }
      input.disabled_providers ??= []
      for (const id of ["opencode", "opencode-go"]) {
        if (!input.disabled_providers.includes(id)) input.disabled_providers.push(id)
      }
    },
  }
}
