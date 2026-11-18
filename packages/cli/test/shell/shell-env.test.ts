// $SHELL on Windows is inherited from Git Bash / MSYS2 / Cygwin terminals or set by
// hand. Whatever it holds, the bash tool must end up on a shell that exists, and its
// description must name the shell that actually runs.
import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import { lstatSync } from "fs"
import fs from "fs/promises"
import path from "path"
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

const gitBash = win ? Shell.gitbash() : undefined

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
  ...(gitBash ? [["Windows path without .exe", gitBash.replace(/\.exe$/i, "")] as [string, string]] : []),
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

  test.skipIf(!gitBash)("keeps a Windows $SHELL path that omits .exe", async () => {
    await withShell(gitBash!.replace(/\.exe$/i, ""), async () => {
      expect(Shell.acceptable().toLowerCase()).toBe(gitBash!.toLowerCase())
      expect(Shell.preferred().toLowerCase()).toBe(gitBash!.toLowerCase())
    })
  })

  test.skipIf(!Bun.which("pwsh.exe"))("caches a successful pwsh version probe", async () => {
    const pwsh = Bun.which("pwsh.exe")!
    const version = await Shell.probePowershellVersion(pwsh)
    expect(version).toMatch(/^\d+\.\d+/)
    expect(Shell.powershellVersion(pwsh)).toBe(version)
  })

  // A "pwsh.exe" whose probe cannot report a version (here a renamed cmd.exe).
  test("an unknown pwsh version is not cached and gets no Windows PowerShell 5.1 guidance", async () => {
    await using tmp = await tmpdir()
    const fake = path.join(tmp.path, "pwsh.exe")
    await fs.copyFile(path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "cmd.exe"), fake)
    await withShell(fake, async () => {
      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          await runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))
          expect(Shell.powershellVersion(fake)).toBeUndefined()
          const text = bashDescription()
          expect(text).toContain("Shell: pwsh (PowerShell)")
          expect(text).not.toContain("avoid '&&'")
          expect(text).not.toContain("aliases of Invoke-WebRequest")
          expect(text).toContain("curl.exe --data @body.json")
          // A recent failure is not retried, so a hung pwsh cannot stall every tool init.
          const start = performance.now()
          expect(await Shell.probePowershellVersion(fake)).toBeUndefined()
          expect(performance.now() - start).toBeLessThan(10)
        },
      })
    })
  }, 30_000)

  for (const [layout, dir] of [
    ["MSYS2", ["msys64", "usr", "bin"]],
    ["Cygwin", ["cygwin64", "bin"]],
  ] as const) {
    test(`maps /usr/bin/zsh onto a ${layout} installation`, async () => {
      await using tmp = await tmpdir()
      const zsh = path.join(tmp.path, ...dir, "zsh.exe")
      await fs.mkdir(path.dirname(zsh), { recursive: true })
      await Bun.write(zsh, "")
      const prev = process.env.SystemDrive
      process.env.SystemDrive = tmp.path
      try {
        await withShell("/usr/bin/zsh", async () => {
          expect(Shell.preferred()).toBe(zsh)
        })
      } finally {
        process.env.SystemDrive = prev
      }
    })
  }
})
