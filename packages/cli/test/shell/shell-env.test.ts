// $SHELL on Windows is inherited from Git Bash / MSYS2 / Cygwin terminals or set by
// hand. Whatever it holds, the bash tool must end up on a shell that exists, and its
// description must name the shell that actually runs.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { lstatSync } from "fs"
import { Shell } from "../../src/shell/shell"
import { BashTool, bashDescription } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Plugin } from "../../src/plugin"
import { Git } from "../../src/git"
import { tmpdir } from "../fixture/fixture"

const win = process.platform === "win32"

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    CrossSpawnSpawner.defaultLayer,
    AppFileSystem.defaultLayer,
    Plugin.defaultLayer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
    Git.defaultLayer,
  ),
)

const ctx = {
  sessionID: SessionID.make("ses_test"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

async function withShell<T>(value: string | undefined, fn: () => Promise<T>) {
  const prev = process.env.SHELL
  if (value === undefined) delete process.env.SHELL
  else process.env.SHELL = value
  Shell.acceptable.reset()
  Shell.preferred.reset()
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
    Shell.preferred.reset()
  }
}

// lstat: Microsoft Store execution aliases are reparse points that stat() rejects.
function present(file: string) {
  try {
    return lstatSync(file, { throwIfNoEntry: false }) !== undefined
  } catch {
    return false
  }
}

const values: Array<[string, string | undefined]> = [
  ["unset", undefined],
  ["Git Bash /usr/bin/bash", "/usr/bin/bash"],
  ["Cygwin-style /bin/bash", "/bin/bash"],
  ["MSYS2 /usr/bin/zsh", "/usr/bin/zsh"],
  ["MSYS /bin/sh", "/bin/sh"],
  ["stale Windows path", "C:\\example\\missing\\bash.exe"],
  ["bare name not on PATH", "zsh"],
  ["bare pwsh", "pwsh"],
  ["bare powershell", "powershell"],
  ["cmd.exe", "cmd.exe"],
  ["blacklisted fish", "/usr/bin/fish"],
]

describe.skipIf(!win)("$SHELL handling on Windows", () => {
  for (const [label, value] of values) {
    test(`${label}: resolves to an existing shell that the bash tool can run and describe`, async () => {
      await using tmp = await tmpdir()
      await withShell(value, async () => {
        for (const shell of [Shell.acceptable(), Shell.preferred()]) {
          expect(present(shell) || Bun.which(shell) !== null, shell).toBe(true)
        }
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const name = Shell.name(Shell.acceptable())
            expect(bashDescription()).toMatch(new RegExp(`Shell: ${name}\\b`))
            const tool = await runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))
            const r = await Effect.runPromise(tool.execute({ command: "echo shell-ok", description: "probe" }, ctx))
            expect(r.metadata.exit).toBe(0)
            expect(r.metadata.output).toContain("shell-ok")
          },
        })
      })
    }, 30_000)
  }

  test.skipIf(!Bun.which("pwsh.exe"))("prefers an installed PowerShell 7, including the Store alias", async () => {
    await withShell(undefined, async () => {
      expect(Shell.name(Shell.acceptable())).toBe("pwsh")
    })
  })
})
