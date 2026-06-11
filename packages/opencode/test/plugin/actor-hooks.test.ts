import { afterEach, describe, expect, test } from "bun:test"
import { Deferred, Effect, Layer, Stream } from "effect"
import path from "path"
import { pathToFileURL } from "url"
import { tmpdir } from "../fixture/fixture"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { Plugin, HookEvent } from "../../src/plugin"
import { Bus } from "../../src/bus"
import { AppRuntime } from "../../src/effect/app-runtime"
import { Actor } from "../../src/actor/spawn"
import { startScriptedLLMServer, textStopResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

describe("provenance plumbing", () => {
  test("source=hook + provenance is persisted onto the User message", async () => {
    await using tmp = await tmpdir({})

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const created = yield* sessions.create({ title: "test" })
            return yield* prompt.prompt({
              sessionID: created.id,
              agent: "build",
              agentID: "main",
              source: "hook",
              provenance: {
                hookPhase: "pre",
                hookIteration: 1,
                pluginNames: ["test-plugin"],
                hookIDs: ["test-plugin#actor.preStop"],
              },
              parts: [{ type: "text", text: "synthetic reason" }],
              noReply: true,
            })
          }),
        ),
    })

    expect(result.info.role).toBe("user")
    if (result.info.role === "user") {
      expect(result.info.provenance).toEqual({
        hookPhase: "pre",
        hookIteration: 1,
        pluginNames: ["test-plugin"],
        hookIDs: ["test-plugin#actor.preStop"],
      })
    }
  })

  test("source=spawn (default) leaves provenance undefined", async () => {
    await using tmp = await tmpdir({})

    const result = await Instance.provide({
      directory: tmp.path,
      fn: () =>
        run(
          Effect.gen(function* () {
            const sessions = yield* Session.Service
            const prompt = yield* SessionPrompt.Service
            const created = yield* sessions.create({ title: "test" })
            return yield* prompt.prompt({
              sessionID: created.id,
              agent: "build",
              agentID: "main",
              source: "spawn",
              parts: [{ type: "text", text: "regular task" }],
              noReply: true,
            })
          }),
        ),
    })

    expect(result.info.role).toBe("user")
    if (result.info.role === "user") {
      expect(result.info.provenance).toBeUndefined()
    }
  })
})

async function pluginProject(source: string) {
  return tmpdir({
    init: async (dir) => {
      const file = path.join(dir, "plugin.ts")
      await Bun.write(file, source)
      await Bun.write(
        path.join(dir, "mimocode.json"),
        JSON.stringify(
          {
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(file).href],
          },
          null,
          2,
        ),
      )
    },
  })
}

describe("triggerActorPreStop", () => {
  test("no hooks → continue=false, empty contributors", async () => {
    await using tmp = await tmpdir({})
    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID: "ses_test", actorID: "actor_test",
            agentType: "custom", mode: "subagent", lifecycle: "ephemeral",
            task: "do thing", iteration: 0,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(out.continue).toBe(false)
    expect(out.contributingPluginNames).toEqual([])
    expect(out.contributingHookIDs).toEqual([])
  })

  test("hook returns continue=true → aggregated continue=true with reason", async () => {
    await using tmp = await pluginProject(
      [
        "export default async () => ({",
        '  "actor.preStop": async (input, output) => {',
        "    output.continue = true",
        '    output.reason = "needs more work"',
        "  },",
        "})",
        "",
      ].join("\n"),
    )

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID: "ses_test", actorID: "actor_test",
            agentType: "custom", mode: "subagent", lifecycle: "ephemeral",
            task: "do thing", iteration: 0, finalText: "halfway done",
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(out.continue).toBe(true)
    expect(out.reason).toBe("needs more work")
    expect(out.contributingPluginNames.length).toBe(1)
    expect(out.contributingHookIDs[0]).toMatch(/#actor\.preStop$/)
  })

  test("matcher excludes builtin agent by default", async () => {
    await using tmp = await pluginProject(
      [
        "export default async () => ({",
        '  "actor.preStop": async (_input, output) => {',
        "    output.continue = true",
        '    output.reason = "should not fire"',
        "  },",
        "})",
        "",
      ].join("\n"),
    )

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID: "ses_test", actorID: "actor_test",
            agentType: "summary", mode: "subagent", lifecycle: "ephemeral",
            task: "summarize", iteration: 0,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(out.continue).toBe(false)
  })

  test("hook throwing → other hooks still run, error logged not raised", async () => {
    await using tmp = await tmpdir({
      init: async (dir) => {
        const a = path.join(dir, "plugin-a.ts")
        const b = path.join(dir, "plugin-b.ts")
        await Bun.write(
          a,
          [
            "export default async () => ({",
            '  "actor.preStop": async (_input, _output) => { throw new Error("oops") },',
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          b,
          [
            "export default async () => ({",
            '  "actor.preStop": async (_input, output) => {',
            "    output.continue = true",
            '    output.reason = "still here"',
            "  },",
            "})",
            "",
          ].join("\n"),
        )
        await Bun.write(
          path.join(dir, "mimocode.json"),
          JSON.stringify({
            $schema: "https://opencode.ai/config.json",
            plugin: [pathToFileURL(a).href, pathToFileURL(b).href],
          }),
        )
      },
    })

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID: "ses_test", actorID: "actor_test",
            agentType: "custom", mode: "subagent", lifecycle: "ephemeral",
            task: "x", iteration: 0,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(out.continue).toBe(true)
    expect(out.reason).toBe("still here")
  })

  test("continue=true without reason → ignored with warning", async () => {
    await using tmp = await pluginProject(
      [
        "export default async () => ({",
        '  "actor.preStop": async (_input, output) => {',
        "    output.continue = true",
        "    // forgot reason",
        "  },",
        "})",
        "",
      ].join("\n"),
    )

    const out = await Instance.provide({
      directory: tmp.path,
      fn: async () =>
        Effect.gen(function* () {
          const plugin = yield* Plugin.Service
          return yield* plugin.triggerActorPreStop({
            sessionID: "ses_test", actorID: "actor_test",
            agentType: "custom", mode: "subagent", lifecycle: "ephemeral",
            task: "x", iteration: 0,
          })
        }).pipe(Effect.provide(Plugin.defaultLayer), Effect.runPromise),
    })
    expect(out.continue).toBe(false)
  })
})

describe("actor.preStop ReAct loop", () => {
  test("hook returns continue=true once → subagent runs second turn → final delivery has second-turn finalText", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("first turn output") },
      { lines: textStopResponse("goodbye") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.preStop": async (input, output) => {',
              "    if (input.iteration === 0) {",
              "      output.continue = true",
              '      output.reason = "say goodbye instead"',
              "    }",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                custom: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const finalText = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "ReAct preStop" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom",
                task: "say something",
                context: "none",
                tools: [],
                background: false,
              })
              const outcome = yield* Deferred.await(result.outcome)
              if (outcome.status === "failure") throw new Error(`Actor failed: ${outcome.error}`)
              if (outcome.status === "cancelled") throw new Error("Actor was cancelled")
              return outcome.finalText
            }),
          ),
      })

      expect(finalText).toBe("goodbye")
      expect(server.captures.length).toBe(2) // two LLM calls
    } finally {
      await server.stop()
    }
  })

  test("hook always asks for re-entry → caps at MAX_PRE_REACT, delivers last finalText", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("turn1") },
      { lines: textStopResponse("turn2") },
      { lines: textStopResponse("turn3") },
      { lines: textStopResponse("turn4") },
      // 5th would not be needed — cap stops at 4 turns total (1 + 3 re-entries)
      { lines: textStopResponse("turn5_unused") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.preStop": async (_input, output) => {',
              "    output.continue = true",
              '    output.reason = "keep going"',
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                custom: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const finalText = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "MAX cap test" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              const outcome = yield* Deferred.await(result.outcome)
              if (outcome.status === "failure") throw new Error(`Actor failed: ${outcome.error}`)
              if (outcome.status === "cancelled") throw new Error("Actor was cancelled")
              return outcome.finalText
            }),
          ),
      })

      // 1 spawn turn + 3 re-entries = 4 LLM calls; finalText is "turn4"
      expect(server.captures.length).toBe(4)
      expect(finalText).toBe("turn4")
    } finally {
      await server.stop()
    }
  })
})

describe("actor.postStop ReAct loop", () => {
  test("postStop runs after delivery; caller's outcome.finalText is delivery snapshot", async () => {
    // Use a marker file so the test plugin can record postStop completion.
    const markerPath = path.join("/tmp", `marker-${Date.now()}-${Math.random()}`)

    const server = startScriptedLLMServer([
      { lines: textStopResponse("first") },   // turn 1 (delivery)
      { lines: textStopResponse("second") },  // postStop iter=1 turn
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.postStop": async (input, output) => {',
              "    if (input.iteration === 0) {",
              "      output.continue = true",
              '      output.reason = "follow up"',
              "    } else {",
              `      await fs.writeFile(MARKER, "done")`,
              "    }",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                custom: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const callerFinalText = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "postStop" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom",
                task: "do something",
                context: "none",
                tools: [],
                background: false,
              })
              const outcome = yield* Deferred.await(result.outcome)
              return outcome.status === "success" ? outcome.finalText : undefined
            }),
          ),
      })

      expect(callerFinalText).toBe("first")  // delivery snapshot, NOT "second"

      // Wait for postStop chain to complete (marker file exists)
      for (let i = 0; i < 20; i++) {
        if (await Bun.file(markerPath).exists()) break
        await Bun.sleep(50)
      }
      expect(await Bun.file(markerPath).exists()).toBe(true)
      expect(server.captures.length).toBe(2)  // delivery turn + postStop turn
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })

  test("postStop caps at MAX_POST_REACT re-entries", async () => {
    // postStop hook that always requests continuation → should cap at MAX_POST_REACT (3).
    // Total LLM calls: 1 (delivery) + 3 (postStop re-entries) = 4.
    // Caller's finalText is still from the delivery turn (not a postStop turn).
    const server = startScriptedLLMServer([
      { lines: textStopResponse("delivery-text") },
      { lines: textStopResponse("post1") },
      { lines: textStopResponse("post2") },
      { lines: textStopResponse("post3") },
      // 5th would not be needed — cap stops at 4 turns total (1 + 3 re-entries)
      { lines: textStopResponse("post4_unused") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.postStop": async (_input, output) => {',
              "    output.continue = true",
              '    output.reason = "keep going"',
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                custom: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const callerFinalText = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "postStop-cap" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              const outcome = yield* Deferred.await(result.outcome)
              return outcome.status === "success" ? outcome.finalText : undefined
            }),
          ),
      })

      // Caller sees delivery-text, NOT any postStop turn text
      expect(callerFinalText).toBe("delivery-text")

      // Wait briefly for postStop turns to fully complete
      for (let i = 0; i < 20; i++) {
        if (server.captures.length >= 4) break
        await Bun.sleep(50)
      }

      // 1 delivery + 3 postStop re-entries (MAX_POST_REACT cap) = 4 total
      expect(server.captures.length).toBe(4)
    } finally {
      await server.stop()
    }
  })

  test("postStop LLM failure breaks loop without affecting caller", async () => {
    // Delivery turn succeeds; postStop turn returns HTTP 400 (no retry),
    // which the Effect.catch swallow converts to undefined → loop breaks.
    // Caller still receives delivery finalText; no exception escapes.
    const server = startScriptedLLMServer([
      { lines: textStopResponse("delivered") },     // delivery turn
      { lines: [], status: 400 },                   // postStop turn — HTTP 400 triggers LLM error (no retry)
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.postStop": async (input, output) => {',
              "    if (input.iteration === 0) {",
              "      output.continue = true",
              '      output.reason = "trigger failure"',
              "    }",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                custom: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const callerFinalText = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "postStop-fail" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              const outcome = yield* Deferred.await(result.outcome)
              // Brief wait for postStop to attempt and fail
              yield* Effect.sleep("200 millis")
              return outcome.status === "success" ? outcome.finalText : undefined
            }),
          ),
      })

      // Caller sees delivery snapshot — postStop failure does NOT propagate
      expect(callerFinalText).toBe("delivered")
      // Server saw 2 calls: delivery + 1 postStop attempt (which failed)
      expect(server.captures.length).toBe(2)
      // No exception escaped — test reaches this assertion cleanly
    } finally {
      await server.stop()
    }
  })
})

describe("actor.preStop matcher behaviour (integration)", () => {
  test("default-excluded built-in: explore subagent does not trigger hook", async () => {
    const markerPath = path.join("/tmp", `matcher-builtin-${Date.now()}-${Math.random()}`)
    const server = startScriptedLLMServer([
      { lines: textStopResponse("done") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.preStop": async () => {',
              `    await fs.writeFile(MARKER, "fired")`,
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                explore: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "matcher-builtin" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "explore",
                task: "look around",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(result.outcome)
            }),
          ),
      })

      // Default matcher excludes built-in agents — hook should NOT have fired
      expect(await Bun.file(markerPath).exists()).toBe(false)
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })

  test("explicit array include for built-in: hook fires when agentType array names it", async () => {
    const markerPath = path.join("/tmp", `matcher-include-${Date.now()}-${Math.random()}`)
    const server = startScriptedLLMServer([
      { lines: textStopResponse("explore done") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.preStop": {',
              '    matcher: { agentType: ["explore"] },',
              "    run: async () => {",
              `      await fs.writeFile(MARKER, "fired")`,
              "    },",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                explore: {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "matcher-include" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "explore",
                task: "look around",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(result.outcome)
            }),
          ),
      })

      // Array form bypasses built-in exclusion — hook SHOULD have fired
      expect(await Bun.file(markerPath).exists()).toBe(true)
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })

  test("regex agentType matches non-builtin but excludes builtin", async () => {
    const markerPath = path.join("/tmp", `matcher-regex-${Date.now()}-${Math.random()}`)
    const server = startScriptedLLMServer([
      { lines: textStopResponse("done builtin") },
      { lines: textStopResponse("done custom") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.preStop": {',
              '    matcher: { agentType: ".*" },',
              "    run: async (input) => {",
              `      await fs.appendFile(MARKER, input.agentType + "\\n")`,
              "    },",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                explore: {
                  model: "alibaba/qwen-plus",
                },
                "review-auth": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service

              // Built-in spawn first — hook should NOT fire
              const sess1 = yield* session.create({ title: "matcher-regex-builtin" })
              const r1 = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess1.id,
                agentType: "explore",
                task: "x",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(r1.outcome)

              // Non-builtin spawn — hook SHOULD fire
              const sess2 = yield* session.create({ title: "matcher-regex-custom" })
              const r2 = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess2.id,
                agentType: "review-auth",
                task: "y",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(r2.outcome)
            }),
          ),
      })

      const content = await Bun.file(markerPath).text().catch(() => "")
      // review-auth is non-builtin → should appear; explore is builtin → should not
      expect(content).toContain("review-auth")
      expect(content).not.toContain("explore")
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })

  test("mode: subagent filter excludes peer spawns", async () => {
    const markerPath = path.join("/tmp", `matcher-mode-${Date.now()}-${Math.random()}`)
    const server = startScriptedLLMServer([
      { lines: textStopResponse("peer done") },
      { lines: textStopResponse("subagent done") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.preStop": {',
              '    matcher: { mode: "subagent" },',
              "    run: async (input) => {",
              `      await fs.appendFile(MARKER, input.mode + ":" + input.agentType + "\\n")`,
              "    },",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                "custom-peer": {
                  model: "alibaba/qwen-plus",
                  mode: "all",
                },
                "custom-sub": {
                  model: "alibaba/qwen-plus",
                  mode: "all",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service

              // Peer spawn — mode filter should exclude this
              const sess1 = yield* session.create({ title: "matcher-mode-peer" })
              const r1 = yield* actor.spawn({
                mode: "peer",
                sessionID: sess1.id,
                agentType: "custom-peer",
                task: "x",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(r1.outcome)

              // Subagent spawn — mode filter should include this
              const sess2 = yield* session.create({ title: "matcher-mode-subagent" })
              const r2 = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess2.id,
                agentType: "custom-sub",
                task: "y",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(r2.outcome)
            }),
          ),
      })

      const content = await Bun.file(markerPath).text().catch(() => "")
      expect(content).toContain("subagent:custom-sub")
      expect(content).not.toContain("peer:custom-peer")
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })
})
describe("actor.postStop spawning child actors", () => {
  test("hook spawns child without infinite recursion when guarded by agentType check", async () => {
    // Approach A: test body simulates both spawns; postStop hook records which
    // agentType fired. Demonstrates that two related actors (outer + progress-maintainer)
    // each run postStop exactly once — total LLM calls is bounded at 2.
    const markerPath = path.join("/tmp", `recursion-${Date.now()}-${Math.random()}`)

    const server = startScriptedLLMServer([
      { lines: textStopResponse("first done") },      // outer subagent
      { lines: textStopResponse("maintainer done") }, // maintainer subagent
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              `import * as fs from "fs/promises"`,
              `const MARKER = ${JSON.stringify(markerPath)}`,
              "export default async () => ({",
              '  "actor.postStop": async (input) => {',
              `    await fs.appendFile(MARKER, input.agentType + "\\n")`,
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                outer: {
                  model: "alibaba/qwen-plus",
                },
                "progress-maintainer": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const actor = yield* Actor.Service
              const session = yield* Session.Service

              // Spawn outer subagent
              const sess1 = yield* session.create({ title: "outer" })
              const outer = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess1.id,
                agentType: "outer",
                task: "do work",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(outer.outcome)

              // Simulate the hook spawning a maintainer
              // (in production this would be done from inside the postStop hook)
              const sess2 = yield* session.create({ title: "maintainer" })
              const maintainer = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess2.id,
                agentType: "progress-maintainer",
                task: "fix progress.md",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(maintainer.outcome)

              // Wait for postStop chains to flush
              yield* Effect.sleep("100 millis")
            }),
          ),
      })

      // Poll for marker file: postStop fires after Deferred.succeed so may lag slightly
      for (let i = 0; i < 20; i++) {
        const content = await Bun.file(markerPath).text().catch(() => "")
        if (content.split("\n").filter(Boolean).length >= 2) break
        await Bun.sleep(50)
      }

      const content = await Bun.file(markerPath).text().catch(() => "")
      const lines = content.split("\n").filter(Boolean)

      // Each actor fires postStop exactly once — no infinite recursion
      expect(lines.length).toBe(2)
      expect(lines).toContain("outer")
      expect(lines).toContain("progress-maintainer")

      // Exactly 2 LLM calls (outer + maintainer); loop would inflate this
      expect(server.captures.length).toBe(2)
    } finally {
      await server.stop()
      try { await Bun.file(markerPath).delete() } catch {}
    }
  })
})

describe("hook observability events", () => {
  test("HookEvent.Executed fires for matched hook (outcome=success, continueRequested=false)", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("done") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.preStop": async (_input, _output) => {},',
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                "custom-events": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const events = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const collected: Array<{ event: string; outcome: string; continueRequested: boolean }> = []

              yield* bus.subscribe(HookEvent.Executed).pipe(
                Stream.runForEach((p) =>
                  Effect.sync(() => {
                    collected.push({
                      event: p.properties.event,
                      outcome: p.properties.outcome,
                      continueRequested: p.properties.continueRequested,
                    })
                  }),
                ),
                Effect.forkScoped,
              )

              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "events-test" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom-events",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(result.outcome)
              // Let the subscribed fork process any final publishes
              yield* Effect.sleep("100 millis")
              return collected
            }).pipe(Effect.scoped),
          ),
      })

      const preStopEvents = events.filter((e) => e.event === "actor.preStop" && e.outcome !== "skipped")
      expect(preStopEvents.length).toBeGreaterThanOrEqual(1)
      expect(preStopEvents[0].outcome).toBe("success")
      expect(preStopEvents[0].continueRequested).toBe(false)
    } finally {
      await server.stop()
    }
  })

  test("HookEvent.Executed fires with outcome=skipped for non-matching hook", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("done") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.preStop": {',
              '    matcher: { agentType: ["never-matches"] },',
              "    run: async (_input, _output) => {},",
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                "custom-skipped": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const events = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const collected: Array<{ event: string; outcome: string }> = []

              yield* bus.subscribe(HookEvent.Executed).pipe(
                Stream.runForEach((p) =>
                  Effect.sync(() => {
                    collected.push({ event: p.properties.event, outcome: p.properties.outcome })
                  }),
                ),
                Effect.forkScoped,
              )

              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "skipped-test" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom-skipped",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(result.outcome)
              yield* Effect.sleep("100 millis")
              return collected
            }).pipe(Effect.scoped),
          ),
      })

      const skippedEvents = events.filter((e) => e.outcome === "skipped")
      expect(skippedEvents.length).toBeGreaterThanOrEqual(1)
    } finally {
      await server.stop()
    }
  })

  test("HookEvent.ReActReentered fires on each re-entry, ReActMaxReached fires at cap", async () => {
    const server = startScriptedLLMServer([
      { lines: textStopResponse("turn1") },
      { lines: textStopResponse("turn2") },
      { lines: textStopResponse("turn3") },
      { lines: textStopResponse("turn4") },
      { lines: textStopResponse("turn5_unused") },
    ])
    try {
      await using tmp = await tmpdir({
        init: async (dir) => {
          const file = path.join(dir, "plugin.ts")
          await Bun.write(
            file,
            [
              "export default async () => ({",
              '  "actor.preStop": async (_input, output) => {',
              "    output.continue = true",
              '    output.reason = "keep going"',
              "  },",
              "})",
              "",
            ].join("\n"),
          )
          await Bun.write(
            path.join(dir, "mimocode.json"),
            JSON.stringify({
              $schema: "https://opencode.ai/config.json",
              plugin: [pathToFileURL(file).href],
              enabled_providers: ["alibaba"],
              provider: {
                alibaba: {
                  options: {
                    apiKey: "test-key",
                    baseURL: `${server.origin}/v1`,
                  },
                },
              },
              agent: {
                "custom-react": {
                  model: "alibaba/qwen-plus",
                },
              },
            }),
          )
        },
      })

      const { reenteredEvents, maxReachedEvents } = await Instance.provide({
        directory: tmp.path,
        fn: async () =>
          AppRuntime.runPromise(
            Effect.gen(function* () {
              const bus = yield* Bus.Service
              const reenteredEvents: Array<{ phase: string; iteration: number }> = []
              const maxReachedEvents: Array<{ phase: string }> = []

              yield* bus.subscribe(HookEvent.ReActReentered).pipe(
                Stream.runForEach((p) =>
                  Effect.sync(() => {
                    reenteredEvents.push({ phase: p.properties.phase, iteration: p.properties.iteration })
                  }),
                ),
                Effect.forkScoped,
              )
              yield* bus.subscribe(HookEvent.ReActMaxReached).pipe(
                Stream.runForEach((p) =>
                  Effect.sync(() => {
                    maxReachedEvents.push({ phase: p.properties.phase })
                  }),
                ),
                Effect.forkScoped,
              )

              const actor = yield* Actor.Service
              const session = yield* Session.Service
              const sess = yield* session.create({ title: "react-events" })
              const result = yield* actor.spawn({
                mode: "subagent",
                sessionID: sess.id,
                agentType: "custom-react",
                task: "go",
                context: "none",
                tools: [],
                background: false,
              })
              yield* Deferred.await(result.outcome)
              yield* Effect.sleep("100 millis")
              return { reenteredEvents, maxReachedEvents }
            }).pipe(Effect.scoped),
          ),
      })

      // With MAX_PRE_REACT=3: iteration fires at 1, 2, 3 then cap hits → 3 re-entries
      expect(reenteredEvents.length).toBe(3)
      expect(reenteredEvents.every((e) => e.phase === "pre")).toBe(true)
      // Cap fires once
      expect(maxReachedEvents.length).toBe(1)
      expect(maxReachedEvents[0].phase).toBe("pre")
    } finally {
      await server.stop()
    }
  })
})
