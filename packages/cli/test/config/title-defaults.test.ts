import { expect, test } from "bun:test"
import path from "node:path"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Config } from "../../src/config"
import { AppRuntime } from "../../src/effect/app-runtime"

// [TP-ST-R7-03, TP-ST-R7-06, TP-ST-R7-07] Test the real config assembly seam.
test("effective explicit lite and small_model beat the lowest-priority official default", async () => {
  const saved = process.env.MIMOCODE_CONFIG_DEFAULTS
  try {
    process.env.MIMOCODE_CONFIG_DEFAULTS = JSON.stringify({ model_groups: { lite: "xiaomi/mimo-flash" } })
    for (const [input, expected] of [
      [{}, "xiaomi/mimo-flash"],
      [{ small_model: "private/small" }, "private/small"],
      [{ small_model: "private/small", model_groups: { lite: "private/explicit" } }, "private/explicit"],
      [{ model_groups: { lite: "missing/unresolvable" } }, "missing/unresolvable"],
    ] as const) {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(input))
        },
      })
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const config = await AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))
          expect(config.model_groups?.lite).toBe(expected)
          if ("small_model" in input) expect(config.small_model).toBe(input.small_model)
        },
      })
    }
    delete process.env.MIMOCODE_CONFIG_DEFAULTS
    await using tmp = await tmpdir()
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        expect((await AppRuntime.runPromise(Config.Service.use((svc) => svc.get()))).model_groups?.lite).toBeUndefined()
      },
    })
  } finally {
    if (saved === undefined) delete process.env.MIMOCODE_CONFIG_DEFAULTS
    else process.env.MIMOCODE_CONFIG_DEFAULTS = saved
  }
})
