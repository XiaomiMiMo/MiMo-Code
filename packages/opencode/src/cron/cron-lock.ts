import { Effect } from "effect"
import { join } from "path"
import { mkdir, readFile, unlink, writeFile, open } from "fs/promises"
import { Log } from "@/util"

const log = Log.create({ service: "cron-lock" })

export type LockInfo = {
  pid: number
  startedAt: number
  identity?: string
}

const PROC_STARTED_AT = Date.now() - Math.floor(process.uptime() * 1000)

export const getLockFilePath = (dir?: string) => join(dir ?? process.cwd(), ".mimocode", ".cron-lock")

const parseLockInfo = (raw: string): LockInfo | null => {
  const obj = Effect.runSync(
    Effect.try({ try: () => JSON.parse(raw) as Record<string, unknown>, catch: () => null }).pipe(
      Effect.orElseSucceed(() => null),
    ),
  )
  if (obj === null) return null
  if (typeof obj.pid !== "number") return null
  if (typeof obj.startedAt !== "number") return null
  const out: LockInfo = { pid: obj.pid, startedAt: obj.startedAt }
  if (typeof obj.identity === "string") out.identity = obj.identity
  return out
}

const isPidAlive = (pid: number): boolean =>
  Effect.runSync(
    Effect.try({
      try: () => {
        process.kill(pid, 0)
        return true
      },
      catch: (e) => {
        const code = (e as NodeJS.ErrnoException)?.code
        if (code === "EPERM") return true
        return false
      },
    }).pipe(Effect.orElseSucceed(() => false)),
  )

// Returns "created" on success, "exists" if file already present, "error" otherwise.
const writeLockExclusive = (path: string, info: LockInfo) =>
  Effect.tryPromise({
    try: async () => {
      const fh = await open(path, "wx").catch((e: NodeJS.ErrnoException) => {
        if (e.code === "EEXIST") return null
        throw e
      })
      if (fh === null) return "exists" as const
      await fh.writeFile(JSON.stringify(info))
      await fh.close()
      return "created" as const
    },
    catch: () => "error" as const,
  }).pipe(Effect.orElseSucceed(() => "error" as const))

const overwriteLock = (path: string, info: LockInfo) =>
  Effect.tryPromise({
    try: async () => {
      await writeFile(path, JSON.stringify(info))
      return true
    },
    catch: () => false,
  }).pipe(Effect.orElseSucceed(() => false))

const readLockFile = (path: string) =>
  Effect.tryPromise({
    try: () => readFile(path, "utf-8"),
    catch: () => null,
  }).pipe(Effect.orElseSucceed(() => null as string | null))

export const tryAcquireSchedulerLock = (opts?: { dir?: string; lockIdentity?: string }) =>
  Effect.gen(function* () {
    const path = getLockFilePath(opts?.dir)
    yield* Effect.tryPromise({
      try: () => mkdir(join(path, ".."), { recursive: true }),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))

    const self: LockInfo = {
      pid: process.pid,
      startedAt: PROC_STARTED_AT,
      ...(opts?.lockIdentity ? { identity: opts.lockIdentity } : {}),
    }

    const createResult = yield* writeLockExclusive(path, self)
    if (createResult === "created") {
      log.debug("acquired (fresh)", { pid: self.pid })
      return true
    }
    if (createResult === "error") {
      log.debug("acquire failed (unexpected fs error)")
      return false
    }

    const raw = yield* readLockFile(path)
    if (raw === null) {
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    const existing = parseLockInfo(raw)
    if (existing === null) {
      log.debug("malformed lock; taking over")
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    if (existing.pid === process.pid && existing.startedAt === PROC_STARTED_AT) {
      log.debug("already owned by self (idempotent)")
      return true
    }

    if (!isPidAlive(existing.pid)) {
      log.debug("previous owner dead; taking over", { deadPid: existing.pid })
      const ow = yield* overwriteLock(path, self)
      return ow
    }

    log.debug("lock held by live process", { pid: existing.pid })
    return false
  })

export const releaseSchedulerLock = (opts?: { dir?: string }) =>
  Effect.gen(function* () {
    const path = getLockFilePath(opts?.dir)
    const raw = yield* readLockFile(path)
    if (raw === null) return
    const existing = parseLockInfo(raw)
    if (existing === null) return
    if (existing.pid !== process.pid) return
    yield* Effect.tryPromise({
      try: () => unlink(path),
      catch: () => undefined,
    }).pipe(Effect.orElseSucceed(() => undefined))
    log.debug("released", { pid: process.pid })
  })
