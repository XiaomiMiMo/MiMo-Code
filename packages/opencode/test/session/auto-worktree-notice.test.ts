import path from "path"
import { describe, expect, test } from "bun:test"
import { $ } from "bun"
import { Effect, Layer } from "effect"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { tmpdir } from "../fixture/fixture"
import { startScriptedLLMServer, textStopResponse, toolCallResponse } from "../lib/scripted-llm-server"
import { isAutoWorktreeHintSent, repoHasLinkedWorktrees } from "../../src/tool/auto-worktree-hint"

void Log.init({ print: false })

/** Seed a linked worktree so the repo looks like it has a worktree habit. */
async function seedLinkedWorktree(repo: string) {
  const wt = `${repo}-wt-${Math.random().toString(36).slice(2)}`
  await $`git -C ${repo} worktree add ${wt} -b aw-habit`.quiet()
  return wt
}

function run<A, E>(fx: Effect.Effect<A, E, SessionPrompt.Service | Session.Service>) {
  return Effect.runPromise(
    fx.pipe(Effect.scoped, Effect.provide(Layer.mergeAll(SessionPrompt.defaultLayer, Session.defaultLayer))),
  )
}

function providerConfig(origin: string) {
  return {
    $schema: "https://opencode.ai/config.json",
    enabled_providers: ["aw-test"],
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

describe("session.prompt auto-worktree first-write notice", () => {
  test("injects once after the first write tool, then persists the flag", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_write",
          name: "write",
          args: JSON.stringify({ file_path: "hello.txt", content: "hello\n" }),
        }),
      },
      { lines: textStopResponse("done-write") },
      { lines: textStopResponse("done-again") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
          await seedLinkedWorktree(dir)
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
                title: "aw write notice",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Create hello.txt with hello" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(userMsgs).toHaveLength(1)

              const notices = noticeParts(userMsgs[0])
              expect(notices).toHaveLength(1)
              const text = notices[0].type === "text" ? notices[0].text : ""
              // Habit repo: may isolate without asking first.
              expect(text).toContain("already uses worktrees")
              expect(text).toContain("do not need to ask the user first")
              expect(text).not.toContain("Do NOT create a worktree on your own")
              expect(text).toContain(path.resolve(tmp.path))
              expect(text).not.toContain("Conflict detected")
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              // Cache-safety: the notice must ride a user message, never the system prompt.
              // First LLM call happens before any write, so it must not see the notice.
              // Second call (post-write step) must see it only in a user-role message.
              expect(stub.captures.length).toBeGreaterThanOrEqual(2)
              const firstMsgs = JSON.stringify(stub.captures[0]?.messages ?? [])
              expect(firstMsgs).not.toContain("Auto-Worktree Notice")
              const second = stub.captures[1]?.messages ?? []
              const systemText = JSON.stringify(second.filter((m) => m.role === "system"))
              expect(systemText).not.toContain("Auto-Worktree Notice")
              const userText = JSON.stringify(second.filter((m) => m.role === "user"))
              expect(userText).toContain("Auto-Worktree Notice")

              // Second turn must not re-inject.
              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Say done-again" }],
              })
              const msgs2 = yield* sessions.messages({ sessionID: session.id })
              const userMsgs2 = msgs2.filter((m) => m.info.role === "user")
              expect(userMsgs2).toHaveLength(2)
              expect(noticeParts(userMsgs2[0])).toHaveLength(1)
              expect(noticeParts(userMsgs2[1])).toHaveLength(0)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("injects ask-first notice when the repo has no linked worktrees yet", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_write_nohabit",
          name: "write",
          args: JSON.stringify({ file_path: "plain.txt", content: "x\n" }),
        }),
      },
      { lines: textStopResponse("done-plain") },
    ])

    try {
      // git: true but NO seedLinkedWorktree — habit signal is unknown, still notice.
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
        },
      })
      expect(repoHasLinkedWorktrees(tmp.path)).toBe(false)

      await Instance.provide({
        directory: tmp.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({
                title: "aw no habit",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Write plain.txt" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const userMsgs = msgs.filter((m) => m.info.role === "user")
              const notices = noticeParts(userMsgs[0])
              expect(notices).toHaveLength(1)
              const text = notices[0].type === "text" ? notices[0].text : ""
              expect(text).toContain("Do NOT create a worktree on your own")
              expect(text).toContain("ask the user")
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("does not inject when the session only reads", async () => {
    const stub = startScriptedLLMServer([{ lines: textStopResponse("no writes here") }])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
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
                title: "aw no write",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Just say hi" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(noticeParts(userMsgs[0])).toHaveLength(0)
              expect(isAutoWorktreeHintSent(session.id)).toBe(false)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("injects once after a bash write command (redirect)", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_bash",
          name: "bash",
          args: JSON.stringify({ command: "echo hello > from-bash.txt", description: "Write via redirect" }),
        }),
      },
      { lines: textStopResponse("done-bash") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
          await seedLinkedWorktree(dir)
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
                title: "aw bash write",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Write from-bash.txt via bash redirect" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const bashTool = msgs
                .flatMap((m) => m.parts)
                .find((p) => p.type === "tool" && p.tool === "bash")
              expect(bashTool).toBeDefined()
              if (bashTool?.type === "tool" && bashTool.state.status === "completed") {
                expect(bashTool.state.metadata.fileWrite).toBe(true)
              }

              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(noticeParts(userMsgs[0])).toHaveLength(1)
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("does not inject for a pure-read bash command", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_bash_read",
          name: "bash",
          args: JSON.stringify({ command: "ls -la", description: "List files" }),
        }),
      },
      { lines: textStopResponse("done-list") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
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
                title: "aw bash read",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "List the directory with bash" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const bashTool = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash")
              expect(bashTool).toBeDefined()
              if (bashTool?.type === "tool" && bashTool.state.status === "completed") {
                expect(bashTool.state.metadata.fileWrite).not.toBe(true)
              }

              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(noticeParts(userMsgs[0])).toHaveLength(0)
              expect(isAutoWorktreeHintSent(session.id)).toBe(false)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("cd-escape from a non-git session dir into another repo's main worktree still injects", async () => {
    // Target repo is the real main worktree the command will write into.
    await using target = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "keep.txt"), "k\n")
        await seedLinkedWorktree(dir)
      },
    })
    const targetRepo = target.path

    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_bash_cd",
          name: "bash",
          args: JSON.stringify({
            command: `cd ${JSON.stringify(targetRepo)} && echo escaped > escaped.txt`,
            description: "cd into repo and write",
          }),
        }),
      },
      { lines: textStopResponse("done-escape") },
    ])

    try {
      // Scratch session dir is NOT a git repo.
      await using scratch = await tmpdir({
        outsideGit: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
        },
      })

      await Instance.provide({
        directory: scratch.path,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({
                title: "aw cd escape",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [
                  {
                    type: "text",
                    text: `cd into ${targetRepo} and write escaped.txt`,
                  },
                ],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const bashTool = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash")
              expect(bashTool).toBeDefined()
              if (bashTool?.type === "tool" && bashTool.state.status === "completed") {
                expect(bashTool.state.metadata.mainWorktreeHits?.[0]).toBe(path.resolve(targetRepo))
              }

              const userMsgs = msgs.filter((m) => m.info.role === "user")
              const notices = noticeParts(userMsgs[0])
              expect(notices).toHaveLength(1)
              const text = notices[0].type === "text" ? notices[0].text : ""
              expect(text).toContain(path.resolve(targetRepo))
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test("git checkout on a main worktree injects even without a file write", async () => {
    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_bash_git",
          name: "bash",
          args: JSON.stringify({
            command: "git checkout -b wt/feature",
            description: "Create branch on main",
          }),
        }),
      },
      { lines: textStopResponse("done-git") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
          await seedLinkedWorktree(dir)
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
                title: "aw git checkout",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Create wt/feature on main worktree" }],
              })

              const msgs = yield* sessions.messages({ sessionID: session.id })
              const bashTool = msgs.flatMap((m) => m.parts).find((p) => p.type === "tool" && p.tool === "bash")
              expect(bashTool).toBeDefined()
              if (bashTool?.type === "tool" && bashTool.state.status === "completed") {
                expect(bashTool.state.metadata.fileWrite).not.toBe(true)
                expect(bashTool.state.metadata.mainWorktreeHits?.[0]).toBe(path.resolve(tmp.path))
              }

              const userMsgs = msgs.filter((m) => m.info.role === "user")
              expect(noticeParts(userMsgs[0])).toHaveLength(1)
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
  })

  test(
    "second repo mutated later does not re-inject; standing rule covers it",
    async () => {
    await using repoB = await tmpdir({
      git: true,
      init: async (dir) => {
        await Bun.write(path.join(dir, "b.txt"), "b\n")
      },
    })
    const pathB = repoB.path

    const stub = startScriptedLLMServer([
      {
        lines: toolCallResponse({
          id: "call_write_a",
          name: "write",
          args: JSON.stringify({ file_path: "a.txt", content: "a\n" }),
        }),
      },
      { lines: textStopResponse("done-a") },
      {
        lines: toolCallResponse({
          id: "call_write_b",
          name: "write",
          args: JSON.stringify({ file_path: path.join(pathB, "b2.txt"), content: "b2\n" }),
        }),
      },
      { lines: textStopResponse("done-b") },
    ])

    try {
      await using tmp = await tmpdir({
        git: true,
        init: async (dir) => {
          await Bun.write(path.join(dir, "mimocode.json"), JSON.stringify(providerConfig(stub.origin)))
          await seedLinkedWorktree(dir)
        },
      })
      const pathA = tmp.path

      await Instance.provide({
        directory: pathA,
        fn: () =>
          run(
            Effect.gen(function* () {
              const prompt = yield* SessionPrompt.Service
              const sessions = yield* Session.Service
              const session = yield* sessions.create({
                title: "aw multi repo once",
                permission: [{ permission: "*", pattern: "*", action: "allow" }],
              })

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: "Write a.txt here" }],
              })

              const after1 = yield* sessions.messages({ sessionID: session.id })
              const user1 = after1.filter((m) => m.info.role === "user")
              expect(noticeParts(user1[0])).toHaveLength(1)
              const text1 = noticeParts(user1[0])[0].type === "text" ? noticeParts(user1[0])[0].text : ""
              expect(text1).toContain(path.resolve(pathA))
              expect(text1).toContain("not limited to the path above")
              expect(text1).toContain("another git repository")

              yield* prompt.prompt({
                sessionID: session.id,
                agent: "build",
                parts: [{ type: "text", text: `Write ${pathB}/b2.txt` }],
              })

              const after2 = yield* sessions.messages({ sessionID: session.id })
              const user2 = after2.filter((m) => m.info.role === "user")
              expect(user2).toHaveLength(2)
              // Once per session: no second notice for repo B.
              expect(noticeParts(user2[0])).toHaveLength(1)
              expect(noticeParts(user2[1])).toHaveLength(0)
              expect(isAutoWorktreeHintSent(session.id)).toBe(true)

              yield* sessions.remove(session.id)
            }),
          ),
      })
    } finally {
      void stub.stop()
    }
    },
    20_000,
  )
})
