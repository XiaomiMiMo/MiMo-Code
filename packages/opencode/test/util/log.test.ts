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

test("init cleanup prunes rotated dev.log archives", async () => {
  await using tmp = await tmpdir()
  Global.Path.log = tmp.path

  // dev.log rotations and size-rotation archives must also be pruned, not just
  // bare <iso>.log session logs.
  const list = Array.from({ length: 12 }, (_, i) => `dev.log.2000-01-${String(i + 1).padStart(2, "0")}T000000`)
  await Promise.all(list.map((file) => fs.writeFile(path.join(tmp.path, file), file)))

  await Log.init({ print: false, dev: false })

  for (let i = 0; i < 50; i++) {
    const current = await fs.readdir(tmp.path)
    const archives = current.filter((f) => f.startsWith("dev.log."))
    if (archives.length <= 10) break
    await Bun.sleep(10)
  }

  const final = await fs.readdir(tmp.path)
  const archives = final.filter((f) => f.startsWith("dev.log.")).sort()
  expect(archives.length).toBeLessThanOrEqual(10)
  expect(archives).not.toContain(list[0]!)
  expect(archives).toContain(list.at(-1)!)
})
