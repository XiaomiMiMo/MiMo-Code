import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Permission } from "../../src/permission"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

const log = Global.Path.log

afterEach(async () => {
  delete process.env.MIMOCODE_LOG_MAX_BYTES
  await Log.init({ print: true })
  Global.Path.log = log
})

async function files(dir: string) {
  let last = ""
  let same = 0

  for (let i = 0; i < 50; i++) {
    const list = (await fs.readdir(dir)).sort()
    const next = JSON.stringify(list)
    same = next === last ? same + 1 : 0
    if (same >= 2 && list.length === 11) return list
    last = next
    await Bun.sleep(10)
  }

  return (await fs.readdir(dir)).sort()
}

test("init cleanup keeps the newest timestamped logs", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  const list = Array.from({ length: 12 }, (_, i) => `2000-01-${String(i + 1).padStart(2, "0")}T000000.log`)

  await Promise.all(list.map((file) => fs.writeFile(path.join(tmp.path, file), file)))

  try {
    await Log.init({ print: false, dev: false })

    const next = await files(tmp.path)

    expect(next).not.toContain(list[0]!)
    expect(next).toContain(list.at(-1)!)
  } finally {
    await Log.init({ print: true })
  }
})

test("init cleanup removes oversized managed log files", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env.MIMOCODE_LOG_MAX_BYTES = "1024"

  await fs.writeFile(path.join(tmp.path, "2000-01-01T000000.log"), "x".repeat(1025))
  await fs.writeFile(path.join(tmp.path, "dev.log.2000-01-01T000000"), "x".repeat(1025))
  await fs.writeFile(path.join(tmp.path, "keep.txt"), "x".repeat(1025))

  try {
    await Log.init({ print: false, dev: false })

    const next = await fs.readdir(tmp.path)

    expect(next).not.toContain("2000-01-01T000000.log")
    expect(next).not.toContain("dev.log.2000-01-01T000000")
    expect(next).toContain("keep.txt")
  } finally {
    await Log.init({ print: true })
  }
})

test("write caps the active log file size", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env.MIMOCODE_LOG_MAX_BYTES = "1024"

  try {
    await Log.init({ print: false, dev: false })

    Log.create({ service: `cap-${Date.now()}` }).info("x".repeat(2048))

    let size = 0
    for (let i = 0; i < 50; i++) {
      size = (await fs.stat(Log.file()).catch(() => ({ size: 0 }))).size
      if (size > 0) break
      await Bun.sleep(10)
    }

    expect(size).toBeLessThanOrEqual(1024)
    expect(await Bun.file(Log.file()).text()).toContain("truncated")
  } finally {
    await Log.init({ print: true })
  }
})

test("write rechecks active log file size before appending", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path
  process.env.MIMOCODE_LOG_MAX_BYTES = "1024"

  try {
    await Log.init({ print: false, dev: false })
    await fs.writeFile(Log.file(), "x".repeat(1020))

    Log.create({ service: `restat-${Date.now()}` }).info("y".repeat(100))

    let text = ""
    for (let i = 0; i < 50; i++) {
      text = await Bun.file(Log.file()).text()
      if (text.includes("truncated")) break
      await Bun.sleep(10)
    }

    expect(Buffer.byteLength(text)).toBeLessThanOrEqual(1024)
    expect(text).toContain("truncated")
  } finally {
    await Log.init({ print: true })
  }
})

test("permission evaluation does not write full rulesets at info level", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  try {
    await Log.init({ print: false, dev: false })

    const marker = `secret-permission-pattern-${"x".repeat(512)}`
    Permission.evaluate(
      "bash",
      "echo ok",
      Array.from({ length: 20 }, (_, index) => ({
        permission: "bash",
        pattern: `${marker}-${index}`,
        action: "ask" as const,
      })),
    )

    const file = Log.file()
    await Log.init({ print: true })
    const text = await Bun.file(file).text()

    expect(text).not.toContain(marker)
  } finally {
    await Log.init({ print: true })
  }
})
