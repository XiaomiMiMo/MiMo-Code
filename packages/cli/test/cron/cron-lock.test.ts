import { test, expect } from "bun:test"
import { Effect } from "effect"
import { mkdtempSync, rmSync, existsSync, writeFileSync, mkdirSync, readFileSync } from "fs"
import { tmpdir } from "os"
import { join } from "path"
import { tryAcquireSchedulerLock, releaseSchedulerLock } from "@/cron/cron-lock"

const run = <A, E>(e: Effect.Effect<A, E>) => Effect.runPromise(e as Effect.Effect<A, E, never>)
const fresh = () => mkdtempSync(join(tmpdir(), "cron-lock-"))
const cleanup = (d: string) => rmSync(d, { recursive: true, force: true })

// Helper: reconstruct the actual start time (epoch ms) of a live pid on Linux.
// Uses the same math as cron-lock's PID-recycling check so the test can plant
// a lock with a startedAt that will be judged "consistent" (not recycled).
const reconstructPidStartMs = (pid: number): number => {
  const statRaw = readFileSync(`/proc/${pid}/stat`, "utf-8")
  const rest = statRaw.slice(statRaw.lastIndexOf(")") + 2).split(/\s+/)
  const otherJiffies = parseInt(rest[19] ?? "0", 10)
  const uptimeMs = Math.floor(parseFloat(readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0]!) * 1000)
  const bootTimeMs = Date.now() - uptimeMs
  const selfStatRaw = readFileSync(`/proc/${process.pid}/stat`, "utf-8")
  const selfRest = selfStatRaw.slice(selfStatRaw.lastIndexOf(")") + 2).split(/\s+/)
  const selfJiffies = parseInt(selfRest[19] ?? "0", 10)
  const procStartedAt = Date.now() - Math.floor(process.uptime() * 1000)
  const msPerJiffy = (procStartedAt - bootTimeMs) / Math.max(1, selfJiffies)
  return bootTimeMs + otherJiffies * msPerJiffy
}

test("acquire returns true on fresh dir and writes lock file", async () => {
  const dir = fresh()
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  expect(existsSync(join(dir, ".mimocode", ".cron-lock"))).toBe(true)
  cleanup(dir)
})

test("creates .gitignore alongside lock file in fresh directory", async () => {
  const dir = fresh()
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  const gitignore = join(dir, ".mimocode", ".gitignore")
  expect(existsSync(gitignore)).toBe(true)
  const content = readFileSync(gitignore, "utf-8")
  expect(content).toContain(".cron-lock")
  expect(content).toContain("scheduled_tasks.json")
  cleanup(dir)
})

test("acquire is idempotent for the same process", async () => {
  const dir = fresh()
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("acquire returns false when a different live pid owns the lock", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  // Plant a lock that names pid=1 with a startedAt matching its ACTUAL
  // reconstructed start time on this system. In containers pid=1 may not
  // be at system boot (it's the container entrypoint), so we can't hardcode
  // bootTimeMs — we compute the same value the recycle check would derive.
  // With the two values matching, the check says "not recycled" and the
  // lock holds → tryAcquire returns false.
  const initStartedAt =
    process.platform === "linux" ? Math.floor(reconstructPidStartMs(1)) : Date.now()
  writeFileSync(
    join(dir, ".mimocode", ".cron-lock"),
    JSON.stringify({ pid: 1, startedAt: initStartedAt }),
  )
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(false)
  cleanup(dir)
})

test("acquire takes over when previous owner is dead (ESRCH)", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", ".cron-lock"), JSON.stringify({ pid: 999_999, startedAt: 0 }))
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("acquire overwrites malformed lock file", async () => {
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  writeFileSync(join(dir, ".mimocode", ".cron-lock"), "garbage{not json")
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})

test("release removes our own lock", async () => {
  const dir = fresh()
  await run(tryAcquireSchedulerLock({ dir }))
  await run(releaseSchedulerLock({ dir }))
  expect(existsSync(join(dir, ".mimocode", ".cron-lock"))).toBe(false)
  cleanup(dir)
})

test("release no-ops if lock file is missing", async () => {
  const dir = fresh()
  await run(releaseSchedulerLock({ dir }))
  cleanup(dir)
})

test("acquire does NOT take over when kill(pid,0) throws EPERM (foreign-uid live owner)", async () => {
  // Regression for PR #1479 re-review round 2. isPidAlive used to wrap the
  // liveness check in Effect.try({try, catch}).pipe(orElseSucceed(false)) —
  // Effect.try's catch return value goes to the ERROR channel, not the
  // success channel, so `catch: () => true` on EPERM produced Effect<never,
  // true> which orElseSucceed then replaced with false. Net: any scheduler
  // running under a different uid than the lock's real owner would judge
  // the owner dead and take over → two owners double-firing every task.
  //
  // Simulate the non-root case by mocking process.kill to throw EPERM for
  // the tested pid. The lock's startedAt is planted to match the real init
  // start time so the recycle check won't fire — the ONLY decision path
  // exercised is the EPERM handling.
  if (process.platform !== "linux") return
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  const initStartedAt = Math.floor(reconstructPidStartMs(1))
  writeFileSync(
    join(dir, ".mimocode", ".cron-lock"),
    JSON.stringify({ pid: 1, startedAt: initStartedAt }),
  )
  const origKill = process.kill
  process.kill = ((pid: number, sig?: string | number) => {
    if (pid === 1 && sig === 0) {
      const err = new Error("EPERM") as NodeJS.ErrnoException
      err.code = "EPERM"
      throw err
    }
    return origKill.call(process, pid, sig as string | number)
  }) as typeof process.kill
  try {
    expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(false)
  } finally {
    process.kill = origKill
  }
  cleanup(dir)
})

// Regression for PR #1479 finding #7 (re-review round). The earlier fix wrote
// arithmetic that never triggered — msPerJiffy was computed from unrelated
// quantities (self-uptime ms / boot-relative jiffies), producing an
// astronomical `expectedJiffies` that no real PID could ever exceed. The
// re-worked implementation reads /proc/uptime to pin the boot moment,
// derives msPerJiffy from PROC_STARTED_AT ↔ selfJiffies, and reconstructs
// the LIVE pid's actual start time in epoch ms so the comparison is unit-
// consistent. This test exercises the path that used to be dead code:
// a lock naming our OWN pid but claiming an ancient startedAt must be
// treated as recycled (our real start time is much later than the claim).
test("acquire treats a lock as recycled when the live pid started much later than claimed", async () => {
  if (process.platform !== "linux") return // /proc/*/stat + /proc/uptime only on Linux
  const dir = fresh()
  mkdirSync(join(dir, ".mimocode"), { recursive: true })
  // Compute boot time from /proc/uptime and plant a lock claiming OUR pid
  // as owner but with startedAt = bootTimeMs. Our process really started
  // well after boot, so the reconstruction check should decide "recycled"
  // and take over. The acquire path also has a self-idempotency shortcut
  // that returns true if pid AND startedAt both match our process — planting
  // startedAt = bootTimeMs (not our real PROC_STARTED_AT) sidesteps that.
  const uptimeMs = Math.floor(parseFloat(readFileSync("/proc/uptime", "utf-8").split(/\s+/)[0]!) * 1000)
  const bootTimeMs = Date.now() - uptimeMs
  writeFileSync(
    join(dir, ".mimocode", ".cron-lock"),
    JSON.stringify({ pid: process.pid, startedAt: bootTimeMs }),
  )
  expect(await run(tryAcquireSchedulerLock({ dir }))).toBe(true)
  cleanup(dir)
})
