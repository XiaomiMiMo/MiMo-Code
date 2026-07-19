import { afterAll, afterEach, describe, expect, test } from "bun:test"
import { Effect } from "effect"
import fs from "fs"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const disableDefault = process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = "1"

const { Plugin } = await import("../../src/plugin/index")
const { Instance } = await import("../../src/project/instance")

afterEach(async () => {
  await Instance.disposeAll()
})

afterAll(() => {
  if (disableDefault === undefined) {
    delete process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS
    return
  }
  process.env.MIMOCODE_DISABLE_DEFAULT_PLUGINS = disableDefault
})

function hookSource(marker: string) {
  return [
    "export default {",
    '  "experimental.chat.system.transform": async (_input, output) => {',
    `    output.system.push(${JSON.stringify(marker)})`,
    "  },",
    "}",
    "",
  ].join("\n")
}

const triggerTransform = () =>
  Effect.gen(function* () {
    const plugin = yield* Plugin.Service
    const out = { system: [] as string[] }
    yield* plugin.trigger(
      "experimental.chat.system.transform",
      { model: { providerID: "anthropic", modelID: "claude-sonnet-4-6" } as any },
      out,
    )
    return out
  })

describe("plugin file hooks", () => {
  test("loads hooks from .mimocode/hooks and picks up external edits without reload call", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await Bun.write(path.join(dir, ".mimocode", "hooks", "greet.ts"), hookSource("v1"))
        await Bun.write(path.join(dir, "mimocode.json"), '{}')
      },
    })
    const hookFile = path.join(tmp.path, ".mimocode", "hooks", "greet.ts")

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const first = yield* triggerTransform()
          expect(first.system).toEqual(["v1"])

          // Simulate an EXTERNAL edit (no write/edit tool, no reloadFileHooks):
          // bump content and force a distinct mtime past the staleness throttle.
          fs.writeFileSync(hookFile, hookSource("v2"))
          const future = new Date(Date.now() + 5000)
          fs.utimesSync(hookFile, future, future)
          yield* Effect.promise(() => Bun.sleep(1200))

          return yield* triggerTransform()
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(out.system).toEqual(["v2"])
  })

  test("detects newly added hook files", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        await fs.promises.mkdir(path.join(dir, ".mimocode", "hooks"), { recursive: true })
        await Bun.write(path.join(dir, "mimocode.json"), '{}')
      },
    })

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const first = yield* triggerTransform()
          expect(first.system).toEqual([])

          fs.writeFileSync(path.join(tmp.path, ".mimocode", "hooks", "late.ts"), hookSource("late"))
          yield* Effect.promise(() => Bun.sleep(1200))

          return yield* triggerTransform()
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })

    expect(out.system).toEqual(["late"])
  })

  test("dispatches bus events to file hook event handlers", async () => {
    const { AppRuntime } = await import("../../src/effect/app-runtime")
    const { Bus } = await import("../../src/bus")
    const { Session } = await import("../../src/session")

    await using tmp = await tmpdir({
      init: async (dir) => {
        const sink = path.join(dir, "events.log")
        await Bun.write(path.join(dir, "mimocode.json"), '{}')
        await Bun.write(
          path.join(dir, ".mimocode", "hooks", "listener.ts"),
          [
            "import fs from 'fs'",
            "export default {",
            "  event: async ({ event }) => {",
            `    fs.appendFileSync(${JSON.stringify(sink)}, event.type + "\\n")`,
            "  },",
            "}",
            "",
          ].join("\n"),
        )
      },
    })
    const sink = path.join(tmp.path, "events.log")

    await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        AppRuntime.runPromise(
          Effect.gen(function* () {
            // Force file hook state (and its bus subscription) to initialize.
            const plugin = yield* Plugin.Service
            yield* plugin.init()
            // Give the forked subscription fiber time to register on the bus.
            yield* Effect.promise(() => Bun.sleep(100))

            const bus = yield* Bus.Service
            yield* bus.publish(Session.Event.Error, {
              error: { name: "UnknownError", data: { message: "probe" } } as any,
            })
            yield* Effect.promise(() => Bun.sleep(600))
          }),
        ),
    })

    const logged = fs.existsSync(sink) ? fs.readFileSync(sink, "utf8") : ""
    expect(logged).toContain("session.error")
  })
})
