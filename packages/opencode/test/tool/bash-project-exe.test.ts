import { afterEach, describe, expect } from "bun:test"
import { Effect, Layer } from "effect"
import fs from "fs/promises"
import path from "path"
import { ActorRegistry } from "../../src/actor/registry"
import { Agent } from "../../src/agent/agent"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Bus } from "../../src/bus"
import { Inbox } from "../../src/inbox"
import { InboxTable } from "../../src/inbox/inbox.sql"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { Git } from "../../src/git"
import { Instance } from "../../src/project/instance"
import { Plugin } from "../../src/plugin"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { MessageID, PartID, SessionID } from "../../src/session/schema"
import { ModelID, ProviderID } from "../../src/provider/schema"
import { Shell } from "../../src/shell/shell"
import { Database } from "../../src/storage"
import { Truncate } from "../../src/tool"
import { BashTool } from "../../src/tool/bash"
import { provideTmpdirInstance } from "../fixture/fixture"
import { testEffect } from "../lib/effect"

// Background-job mode for project-built executables: a command whose head is a
// path inside the project (no explicit timeout) runs synchronously for the
// grace window, is handed off to an instance-scoped monitor if it outlives it,
// and the monitor then delivers the outcome — part rewrite + inbox row — or
// kills the process on an output stall. Flags are live getters, so each test
// shrinks grace/stall via env (restored by finalizers) instead of TestClock.

afterEach(async () => {
  await Instance.disposeAll()
})

const base = Layer.mergeAll(Session.defaultLayer, ActorRegistry.defaultLayer, Bus.defaultLayer)

const it = testEffect(
  Layer.mergeAll(
    base,
    Inbox.layer.pipe(Layer.provide(base)),
    Truncate.defaultLayer,
    Agent.defaultLayer,
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Git.defaultLayer,
  ),
)

const posix = process.platform !== "win32"
const pinnedShell = posix ? "/bin/sh" : process.env.COMSPEC || "cmd.exe"
const RUN = posix ? "./run.sh" : ".\\run.cmd"
const SILENT = posix ? "./silent.sh" : ".\\silent.cmd"

// execute() infers its metadata from the classic (synchronous) branch, so the
// handoff-only fields need a narrow read rather than the union being widened.
const background = (metadata: unknown) => metadata as { running?: boolean; jobID?: string; exit?: number | null }

// Pin the shell so parsing and script invocation are deterministic: cmd.exe on
// Windows (same path bash.test.ts already exercises), /bin/sh elsewhere.
const pinShell = Effect.acquireRelease(
  Effect.sync(() => {
    const prev = process.env.SHELL
    process.env.SHELL = pinnedShell
    Shell.acceptable.reset()
    Shell.preferred.reset()
    return prev
  }),
  (prev) =>
    Effect.sync(() => {
      if (prev === undefined) delete process.env.SHELL
      else process.env.SHELL = prev
      Shell.acceptable.reset()
      Shell.preferred.reset()
    }),
)

const env = (key: string, value: string) =>
  Effect.acquireRelease(
    Effect.sync(() => {
      const prev = process.env[key]
      process.env[key] = value
      return prev
    }),
    (prev) =>
      Effect.sync(() => {
        if (prev === undefined) delete process.env[key]
        else process.env[key] = prev
      }),
  )

const seedScripts = (dir: string) =>
  Effect.promise(() =>
    posix
      ? (async () => {
          await fs.writeFile(path.join(dir, "run.sh"), "#!/bin/sh\necho start\nsleep 3\necho done\n")
          await fs.writeFile(path.join(dir, "silent.sh"), "#!/bin/sh\nsleep 30\n")
          await fs.chmod(path.join(dir, "run.sh"), 0o755)
          await fs.chmod(path.join(dir, "silent.sh"), 0o755)
        })()
      : (async () => {
          await fs.writeFile(path.join(dir, "run.cmd"), "@echo off\r\necho start\r\nping -n 4 127.0.0.1 >nul\r\necho done\r\n")
          await fs.writeFile(path.join(dir, "silent.cmd"), "@echo off\r\nping -n 31 127.0.0.1 >nul\r\n")
        })(),
  )

const ctx = (sessionID: SessionID, messageID: MessageID) => ({
  sessionID,
  messageID,
  callID: "test-call",
  agent: "build",
  abort: new AbortController().signal,
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
})

// Parent user message → assistant message → tool part, the FK order the part
// insert needs; the part starts "running" so the monitor's completion rewrite
// is what the assertions observe.
const seedToolPart = (sessions: Session.Interface, sessionID: SessionID, command: string) =>
  Effect.gen(function* () {
    const userID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: userID,
      sessionID,
      role: "user",
      time: { created: Date.now() },
      agent: "build",
      model: { providerID: ProviderID.make("seed"), modelID: ModelID.make("seed") },
    } satisfies MessageV2.User)
    const messageID = MessageID.ascending()
    yield* sessions.updateMessage({
      id: messageID,
      sessionID,
      role: "assistant",
      time: { created: Date.now() },
      parentID: userID,
      modelID: ModelID.make("seed"),
      providerID: ProviderID.make("seed"),
      mode: "primary",
      agent: "build",
      path: { cwd: Instance.worktree, root: Instance.worktree },
      cost: 0,
      tokens: { input: 0, output: 0, reasoning: 0, cache: { read: 0, write: 0 } },
    } satisfies MessageV2.Assistant)
    yield* sessions.updatePart({
      id: PartID.ascending(),
      messageID,
      sessionID,
      type: "tool",
      callID: "test-call",
      tool: "bash",
      state: {
        status: "running",
        input: { command, description: "run project script" },
        time: { start: Date.now() },
      },
    } satisfies MessageV2.ToolPart)
    return messageID
  })

function until<A>(label: string, check: () => A | undefined) {
  return Effect.gen(function* () {
    for (let attempt = 0; attempt < 100; attempt++) {
      const value = check()
      if (value !== undefined) return value
      yield* Effect.sleep("250 millis")
    }
    return yield* Effect.fail(new Error(`timed out waiting for ${label}`))
  })
}

const completedState = (messageID: MessageID) => {
  const found = MessageV2.parts(messageID).find((item) => item.type === "tool" && item.callID === "test-call")
  if (!found || found.type !== "tool" || found.state.status !== "completed") return undefined
  return found.state
}

const inboxRow = (sessionID: SessionID) =>
  Database.use((db) => db.select().from(InboxTable).all()).find(
    (row) => row.receiver_session_id === sessionID && row.receiver_actor_id === "main",
  )

describe("tool.bash project-executable background jobs", () => {
  it.live(
    "project-built program still running at grace expiry returns a background handoff",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", "150")
          yield* seedScripts(dir)
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const tool = yield* (yield* BashTool).init()

          const result = yield* tool.execute(
            { command: RUN, workdir: dir, description: "run project script" },
            ctx(info.id, MessageID.ascending()),
          )

          expect(result.output).toContain("handed off")
          expect(background(result.metadata).running).toBe(true)
          expect(result.metadata.exit).toBeNull()
          expect(typeof background(result.metadata).jobID).toBe("string")
        }),
      ),
    20000,
  )

  it.live(
    "handoff rewrites the tool part and delivers an inbox message when the job exits",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", "150")
          yield* seedScripts(dir)
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const messageID = yield* seedToolPart(sessions, info.id, RUN)
          const tool = yield* (yield* BashTool).init()

          const handoff = yield* tool.execute(
            { command: RUN, workdir: dir, description: "run project script" },
            ctx(info.id, messageID),
          )
          expect(background(handoff.metadata).running).toBe(true)
          expect(handoff.metadata.exit).toBeNull()

          const state = yield* until("tool part completion", () => completedState(messageID))
          expect(state.output).toContain("done")
          expect(state.metadata.exit).toBe(0)
          expect(typeof state.metadata.jobID).toBe("string")

          const row = yield* until("inbox row", () => inboxRow(info.id))
          const text = (row.content as { text?: string }).text ?? ""
          expect(text).toContain(`Command: ${RUN}`)
          expect(text).toContain("exit code 0")
        }),
      ),
    40000,
  )

  it.live(
    "silent background job is killed after the output stall and reported",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", "100")
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_STALL_MS", "400")
          yield* seedScripts(dir)
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const messageID = yield* seedToolPart(sessions, info.id, SILENT)
          const tool = yield* (yield* BashTool).init()

          const handoff = yield* tool.execute(
            { command: SILENT, workdir: dir, description: "silent project script" },
            ctx(info.id, messageID),
          )
          expect(background(handoff.metadata).running).toBe(true)

          const state = yield* until("stall kill rewrite", () => completedState(messageID))
          expect(state.output).toContain("produced no output for 400 ms")
          expect(state.metadata.exit).toBeNull()

          const row = yield* until("stall inbox row", () => inboxRow(info.id))
          const text = (row.content as { text?: string }).text ?? ""
          expect(text).toContain("killed after output stall")
          expect(text).toContain("was stopped by the monitor")
        }),
      ),
    40000,
  )

  it.live(
    "explicit timeout keeps the classic synchronous kill-at-timeout",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", "100")
          yield* seedScripts(dir)
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const tool = yield* (yield* BashTool).init()

          const started = Date.now()
          const result = yield* tool.execute(
            { command: SILENT, workdir: dir, timeout: 500, description: "slow project script" },
            ctx(info.id, MessageID.ascending()),
          )
          const elapsed = Date.now() - started

          expect(result.output).toContain("exceeding timeout 500 ms")
          expect(result.metadata.exit).toBeNull()
          expect(background(result.metadata).running).toBeUndefined()
          expect(background(result.metadata).jobID).toBeUndefined()
          // Classic path blocks for the timeout; a handoff would return at grace.
          expect(elapsed).toBeGreaterThanOrEqual(400)
          expect(elapsed).toBeLessThan(5000)
        }),
      ),
    20000,
  )

  it.live(
    "bare names and system paths never enter background mode",
    () =>
      provideTmpdirInstance((dir) =>
        Effect.gen(function* () {
          yield* pinShell
          yield* env("MIMOCODE_EXPERIMENTAL_BASH_JOB_GRACE_MS", "100")
          yield* seedScripts(dir)
          const sessions = yield* Session.Service
          const info = yield* sessions.create({ title: "Test" })
          const tool = yield* (yield* BashTool).init()

          const bare = posix ? "sleep 2" : "ping -n 3 127.0.0.1 >nul"
          const bareStart = Date.now()
          const first = yield* tool.execute(
            { command: bare, workdir: dir, description: "system command" },
            ctx(info.id, MessageID.ascending()),
          )
          expect(typeof first.metadata.exit).toBe("number")
          expect(background(first.metadata).running).toBeUndefined()
          expect(Date.now() - bareStart).toBeGreaterThan(1000)

          const system = posix
            ? "/bin/sleep 2"
            : `${path.join(process.env.WINDIR ?? "C:\\Windows", "System32", "ping.exe")} -n 3 127.0.0.1 >nul`
          const systemStart = Date.now()
          const second = yield* tool.execute(
            { command: system, workdir: dir, description: "system path command" },
            ctx(info.id, MessageID.ascending()),
          )
          expect(typeof second.metadata.exit).toBe("number")
          expect(background(second.metadata).running).toBeUndefined()
          expect(Date.now() - systemStart).toBeGreaterThan(1000)
        }),
      ),
    30000,
  )
})
