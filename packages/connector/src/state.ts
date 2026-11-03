// Durable connector state: bindings and local consent, the per-lane fence gate
// and the phone-request -> message-ID map.
//
// The file is AES-GCM encrypted with a data key that lives only in the
// SecretStore, so nothing readable lands on disk and no symmetric key is stored
// next to the data. Writes are serialized and atomic (temp file + rename).

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import { base64url, fromBase64url } from "./json"
import type { SecretStore } from "./ports"

export type Consent = {
  bindingId: string
  phoneId: string
  phoneName: string
  /** Account the user confirmed under; a different account needs a new confirmation. */
  subject: string
  environment: string
  scopes: ["sessions:list", "sessions:read"] | ["sessions:list", "sessions:read", "sessions:send"]
  confirmedAt: number
}

export type GateEntry = {
  fenceId: string
  grantVersion: number
  revocationVersion: number
  connectionEpoch: number
  active: boolean
}

export type Submission = { messageId: string; textSha256: string; createdAt: number }

export type ConnectorState = {
  version: 1
  consents: Record<string, Consent>
  /** `${bindingId}:${lane}` -> last fence this installation made durable. */
  gates: Record<string, GateEntry>
  /** `${bindingId}:${sessionId}:${requestId}` -> the message ID a phone request was submitted as. */
  submissions: Record<string, Submission>
}

const DATA_KEY = "state-key"
/** Submissions older than this can no longer be queried by a phone (Connect drops the request). */
const SUBMISSION_TTL_MS = 7 * 24 * 60 * 60 * 1000

export function emptyState(): ConnectorState {
  return { version: 1, consents: {}, gates: {}, submissions: {} }
}

export class StateFile {
  private cache: ConnectorState | undefined
  private writing: Promise<void> = Promise.resolve()

  constructor(
    private readonly file: string,
    private readonly secrets: SecretStore,
    private readonly clock: () => number = Date.now,
  ) {}

  async read(): Promise<ConnectorState> {
    if (this.cache) return this.cache
    const key = await this.key(false)
    let raw: Buffer
    try {
      raw = await readFile(this.file)
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return (this.cache = emptyState())
      throw error
    }
    // An unreadable state is reported, never replaced by an empty one: that would
    // silently drop consents and the submission map.
    if (!key) throw new Error("connector state exists but its key is missing")
    const [iv, data] = raw.toString("utf8").split(".")
    const plain = await crypto.subtle.decrypt({ name: "AES-GCM", iv: fromBase64url(iv) }, key, fromBase64url(data))
    const state = JSON.parse(new TextDecoder().decode(plain)) as ConnectorState
    if (state.version !== 1) throw new Error("unknown connector state version")
    return (this.cache = state)
  }

  /** Apply `change` and make it durable before resolving. Serialized across callers. */
  async update(change: (state: ConnectorState) => void): Promise<void> {
    const run = this.writing.then(async () => {
      const next = structuredClone(await this.read())
      change(next)
      this.prune(next)
      await this.write(next)
      this.cache = next
    })
    this.writing = run.catch(() => {})
    return run
  }

  private prune(state: ConnectorState): void {
    const cutoff = this.clock() - SUBMISSION_TTL_MS
    for (const [id, submission] of Object.entries(state.submissions)) {
      if (submission.createdAt < cutoff) delete state.submissions[id]
    }
  }

  private async write(state: ConnectorState): Promise<void> {
    const key = (await this.key(true))!
    const iv = crypto.getRandomValues(new Uint8Array(12))
    const data = new Uint8Array(
      await crypto.subtle.encrypt({ name: "AES-GCM", iv }, key, new TextEncoder().encode(JSON.stringify(state))),
    )
    await mkdir(path.dirname(this.file), { recursive: true, mode: 0o700 })
    const temp = `${this.file}.${process.pid}.tmp`
    await writeFile(temp, `${base64url(iv)}.${base64url(data)}`, { mode: 0o600, flush: true })
    await rename(temp, this.file).catch(async (error) => {
      await rm(temp, { force: true })
      throw error
    })
  }

  private async key(create: boolean): Promise<CryptoKey | undefined> {
    const stored = await this.secrets.get(DATA_KEY)
    if (stored) return crypto.subtle.importKey("raw", fromBase64url(stored), "AES-GCM", false, ["encrypt", "decrypt"])
    if (!create) return undefined
    const raw = crypto.getRandomValues(new Uint8Array(32))
    await this.secrets.set(DATA_KEY, base64url(raw))
    return crypto.subtle.importKey("raw", raw, "AES-GCM", false, ["encrypt", "decrypt"])
  }
}
