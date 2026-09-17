import path from "path"
import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Config } from "../../src/config"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"

void Log.init({ print: false })

/** Seed a linked worktree so the repo looks like it has a worktree habit. */
async function seedLinkedWorktree(repo: string) {
  const wt = path.join(repo, ".worktrees", "example")
  await $`git -C ${repo} worktree add ${wt} -b feat/example`.quiet()
  return wt
}

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(
      Effect.scoped,
      // Config must sit on the OUTER fiber (like AppRuntime.mergeAll). SessionPrompt's
      // own Layer.provide(Config) is consumed at construction; tool execute runs via
      // EffectBridge and Effect.serviceOption(Config) only sees the caller's context.
      Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer, Config.defaultLayer)),
    ),
  )
}

function providerConfig(origin: string, opts?: { auto_worktree?: boolean }) {
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["aw-test"],
    ...(opts?.auto_worktree !== undefined ? { auto_worktree: opts.auto_worktree } : {}),
    provider: {
      "aw-test": {
        name: "AW Test",
        npm: "@ai-sdk/openai-compatible",
        env: [],
        options: { apiKey: "test-key", baseURL: `${origin}/v1` },
        models: {
          "aw-model": {
            name: "AW Model",
            tool_call: true,
            limit: { context: 64000, output: 4000 },
            modalities: { input: ["text"], output: ["text"] },
          },
        },
      },
    },
    agent: { build: { model: "aw-test/aw-model" } },
  }
}

function noticeParts(session: { parts: Array<{ type: string; text?: string; synthetic?: boolean }> }) {
  return session.parts.filter(
    (p) => p.type === "text" && p.synthetic && typeof p.text === "string" && p.text.includes("Auto-Worktree Notice"),
  )
}

describe("main-worktree writes without automatic isolation", () => {
  for (const tool of ["write", "bash"] as const) {
    for (const linked of [false, true]) {
      test.each([
        ["omitted", undefined],
        ["false", false],
        ["true", true],
      ] as const)(
        `${tool}, linked=${linked}, legacy config=%s: writes succeed without isolation notices`,
        async (_label, value) => {
          const stub = startScriptedLLMServer([
            {
              lines: toolCallResponse({
                id: "call_write_off",
                name: tool,
                args: JSON.stringify(
                  tool === "write"
                    ? { file_path: "off.txt", content: "off\n" }
                    : { command: "echo off > off.txt", description: "Write fixture" },
                ),
              }),
            },
            { lines: textStopResponse("done-off") },
          ])

          try {
            await using tmp = await tmpdir({
              git: true,
              init: async (dir) => {
                await Bun.write(
                  path.join(dir, "mimocode.json"),
                  JSON.stringify(providerConfig(stub.origin, { auto_worktree: value })),
                )
                if (linked) await seedLinkedWorktree(dir)
              },
            })

            await Instance.provide({
              directory: tmp.path,
              fn: () =>
                run(
                  Effect.gen(function* () {
                    const prompt = yield* SessionPrompt.Service
                    const sessions = yield* Session.Service
                    const session = yield* sessions.create({
                      title: `aw off ${_label}`,
                      permission: [{ permission: "*", pattern: "*", action: "allow" }],
                    })

                    yield* prompt.prompt({
                      sessionID: session.id,
                      agent: "build",
                      parts: [{ type: "text", text: "Create off.txt" }],
                    })

                    const msgs = yield* sessions.messages({ sessionID: session.id })
                    const userMsgs = msgs.filter((m) => m.info.role === "user")
                    expect(noticeParts(userMsgs[0])).toHaveLength(0)
                    expect(yield* Effect.promise(() => Bun.file(path.join(tmp.path, "off.txt")).text())).toBe("off\n")
                    const parts = msgs.flatMap((m) => m.parts).filter((p) => p.type === "tool")
                    expect(parts.some((p) => p.tool === tool && p.state.status === "completed")).toBe(true)

                    yield* sessions.remove(session.id)
                  }),
                ),
            })
          } finally {
            void stub.stop()
          }
        },
      )
    }
  }
})
