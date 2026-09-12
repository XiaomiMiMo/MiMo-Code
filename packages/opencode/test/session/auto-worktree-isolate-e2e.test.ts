import path from "path"
import fs from "fs"
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

function providerConfig(origin: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["aw-test"],
    auto_worktree: true,
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

/**
 * E2E (engine path shared by TUI + Desktop): habit-repo first write is HARD-GATED
 * off main; the model recovers by creating a worktree and writing there.
 *
 * This is the product effect that notice-only could not deliver (clean real-model
 * runs finished the single-shot task on main without isolating).
 */
describe("auto-worktree isolate effect (engine path shared by TUI + Desktop)", () => {
  test("blocked main write recovers by isolating; file lands in the new worktree", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_write_main",
          name: "write",
          args: JSON.stringify({ file_path: "main-only.txt", content: "on-main\n" }),
        }),
      },
      {
        lines: toolCallResponse({
          id: "call_isolate",
          name: "bash",
          args: JSON.stringify({
            command: 'git worktree add ".isolate-e2e" -b isolate-e2e',
            description: "Isolate into a new worktree after the write gate",
          }),
        }),
      },
      {
        lines: toolCallResponse({
          id: "call_write_isolated",
          name: "write",
          args: JSON.stringify({ file_path: ".isolate-e2e/isolated.txt", content: "on-isolated\n" }),
        }),
      },
      { lines: textStopResponse("isolated after hard gate") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
          const habit = `${dir}-habit`
          await $`git -C ${dir} worktree add ${habit} -b habit-seed`.quiet()
        },
      })

      const repo = tmp.path
      const isolateDir = path.join(repo, ".isolate-e2e")

      await Instance.provide({
        directory: repo,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({
                title: "aw isolate e2e",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Implement the change" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })

              // First write into main must FAIL with the hard-gate error.
              expect(fs.existsSync(path.join(repo, "main-only.txt"))).toBe(false)

              const writeParts = msgs
                .flatMap((m) => m.parts)
                .filter((p): p is Extract<typeof p, { type: "tool" }> => p.type === "tool" && p.tool === "write")
              expect(writeParts.length).toBe(2)
              expect(writeParts[0]!.state.status).toBe("error")
              const errBlob = String((writeParts[0]!.state as { error?: string }).error ?? "")
              expect(errBlob).toContain("MAIN worktree")
              expect(errBlob).toContain("Isolate this change into a worktree")
              expect(errBlob).not.toContain("git worktree add")
              expect(writeParts[1]!.state.status).toBe("completed")

              // Second write lands inside the isolated worktree.
              expect(fs.existsSync(path.join(isolateDir, "isolated.txt"))).toBe(true)
              expect(fs.readFileSync(path.join(isolateDir, "isolated.txt"), "utf8")).toBe("on-isolated\n")

              const list = yield* Effect.promise(() => $`git -C ${repo} worktree list --porcelain`.text())
              expect(list).toContain(path.resolve(isolateDir))

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  }, 30_000)
})
