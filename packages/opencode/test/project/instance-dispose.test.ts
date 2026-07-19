import { afterEach, expect, test } from "bun:test"
import { registerDisposer } from "@/effect/instance-registry"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

test("targeted disposal is bounded and cannot evict a replacement", async () => {
  await using tmp = await tmpdir()
  let started!: () => void
  let finish!: () => void
  const disposing = new Promise<void>((resolve) => (started = resolve))
  const blocked = new Promise<void>((resolve) => (finish = resolve))
  const unregister = registerDisposer(async (directory) => {
    if (directory !== tmp.path) return
    started()
    await blocked
  })

  try {
    await Instance.provide({ directory: tmp.path, fn: () => undefined })
    const before = Date.now()
    const dispose = Instance.disposeDirectory(tmp.path)
    await disposing

    let initialized = 0
    const replacement = Instance.provide({
      directory: tmp.path,
      init: () => {
        initialized++
        return Promise.resolve()
      },
      fn: () => undefined,
    })

    await dispose
    expect(Date.now() - before).toBeLessThan(3_000)
    await replacement
    expect(initialized).toBe(1)

    finish()
    await Bun.sleep(10)
    await Instance.provide({
      directory: tmp.path,
      init: () => {
        initialized++
        return Promise.resolve()
      },
      fn: () => undefined,
    })
    expect(initialized).toBe(1)
  } finally {
    finish()
    unregister()
    await Instance.disposeDirectory(tmp.path)
  }
}, 5_000)
