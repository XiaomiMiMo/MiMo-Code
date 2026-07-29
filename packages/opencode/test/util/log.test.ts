import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Log } from "../../src/util"
import { MIMOCODE_PROCESS_ROLE } from "../../src/util/mimo-process"
import { tmpdir } from "../fixture/fixture"

const log = Global.Path.log
const role = process.env[MIMOCODE_PROCESS_ROLE]
const mb = 1024 * 1024

afterEach(async () => {
  await Log.shutdown()
  Global.Path.log = log
  if (role === undefined) delete process.env[MIMOCODE_PROCESS_ROLE]
  else process.env[MIMOCODE_PROCESS_ROLE] = role
})

test("reinitialization gives each logger context a unique active file", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env[MIMOCODE_PROCESS_ROLE] = "main"

  await Log.init({ print: false, dev: true })
  const main = Log.file()
  Log.Default.info("from main")

  process.env[MIMOCODE_PROCESS_ROLE] = "worker"
  await Log.init({ print: false, dev: true })
  const worker = Log.file()

  expect(main).not.toBe(worker)
  expect(path.basename(main)).toContain(`-main-${process.pid}-`)
  expect(path.basename(worker)).toContain(`-worker-${process.pid}-`)
  expect(main.endsWith(".active.log")).toBe(true)
  expect(worker.endsWith(".active.log")).toBe(true)
  expect(await fs.readFile(main.replace(/\.active\.log$/, ".log"), "utf8")).toContain("from main")
})

test("concurrent initialization serializes ownership without leaking active files", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  await Promise.all([Log.init({ print: false }), Log.init({ print: false })])

  const files = await fs.readdir(tmp.path)
  expect(files.filter((file) => file.endsWith(".active.log"))).toHaveLength(1)
  expect(files.filter((file) => !file.endsWith(".active.log"))).toHaveLength(1)
})

test("cleanup preserves another live context and keeps the newest ten archives", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env[MIMOCODE_PROCESS_ROLE] = "worker"
  const active = `1999-01-01T000000-main-${process.pid}-deadbeef.active.log`
  const archives = Array.from(
    { length: 12 },
    (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000-main-123-${String(i).padStart(8, "0")}.log`,
  )

  await fs.writeFile(path.join(tmp.path, active), "active")
  await Promise.all(
    archives.map(async (file, i) => {
      const target = path.join(tmp.path, file)
      await fs.writeFile(target, file)
      await fs.utimes(target, i + 1, i + 1)
    }),
  )
  await Log.init({ print: false })

  const files = await fs.readdir(tmp.path)
  expect(files).toContain(active)
  expect(files).not.toContain(archives[0])
  expect(files).not.toContain(archives[1])
  expect(files).toContain(archives.at(-1)!)
  expect(files.filter((file) => !file.endsWith(".active.log"))).toHaveLength(10)
})

test("cleanup recovers an active file left by an exited process", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  const child = Bun.spawn([process.execPath, "-e", ""])
  await child.exited
  const active = `2000-01-01T000000-worker-${child.pid}-deadbeef.active.log`
  await fs.writeFile(path.join(tmp.path, active), "orphaned")

  await Log.init({ print: false })

  expect(
    await fs.stat(path.join(tmp.path, active)).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
  expect(await fs.readFile(path.join(tmp.path, active.replace(/\.active\.log$/, ".log")), "utf8")).toBe("orphaned")
})

test("worker initialization recovers a stale same-process worker file", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env[MIMOCODE_PROCESS_ROLE] = "worker"
  const active = `2000-01-01T000000-worker-${process.pid}-deadbeef.active.log`
  await fs.writeFile(path.join(tmp.path, active), "orphaned worker")

  await Log.init({ print: false })

  const files = await fs.readdir(tmp.path)
  expect(files).not.toContain(active)
  expect(files).toContain(active.replace(/\.active\.log$/, ".log"))
  expect(files.filter((file) => file.endsWith(".active.log"))).toHaveLength(1)
})

test("cleanup enforces the archived total-size budget", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  const archives = Array.from(
    { length: 4 },
    (_, i) => `2000-01-0${i + 1}T000000-main-123-${String(i).padStart(8, "0")}.log`,
  )

  await Promise.all(
    archives.map(async (file) => {
      const target = path.join(tmp.path, file)
      await fs.writeFile(target, "")
      await fs.truncate(target, 80 * mb)
    }),
  )
  await Log.init({ print: false })

  const files = (await fs.readdir(tmp.path)).filter((file) => !file.endsWith(".active.log"))
  const sizes = await Promise.all(files.map((file) => fs.stat(path.join(tmp.path, file)).then((stat) => stat.size)))
  expect(sizes.reduce((sum, size) => sum + size, 0)).toBeLessThanOrEqual(200 * mb)
})

test("queued writes are ordered and flush waits for persistence", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false, level: "INFO" })

  Array.from({ length: 1_000 }, (_, i) => i).forEach((i) => Log.Default.info(`entry-${i}`))
  await Log.flush()

  const lines = (await fs.readFile(Log.file(), "utf8")).trim().split("\n")
  expect(lines).toHaveLength(1_000)
  expect(lines[0]?.endsWith("entry-0")).toBe(true)
  expect(lines.at(-1)?.endsWith("entry-999")).toBe(true)
})

test("rotation serializes writes before the active file exceeds 50 MiB", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false, rotate: true })
  const chunk = "x".repeat(256 * 1024)

  Array.from({ length: 201 }).forEach(() => Log.Default.info(chunk))
  await Log.flush()

  const files = await fs.readdir(tmp.path)
  const sizes = await Promise.all(files.map((file) => fs.stat(path.join(tmp.path, file)).then((stat) => stat.size)))
  expect(files.some((file) => !file.endsWith(".active.log"))).toBe(true)
  expect(sizes.every((size) => size <= 50 * mb)).toBe(true)
})

test("shutdown closes the final stream when queued writes rotate", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false, rotate: true })
  const chunk = "x".repeat(256 * 1024)

  Array.from({ length: 201 }).forEach(() => Log.Default.info(chunk))
  await Log.shutdown()

  const files = await fs.readdir(tmp.path)
  expect(files.some((file) => file.endsWith(".active.log"))).toBe(false)
  expect(files.some((file) => file.includes(".log."))).toBe(true)
  expect(Log.file().endsWith(".log")).toBe(true)
})

test("rotation can still be disabled explicitly", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false, rotate: false })
  const chunk = "x".repeat(256 * 1024)

  Array.from({ length: 201 }).forEach(() => Log.Default.info(chunk))
  await Log.flush()

  expect(await fs.stat(Log.file()).then((stat) => stat.size)).toBeGreaterThan(50 * mb)
  expect(await fs.readdir(tmp.path)).toHaveLength(1)
})

test("write failures do not escape as process-level errors", async () => {
  await using tmp = await tmpdir()
  const failures: unknown[] = []
  const capture = (error: unknown) => failures.push(error)
  Global.Path.log = path.join(tmp.path, "not-a-directory")
  await fs.writeFile(Global.Path.log, "file")
  process.on("unhandledRejection", capture)
  process.on("uncaughtException", capture)

  try {
    await Log.init({ print: false })
    Log.Default.info("cannot be written")
    await Log.flush()
    await Bun.sleep(10)
    expect(failures).toHaveLength(0)
  } finally {
    process.off("unhandledRejection", capture)
    process.off("uncaughtException", capture)
  }
})

test("shutdown flushes and marks the active file completed", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false })
  const active = Log.file()
  Log.Default.info("last message")

  await Log.shutdown()

  expect(Log.file()).toBe(active.replace(/\.active\.log$/, ".log"))
  expect(await fs.readFile(Log.file(), "utf8")).toContain("last message")
  expect(
    await fs.stat(active).then(
      () => true,
      () => false,
    ),
  ).toBe(false)
})

test("flush persists records without closing the file sink", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  await Log.init({ print: false })
  const active = Log.file()
  Log.Default.info("before flush")

  await Log.flush()
  expect(await fs.readFile(active, "utf8")).toContain("before flush")

  Log.Default.info("during teardown")
  await Log.shutdown()

  expect(await fs.readFile(Log.file(), "utf8")).toContain("during teardown")
})

// The TUI renders on the same terminal the process writes stderr to, so a log
// record must never reach stderr unless the user asked for printed logs. A
// child process keeps the module-level sink state honest.
async function isolate(body: string, dir: string) {
  const src = path.join(import.meta.dir, "..", "..", "src")
  const child = Bun.spawn(
    [
      process.execPath,
      "-e",
      [
        `const { Global } = await import(${JSON.stringify(path.join(src, "global", "index.ts"))})`,
        `const Log = await import(${JSON.stringify(path.join(src, "util", "log.ts"))})`,
        `Global.Path.log = ${JSON.stringify(dir)}`,
        body,
      ].join("\n"),
    ],
    { stdout: "pipe", stderr: "pipe", env: { ...process.env, [MIMOCODE_PROCESS_ROLE]: "worker" } },
  )
  const [stdout, stderr] = await Promise.all([new Response(child.stdout).text(), new Response(child.stderr).text()])
  expect(await child.exited).toBe(0)
  return { stdout, stderr }
}

test("records written after shutdown never reach stderr", async () => {
  await using tmp = await tmpdir()

  const result = await isolate(
    [
      `await Log.init({ print: false })`,
      `Log.Default.info("before shutdown")`,
      `await Log.shutdown()`,
      `Log.Default.info("teardown after shutdown")`,
      `await Log.flush()`,
    ].join("\n"),
    tmp.path,
  )

  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
  const files = await fs.readdir(tmp.path)
  expect(files).toHaveLength(1)
  const contents = await fs.readFile(path.join(tmp.path, files[0]), "utf8")
  expect(contents).toContain("before shutdown")
  expect(contents).not.toContain("teardown after shutdown")
})

test("records written before initialization never reach stderr", async () => {
  await using tmp = await tmpdir()

  const result = await isolate([`Log.Default.info("before init")`, `await Log.flush()`].join("\n"), tmp.path)

  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
})

test("print mode keeps writing records to stderr", async () => {
  await using tmp = await tmpdir()

  const result = await isolate(
    [`await Log.init({ print: true })`, `Log.Default.info("printed record")`, `await Log.flush()`].join("\n"),
    tmp.path,
  )

  expect(result.stderr).toContain("printed record")
  expect(await fs.readdir(tmp.path)).toHaveLength(0)
})

test("an unusable log directory reports nothing to stderr", async () => {
  await using tmp = await tmpdir()
  const blocked = path.join(tmp.path, "not-a-directory")
  await fs.writeFile(blocked, "file")

  const result = await isolate(
    [`await Log.init({ print: false })`, `Log.Default.info("cannot be written")`, `await Log.flush()`].join("\n"),
    blocked,
  )

  expect(result.stderr).toBe("")
  expect(result.stdout).toBe("")
})

test("print mode is unaffected by an unusable log directory", async () => {
  await using tmp = await tmpdir()
  const blocked = path.join(tmp.path, "not-a-directory")
  await fs.writeFile(blocked, "file")

  const result = await isolate(
    [`await Log.init({ print: true })`, `Log.Default.info("printed record")`, `await Log.flush()`].join("\n"),
    blocked,
  )

  expect(result.stderr).toContain("printed record")
  expect(result.stderr).not.toContain("failed")
})
