import { afterEach, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { Global } from "../../src/global"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"

const log = Global.Path.log

afterEach(() => {
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

  await Log.init({ print: false, dev: false })

  const next = await files(tmp.path)

  expect(next).not.toContain(list[0]!)
  expect(next).toContain(list.at(-1)!)
})

test("logger truncates large fields and messages", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  await Log.init({ print: false, dev: false, level: "INFO" })
  const circular: Record<string, unknown> = { label: "root" }
  circular.self = circular
  const shared = { nested: "value" }

  Log.create({ service: "log-truncation-test" }).info("M".repeat(10_000), {
    payload: "x".repeat(10_000),
    circular,
    repeated: { first: shared, second: shared },
    bigint: 1n,
  })

  let content = ""
  for (let i = 0; i < 50; i++) {
    content = await fs.readFile(Log.file(), "utf8").catch(() => "")
    if (content.includes("truncated")) break
    await Bun.sleep(10)
  }

  expect(content.length).toBeLessThan(10_000)
  expect(content).toContain("...[truncated ")
  expect(content).toContain("[Circular]")
  expect(content).toContain('"second":{"nested":"value"}')
  expect(content).toContain("bigint=1")
  expect(content).not.toContain("M".repeat(8_000))
})
