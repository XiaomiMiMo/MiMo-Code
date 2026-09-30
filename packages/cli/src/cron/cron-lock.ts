import { Effect } from "effect"
import { join } from "path"
import { mkdir, readFile, rename, unlink, writeFile, open } from "fs/promises"
import { readFileSync } from "fs"
import { Log } from "@/util"
import { ensureMimocodeGitignore } from "@/config/gitignore"

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

// Read a Linux pid's start time (jiffies since boot, field 22 of /proc/<pid>/stat).
// Returns null on non-Linux, on read failure, or on parse failure. The caller
// uses this to detect PID recycling: if /proc reports a start time AFTER what's
// stored in the lock, the original owner died and the PID was reassigned.
const readPidStartJiffies = (pid: number): number | null => {
  if (process.platform !== "linux") return null
  return Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync(`/proc/${pid}/stat`, "utf-8")
        // The comm field (field 2) is parenthesised and may contain spaces; skip past the last `)`.
        const lastParen = raw.lastIndexOf(")")
        if (lastParen < 0) return null as number | null
        const rest = raw.slice(lastParen + 2).split(/\s+/)
        // After the comm field, indexing is 0=state(3), so starttime(22) is at rest[19].
        const jiffies = parseInt(rest[19] ?? "", 10)
        return Number.isFinite(jiffies) ? jiffies : null
      },
      catch: () => null as number | null,
    }).pipe(Effect.orElseSucceed(() => null as number | null)),
  )
}

// Read /proc/uptime and return current system uptime in ms.
// /proc/uptime format: "<seconds-since-boot> <idle-seconds>", both floats.
const readUptimeMs = (): number | null => {
  if (process.platform !== "linux") return null
  return Effect.runSync(
    Effect.try({
      try: () => {
        const raw = readFileSync("/proc/uptime", "utf-8")
        const first = raw.split(/\s+/)[0]
        const sec = parseFloat(first ?? "")
        return Number.isFinite(sec) ? Math.floor(sec * 1000) : null
      },
      catch: () => null as number | null,
    }).pipe(Effect.orElseSucceed(() => null as number | null)),
  )
}

let selfStartJiffies: number | null | undefined = undefined
const getSelfStartJiffies = (): number | null => {
  if (selfStartJiffies === undefined) selfStartJiffies = readPidStartJiffies(process.pid)
  return selfStartJiffies
}

// Cached at first successful read: milliseconds-per-jiffy. On typical Linux
// systems CLK_TCK=100 so this is ~10, but we don't hardcode — we derive it
// from the correspondence between our own PROC_STARTED_AT (epoch ms) and our
// own /proc starttime (boot-relative jiffies), using /proc/uptime to pin the
// boot moment. Node doesn't expose sysconf(_SC_CLK_TCK) portably.
let cachedMsPerJiffy: number | null | undefined = undefined
const getMsPerJiffy = (): number | null => {
  if (cachedMsPerJiffy !== undefined) return cachedMsPerJiffy
  const selfJiffies = getSelfStartJiffies()
  const uptimeMs = readUptimeMs()
  if (selfJiffies === null || uptimeMs === null || selfJiffies < 1) {
    cachedMsPerJiffy = null
    return null
  }
  // Boot happened `uptimeMs` ago in wall-clock time. Our process started at
  // PROC_STARTED_AT (epoch ms). So our process is (Date.now() - PROC_STARTED_AT)
  // ms into its life, and started (uptimeMs - (Date.now() - PROC_STARTED_AT))
  // ms after boot. selfJiffies jiffies had elapsed by that moment. Solve for
  // the ratio.
  const bootTimeMs = Date.now() - uptimeMs
  const selfStartMsAfterBoot = PROC_STARTED_AT - bootTimeMs
  if (selfStartMsAfterBoot < 1) {
    cachedMsPerJiffy = null
    return null
  }
  cachedMsPerJiffy = selfStartMsAfterBoot / selfJiffies
  return cachedMsPerJiffy
}

// True if the pid in the lock genuinely names the live process that wrote it.
// PR #1479 finding #7: process.kill(pid, 0) alone says "some process with this
// PID is alive" — a recycled PID would falsely report the lock as held. On
// Linux, cross-check the pid's start time against the lock's startedAt to
// detect recycling; the previous version of this code did the arithmetic
// wrong (dividing self-uptime by boot-relative jiffies, which are unrelated
// quantities) and never actually triggered.
// True if the pid in the lock genuinely names the live process that wrote it.
// PR #1479 finding #7: process.kill(pid, 0) alone says "some process with this
// PID is alive" — a recycled PID would falsely report the lock as held. On
// Linux, cross-check the pid's start time against the lock's startedAt to
// detect recycling.
//
// PR #1479 re-review round 2: this used to be wrapped in Effect.try({try, catch})
// piped to orElseSucceed(() => false). That was subtly wrong: Effect.try's
// `catch` handler's return value populates the ERROR channel, not the success
// channel, so `catch: () => true` (intended for EPERM = "alive, just can't
// signal it") produced a failed effect carrying `true` as its error — which
// orElseSucceed then replaced with `false`. Net: EPERM → judged dead → any
// scheduler running under a different uid than the current lock owner would
// take over and become a second concurrent owner. Plain sync JS with a real
// try/catch matches the intent.
const isPidAlive = (pid: number, lockStartedAtMs: number): boolean => {
  try {
    process.kill(pid, 0)
  } catch (e) {
    const code = (e as NodeJS.ErrnoException)?.code
    // EPERM = pid exists but we can't signal it (different uid). Treat as
    // alive so we don't take over a foreign-user's lock and double-fire.
    // ESRCH (or anything else) = truly dead → treat as dead.
    return code === "EPERM"
  }
  // Liveness probe says yes. Check for PID recycling on Linux.
  const otherJiffies = readPidStartJiffies(pid)
  const msPerJiffy = getMsPerJiffy()
  const uptimeMs = readUptimeMs()
  if (otherJiffies === null || msPerJiffy === null || uptimeMs === null) return true

  // Reconstruct when THIS pid actually started, in epoch ms.
  const bootTimeMs = Date.now() - uptimeMs
  const otherStartedAtMs = bootTimeMs + otherJiffies * msPerJiffy

  // The live pid is the ORIGINAL lock owner only if its actual start time
  // matches the claimed startedAt (within slop). Any material discrepancy —
  // pid younger than claim OR older than claim — means the pid has been
  // reassigned since the lock was written. 2s slop for clock/jiffy rounding.
  return Math.abs(otherStartedAtMs - lockStartedAtMs) <= 2_000
}

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

// PR #1479 finding #6: atomic takeover via temp-file + rename. Plain writeFile
// is non-atomic — two booting schedulers seeing the same stale lock can both
// overwrite, both succeed, and both think they own the lock. Writing to a
// per-pid temp path and then atomically renaming makes the takeover serialise
// at the rename, and re-reading after confirms self-ownership.
const overwriteLock = (path: string, info: LockInfo) =>
  Effect.tryPromise({
    try: async () => {
      const tmp = `${path}.tmp.${process.pid}`
      await writeFile(tmp, JSON.stringify(info))
      await rename(tmp, path)
      const raw = await readFile(path, "utf-8").catch(() => "")
      const round = parseLockInfo(raw)
      return round !== null && round.pid === process.pid && round.startedAt === PROC_STARTED_AT
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

    yield* Effect.tryPromise({
      try: () => ensureMimocodeGitignore(join(path, "..")),
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

    if (!isPidAlive(existing.pid, existing.startedAt)) {
      log.debug("previous owner dead or recycled; taking over", { deadPid: existing.pid })
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
