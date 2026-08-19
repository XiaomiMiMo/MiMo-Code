import path from "path"
import fs from "fs/promises"
import { createHash, timingSafeEqual } from "node:crypto"
import { Hash } from "@mimo-ai/shared/util/hash"
import { Flock } from "@mimo-ai/shared/util/flock"
import { Global } from "@/global"
import { Filesystem, Log } from "@/util"

const log = Log.create({ service: "llm-server.tokens" })

/**
 * Persistent registry of the temporary tokens this project's LLM server accepts.
 *
 * Persistence is not a convenience here, it is what makes a `mimo llm-server
 * issue` subcommand possible at all: the process that MINTS a token is not the
 * process that VALIDATES it, so the two have to meet somewhere outside memory.
 *
 * What lands on disk is only a SHA-256 of the token. The plaintext is printed once
 * at issue time and never stored, so reading this file does not yield a usable
 * credential. That is a stronger position than the original memory-only design,
 * not a weaker one — and the thing being protected (a loopback-only, revocable,
 * time-bounded stand-in) is far cheaper than the provider key it replaces, which
 * already lives on disk in `auth.json`.
 *
 * Scoped per project directory, because the server is pinned to one directory and
 * a token must not be replayable against a different project's provider config.
 */

export type Expiry = {
  /**
   * Sliding window in ms. The token dies this long after its LAST use, not after
   * issue, so a skill that keeps working never has the endpoint pulled out from
   * under it mid-task. `undefined` means no idle limit.
   */
  idleMs?: number
  /**
   * Hard ceiling in ms from issue. Survives any amount of activity, so an
   * indefinitely busy token still has an end. `undefined` means no ceiling.
   */
  maxAgeMs?: number
}

export type Record_ = {
  id: string
  /** SHA-256 hex of the token. The token itself is never stored. */
  hash: string
  label?: string
  /** Restricts this token to these `provider/model` refs. Empty means all. */
  models: string[]
  created: number
  last_used?: number
  idle_ms?: number
  max_age_ms?: number
}

type Store = {
  version: 1
  tokens: Record_[]
}

const EMPTY: Store = { version: 1, tokens: [] }

function dir(directory: string) {
  // `Filesystem.resolve` and not `path.resolve`: the bucket is keyed by the directory
  // STRING, and on macOS one directory has two spellings — `mkdtemp` and a shell hand
  // back `/var/folders/…` while a process's own `cwd` resolves to `/private/var/…`. Two
  // spellings meant two buckets, so a token issued seconds earlier came back invalid.
  // Canonicalising here, at the single entry point, is what keeps issuer and verifier
  // looking at the same file.
  return path.join(Global.Path.state, "llm-server", Hash.fast(Filesystem.resolve(directory)))
}

function file(directory: string) {
  return path.join(dir(directory), "tokens.json")
}

/**
 * Where a running server advertises how to reach it, for `issue` to read.
 *
 * One file PER PROCESS, because every mimocode process that serves this project binds
 * its own loopback listener. A single `server.json` would make them overwrite each
 * other and hand a caller whichever session wrote last — reachable, but not the one
 * that spawned them. The pid in the name is also the liveness check (see `addresses`).
 */
export function addressFile(directory: string, pid = process.pid) {
  return path.join(dir(directory), `server-${pid}.json`)
}

export type Address = { pid: number; hostname: string; port: number; url: string; started: number }

export async function publish(directory: string, address: Address) {
  await fs.mkdir(dir(directory), { recursive: true, mode: 0o700 })
  await fs.writeFile(addressFile(directory, address.pid), JSON.stringify(address), { mode: 0o600 })
}

export async function unpublish(directory: string, pid = process.pid) {
  await fs.rm(addressFile(directory, pid), { force: true })
}

/**
 * Read a JSON file as `unknown`.
 *
 * Typed `unknown` rather than asserted into shape, because these files are state on
 * disk that another process wrote: a truncated write or a version skew must be
 * narrowed, not declared. A missing or unparseable file is simply absent.
 */
async function readJson(target: string): Promise<unknown> {
  const text = await fs.readFile(target, "utf8").catch(() => undefined)
  if (text === undefined) return undefined
  try {
    return JSON.parse(text)
  } catch {
    return undefined
  }
}

/** A type predicate rather than a cast, so the narrowing is checked, not claimed. */
function fields(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value)
}

/**
 * Every live listener serving this project, newest first.
 *
 * A crashed server leaves its file behind, and handing that stale port to a skill
 * would produce a connection error far away from the cause. `kill(pid, 0)` costs
 * nothing and turns it into an honest "nothing is running"; the dead file is removed
 * on the way past, so the directory does not accumulate one entry per crash.
 */
export async function addresses(directory: string): Promise<Address[]> {
  const names = await fs.readdir(dir(directory)).catch(() => [] as string[])
  const found = await Promise.all(
    names
      .filter((name) => name.startsWith("server-") && name.endsWith(".json"))
      .map(async (name) => {
        const target = path.join(dir(directory), name)
        const raw = await readJson(target)
        if (!fields(raw)) return undefined
        if (typeof raw["pid"] !== "number" || typeof raw["port"] !== "number") return undefined
        if (typeof raw["hostname"] !== "string" || typeof raw["url"] !== "string") return undefined
        try {
          process.kill(raw["pid"], 0)
        } catch {
          // EPERM means a live process we do not own, which is still a live process —
          // but it cannot be one of ours, and its port is not ours to advertise.
          await fs.rm(target, { force: true }).catch(() => {})
          return undefined
        }
        return {
          pid: raw["pid"],
          hostname: raw["hostname"],
          port: raw["port"],
          url: raw["url"],
          started: typeof raw["started"] === "number" ? raw["started"] : 0,
        }
      }),
  )
  return found.filter((item): item is Address => item !== undefined).sort((a, b) => b.started - a.started)
}

/**
 * One live listener, or nothing.
 *
 * The most recently started, because with several sessions open on one project that is
 * the one a human just launched and therefore the one they mean. A CHILD process must
 * not resolve its endpoint this way — it is told the exact URL by whoever spawned it;
 * this is the fallback for a person at a shell.
 */
export async function address(directory: string): Promise<Address | undefined> {
  return (await addresses(directory))[0]
}

async function read(directory: string): Promise<Store> {
  const raw = await readJson(file(directory))
  if (!fields(raw) || raw["version"] !== 1 || !Array.isArray(raw["tokens"])) return { ...EMPTY }
  // Records are filtered rather than trusted wholesale: one corrupt entry should
  // cost its own token, not every token in the file.
  return { version: 1, tokens: raw["tokens"].filter(isRecord) }
}

function isRecord(value: unknown): value is Record_ {
  if (!fields(value)) return false
  const raw = value
  if (typeof raw["id"] !== "string" || typeof raw["hash"] !== "string") return false
  if (typeof raw["created"] !== "number") return false
  return Array.isArray(raw["models"])
}

async function write(directory: string, store: Store) {
  await fs.mkdir(dir(directory), { recursive: true, mode: 0o700 })
  // Write-then-rename so a concurrent reader never sees a half-written file.
  const tmp = `${file(directory)}.${process.pid}.tmp`
  await fs.writeFile(tmp, JSON.stringify(store, null, 2), { mode: 0o600 })
  await fs.rename(tmp, file(directory))
}

/**
 * Serialize read-modify-write so two `issue` calls cannot clobber each other.
 *
 * Writes only when the mutator actually changed something. Every request passes
 * through `verify`, so writing unconditionally let an UNAUTHENTICATED caller drive
 * an unbounded stream of file writes, and made read-only outcomes queue behind a
 * write for no reason.
 *
 * A successful `verify` does still write, because sliding expiry has to persist the
 * slide. Throttling that to a coarse granularity would be cheaper but is not safe in
 * general: a token whose idle window is shorter than the granularity would expire
 * while actively in use.
 */
function mutate<T>(directory: string, fn: (store: Store) => Promise<T> | T) {
  return Flock.withLock(`llm-server-tokens:${dir(directory)}`, async () => {
    const store = await read(directory)
    const before = JSON.stringify(store)
    const result = await fn(store)
    if (JSON.stringify(store) !== before) await write(directory, store)
    return result
  })
}

function digest(token: string) {
  return createHash("sha256").update(token).digest("hex")
}

/**
 * Is this record dead as of `now`?
 *
 * Idle is measured from last use and falls back to creation for a token that has
 * never been presented, so an issued-and-forgotten token still ages out.
 */
export function expired(record: Record_, now = Date.now()) {
  if (record.max_age_ms !== undefined && now - record.created > record.max_age_ms) return true
  if (record.idle_ms !== undefined && now - (record.last_used ?? record.created) > record.idle_ms) return true
  return false
}

export function expiresAt(record: Record_) {
  const idle = record.idle_ms === undefined ? undefined : (record.last_used ?? record.created) + record.idle_ms
  const absolute = record.max_age_ms === undefined ? undefined : record.created + record.max_age_ms
  const candidates = [idle, absolute].filter((v): v is number => v !== undefined)
  if (candidates.length === 0) return undefined
  return Math.min(...candidates)
}

export function generate() {
  return Buffer.from(crypto.getRandomValues(new Uint8Array(32))).toString("base64url")
}

export async function issue(input: {
  directory: string
  expiry: Expiry
  models?: readonly string[]
  label?: string
}) {
  const token = generate()
  const record: Record_ = {
    id: `llmk_${crypto.randomUUID().replaceAll("-", "").slice(0, 16)}`,
    hash: digest(token),
    label: input.label,
    models: [...(input.models ?? [])],
    created: Date.now(),
    idle_ms: input.expiry.idleMs,
    max_age_ms: input.expiry.maxAgeMs,
  }
  await mutate(input.directory, (store) => {
    // Sweep on write: expired records have no purpose and an unbounded file would
    // eventually make every request pay for them.
    store.tokens = store.tokens.filter((t) => !expired(t)).concat(record)
  })
  log.info("issued", { id: record.id, models: record.models.length, label: record.label })
  return { token, record }
}

export type Verdict =
  | { ok: true; record: Record_ }
  | { ok: false; reason: "unknown" }
  | { ok: false; reason: "expired"; record: Record_ }

/**
 * Check a presented token and, when it is good, slide its window forward.
 *
 * The comparison walks every record with `timingSafeEqual` on the HASHES rather
 * than the tokens: hashes are fixed length, so there is no length side channel and
 * no throw to guard against.
 */
export async function verify(directory: string, token: string): Promise<Verdict> {
  const presented = Buffer.from(digest(token), "hex")
  return mutate(directory, (store) => {
    const found = store.tokens.find((t) => {
      const stored = Buffer.from(t.hash, "hex")
      return stored.length === presented.length && timingSafeEqual(stored, presented)
    })
    if (!found) return { ok: false, reason: "unknown" } as const
    if (expired(found)) {
      store.tokens = store.tokens.filter((t) => t.id !== found.id)
      return { ok: false, reason: "expired", record: found } as const
    }
    found.last_used = Date.now()
    return { ok: true, record: found } as const
  })
}

export async function list(directory: string) {
  const store = await read(directory)
  return store.tokens.map((t) => ({ ...t, expired: expired(t), expires_at: expiresAt(t) }))
}

export async function revoke(directory: string, id: string) {
  return mutate(directory, (store) => {
    const before = store.tokens.length
    store.tokens = store.tokens.filter((t) => t.id !== id)
    return store.tokens.length < before
  })
}

export async function revokeAll(directory: string) {
  return mutate(directory, (store) => {
    const count = store.tokens.length
    store.tokens = []
    return count
  })
}

export * as LLMServerTokens from "./tokens"
