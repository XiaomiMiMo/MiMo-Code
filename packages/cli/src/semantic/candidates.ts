/** Internal boundary for optional semantic retrieval. Candidates are untrusted evidence. */
export type SemanticFeature = "memory" | "history" | "failure" | "rebuild" | "inject"

export type SemanticCandidate = {
  source: string
  text: string
  signature: string
  rank: number
  sessionID?: string
  messageID?: string
  partID?: string
  time?: number
  kind?: string
}

export type SemanticQuery = {
  corpus: "memory" | "traj"
  query: string
  allowed: readonly string[]
  limit: number
  signal?: AbortSignal
}

export type SemanticResult = { status: "ok"; hits: SemanticCandidate[] } | { status: "unavailable" }

const flagByFeature: Record<SemanticFeature, string> = {
  memory: "MIMOCODE_SEMANTIC_MEMORY",
  history: "MIMOCODE_SEMANTIC_HISTORY",
  failure: "MIMOCODE_SEMANTIC_FAILURE",
  rebuild: "MIMOCODE_SEMANTIC_REBUILD",
  inject: "MIMOCODE_SEMANTIC_INJECT",
}

export function enabled(feature: SemanticFeature): boolean {
  return process.env.MIMOCODE_SEMANTIC_ENABLED === "true" && process.env[flagByFeature[feature]] === "true"
}

import { spawn } from "node:child_process"
import { createHash } from "node:crypto"

const unavailable: SemanticResult = { status: "unavailable" }
const MAX_OUTPUT = 1_000_000
const MAX_REQUEST = 32_000_000
const MAX_ALLOWED_SOURCES = 200_000
const DEADLINE_MS = 5_000
const MAX_CONCURRENT = 2
let active = 0

/** Calls the opt-in local helper; all failures collapse to unavailable and stay quiet. */
export async function search(input: SemanticQuery): Promise<SemanticResult> {
  if (!input.query.trim() || input.allowed.length === 0 || !Number.isFinite(input.limit) || input.limit < 1) return unavailable
  if (input.signal?.aborted) return unavailable
  if (Buffer.byteLength(input.query, "utf8") > 16_000 || input.allowed.length > MAX_ALLOWED_SOURCES || active >= MAX_CONCURRENT) return unavailable
  if (input.allowed.some((source) => Buffer.byteLength(source, "utf8") > 512)) return unavailable
  const helper = process.env.MIMOCODE_SEMINDEX_HELPER
  if (!helper) return unavailable
  const request = JSON.stringify({ corpus: input.corpus, query: input.query, allowed: input.allowed, limit: Math.min(input.limit, 50) })
  if (Buffer.byteLength(request, "utf8") > MAX_REQUEST) return unavailable
  return await new Promise<SemanticResult>((resolve) => {
    let settled = false
    let output = ""
    const finish = (result: SemanticResult) => {
      if (settled) return
      settled = true
      clearTimeout(timer)
      input.signal?.removeEventListener("abort", abort)
      active -= 1
      resolve(result)
    }
    const child = spawn(process.env.PYTHON ?? "python3", [helper], { stdio: ["pipe", "pipe", "ignore"] })
    active += 1
    const abort = () => child.kill("SIGKILL")
    const timer = setTimeout(() => child.kill("SIGKILL"), DEADLINE_MS)
    input.signal?.addEventListener("abort", abort, { once: true })
    child.stdout.setEncoding("utf8")
    child.stdout.on("data", (chunk: string) => {
      output += chunk
      if (output.length > MAX_OUTPUT) child.kill("SIGKILL")
    })
    child.stdin.on("error", () => child.kill("SIGKILL"))
    child.on("error", () => finish(unavailable))
    child.on("close", (code) => {
      if (code !== 0 || input.signal?.aborted) return finish(unavailable)
      try {
        const parsed: unknown = JSON.parse(output)
        if (!Array.isArray(parsed) || parsed.length > Math.min(input.limit, 50)) return finish(unavailable)
        const hits: SemanticCandidate[] = []
        for (const candidate of parsed) {
          if (!candidate || typeof candidate !== "object") return finish(unavailable)
          const item = candidate as Record<string, unknown>
          if (
            typeof item.source !== "string" || !input.allowed.includes(item.source) ||
            typeof item.text !== "string" || typeof item.signature !== "string" ||
            !/^[a-f0-9]{12}$/.test(item.signature) ||
            createHash("sha1").update(item.text, "utf8").digest("hex").slice(0, 12) !== item.signature ||
            !Number.isInteger(item.rank) || Number(item.rank) < 1 ||
            (item.sessionID != null && typeof item.sessionID !== "string") ||
            (item.messageID != null && typeof item.messageID !== "string") ||
            (item.partID != null && typeof item.partID !== "string") ||
            (item.time != null && typeof item.time !== "number") ||
            (item.kind != null && typeof item.kind !== "string")
          ) return finish(unavailable)
          hits.push(item as unknown as SemanticCandidate)
        }
        finish({ status: "ok", hits })
      } catch {
        finish(unavailable)
      }
    })
    child.stdin.end(request)
  })
}
