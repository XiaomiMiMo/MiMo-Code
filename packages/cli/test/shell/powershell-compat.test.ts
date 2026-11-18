// Cross-version PowerShell compatibility matrix (Windows PowerShell 5.1, pwsh 6/7).
//
// Each assertion states behaviour the agent tooling relies on. Where PowerShell
// itself cannot be fixed (native argument passing before 7.3, `2>&1` error records
// before 7), the assertion instead requires the tool description to warn about it.
// Run with:  bun test test/shell/powershell-compat.test.ts
import { describe, expect, test } from "bun:test"
import { Effect, Layer, ManagedRuntime } from "effect"
import fs from "fs/promises"
import path from "path"
import { Shell } from "../../src/shell/shell"
import { BashTool, bashDescription } from "../../src/tool/bash"
import { Instance } from "../../src/project/instance"
import { extractZip } from "../../src/util/archive"
import { which } from "../../src/util/which"
import { tmpdir } from "../fixture/fixture"
import type { Permission } from "../../src/permission"
import { Agent } from "../../src/agent/agent"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID } from "../../src/session/schema"
import * as CrossSpawnSpawner from "../../src/effect/cross-spawn-spawner"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Plugin } from "../../src/plugin"
import { Git } from "../../src/git"

const win = process.platform === "win32"

// Extra executables (e.g. portable pwsh 6.x / 7.2) can be added with
// MIMOCODE_TEST_PS_EXTRA="C:\path\to\pwsh.exe;C:\other\pwsh.exe".
const shells = (() => {
  if (!win) return []
  const extra = (process.env.MIMOCODE_TEST_PS_EXTRA ?? "").split(";").filter(Boolean)
  const list = [Bun.which("powershell.exe"), Bun.which("pwsh.exe"), ...extra]
    .filter((s): s is string => Boolean(s))
    .map((shell) => {
      const version = Bun.spawnSync([shell, "-NoProfile", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
        stdin: "ignore",
      })
        .stdout.toString()
        .trim()
      return { label: `${Shell.name(shell)} ${version}`, shell }
    })
  return list.filter((item, i) => list.findIndex((o) => o.label === item.label) === i)
})()

// Same invocation the bash tool builds in src/tool/bash.ts cmd().
function ps(shell: string, command: string) {
  const invocation = Shell.powershell(command)
  const proc = Bun.spawnSync([shell, ...invocation.args], {
    stdin: "ignore",
    env: { ...process.env, ...invocation.env },
  })
  return { code: proc.exitCode, stdout: proc.stdout.toString(), stderr: proc.stderr.toString() }
}

async function withShell<T>(shell: string, fn: () => Promise<T>) {
  const prev = process.env.SHELL
  process.env.SHELL = shell
  Shell.acceptable.reset()
  try {
    return await fn()
  } finally {
    if (prev === undefined) delete process.env.SHELL
    else process.env.SHELL = prev
    Shell.acceptable.reset()
  }
}

async function description(shell: string) {
  await using tmp = await tmpdir()
  return await withShell(shell, () => Instance.provide({ directory: tmp.path, fn: async () => bashDescription() }))
}

const lit = (p: string) => `'${p.replaceAll("'", "''")}'`
const bun = lit(process.execPath)

const each = (name: string, fn: (item: { label: string; shell: string }) => Promise<void> | void) => {
  for (const item of shells) test(`${name} [${item.label}]`, () => fn(item), 30_000)
}

describe.skipIf(!win || shells.length === 0)("powershell version compat: raw shell behaviour", () => {
  // Case 1: before pwsh 7.3, native argument passing drops embedded quotes and
  // empty strings and can merge neighbouring args. Not fixable from outside, so
  // the description must tell the model to avoid it.
  each("native arguments pass verbatim, or the description warns", async ({ shell }) => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "argv.js")
    await Bun.write(script, "console.log(JSON.stringify(process.argv.slice(2)))")
    const r = ps(shell, `& ${bun} ${lit(script)} 'a"b' '' 'c d'`)
    expect(r.code).toBe(0)
    if (r.stdout.trim() === JSON.stringify(['a"b', "", "c d"])) return
    expect(await description(shell)).toContain("drops embedded double quotes")
  })

  // Case 2: 5.1 `>` / Out-File writes UTF-16LE and Set-Content the ANSI code page.
  // 5.1 has no BOM-less UTF-8 option, so a UTF-8 BOM is accepted there.
  each("`>` redirection writes UTF-8", async ({ shell }) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "redirect.txt")
    const r = ps(shell, `'中文' > ${lit(file)}`)
    expect(r.code).toBe(0)
    const bytes = new Uint8Array(await fs.readFile(file))
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").trim()).toBe("中文")
  })

  each("Set-Content writes UTF-8", async ({ shell }) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "set-content.txt")
    const r = ps(shell, `Set-Content -LiteralPath ${lit(file)} -Value '中文'`)
    expect(r.code).toBe(0)
    const bytes = new Uint8Array(await fs.readFile(file))
    expect(new TextDecoder("utf-8", { fatal: true }).decode(bytes).replace(/^\uFEFF/, "").trim()).toBe("中文")
  })

  each("`>>` appends without a BOM in the middle of the file", async ({ shell }) => {
    await using tmp = await tmpdir()
    const file = path.join(tmp.path, "append.txt")
    expect(ps(shell, `'a' > ${lit(file)}; 'b' >> ${lit(file)}`).code).toBe(0)
    const text = new TextDecoder("utf-8", { fatal: true }).decode(new Uint8Array(await fs.readFile(file)))
    expect(text.replace(/^\uFEFF/, "")).not.toContain("\uFEFF")
  })

  // Case 3: 5.1 prefixes text piped into native commands with a UTF-8 BOM.
  each("piping text to a native command sends no BOM", async ({ shell }) => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "hex.js")
    await Bun.write(
      script,
      "let b='';process.stdin.on('data',d=>b+=Buffer.from(d).toString('hex'));process.stdin.on('end',()=>console.log(b))",
    )
    const r = ps(shell, `'中文' | & ${bun} ${lit(script)}`)
    expect(r.code).toBe(0)
    expect(r.stdout.trim().startsWith(Buffer.from("中文").toString("hex"))).toBe(true)
  })

  // Case 4: before pwsh 7, `native 2>&1` turns stderr lines into error records.
  // The exit code must still follow the native command; the leftover noise is
  // only acceptable where the description tells the model not to do this.
  each("native stderr merged via 2>&1 keeps the exit code and has no ANSI", async ({ shell }) => {
    const ok = ps(shell, "cmd /c 'echo err 1>&2' 2>&1")
    const out = ok.stdout + ok.stderr
    expect(ok.code).toBe(0)
    expect(out).toContain("err")
    expect(out).not.toContain("\x1b[")
    if (out.includes("NativeCommandError")) expect(await description(shell)).toContain("Do not append `2>&1`")
    expect(ps(shell, "cmd /c 'echo err 1>&2 & exit 4' 2>&1").code).toBe(4)
  })

  // Case 5: `-Command` alone reports 0/1 instead of the last command's outcome.
  each("propagates the last command's exit code", ({ shell }) => {
    expect(ps(shell, "cmd /c exit 7").code).toBe(7)
    expect(ps(shell, "cmd /c exit 7; Write-Output ok").code).toBe(0)
    expect(ps(shell, "Get-Item does-not-exist").code).toBe(1)
    expect(ps(shell, "exit 5").code).toBe(5)
    expect(ps(shell, "throw 'boom'").code).toBe(1)
  })

  // Case 6: error records must not quote setup code the model never wrote.
  // Before pwsh 7, a top-level Write-Error quotes the invoking script block by
  // design; there only the encoding setup is required to stay hidden.
  each("error messages do not leak the setup code", ({ shell, label }) => {
    const cmdlet = ps(shell, "Get-Item does-not-exist")
    expect(cmdlet.stderr).toContain("does-not-exist")
    expect(cmdlet.stderr).not.toContain("__mimo")
    expect(cmdlet.stderr).not.toContain("OutputEncoding")
    const written = ps(shell, "Write-Error 'boom'")
    expect(written.stderr).toContain("boom")
    expect(written.stderr).not.toContain("OutputEncoding")
    if (!/ [56]\./.test(label)) expect(written.stderr).not.toContain("__mimo")
  })

  // Case 7: the default execution policy (Restricted on 5.1) blocks the *.ps1
  // shims npm/pnpm/bun install, which PowerShell resolves before *.cmd.
  each("can run a local .ps1 (npm/bun shims)", async ({ shell }) => {
    await using tmp = await tmpdir()
    const script = path.join(tmp.path, "shim.ps1")
    await Bun.write(script, "'shim-ok'")
    const r = ps(shell, `& ${lit(script)}`)
    expect(r.stderr).toBe("")
    expect(r.stdout.trim()).toBe("shim-ok")
  })

  // Case 8: 5.1 aliases curl/wget to Invoke-WebRequest (pwsh 6+ removed them).
  // The aliases are kept, so the description must point the model at curl.exe.
  each("curl resolves to curl.exe, or the description says to call curl.exe", async ({ shell }) => {
    const r = ps(shell, "(Get-Command curl | Select-Object -First 1).CommandType")
    if (r.stdout.trim() === "Application") return
    expect(await description(shell)).toContain("call `curl.exe` explicitly")
  })
})

describe.skipIf(!win || shells.length === 0)("powershell version compat: tool description", () => {
  // Case 9: syntax the shell rejects must be called out for that version.
  each("description warns about every syntax the shell rejects", async ({ shell }) => {
    const text = await description(shell)
    if (ps(shell, "Write-Output a && Write-Output b").code !== 0) expect(text).toContain("avoid '&&'")
    if (ps(shell, "$null ?? 'x'").code !== 0) expect(text).toMatch(/`\?\?`|null-coalescing/i)
    if (ps(shell, "$true ? 1 : 2").code !== 0) expect(text).toMatch(/ternary/i)
  })
})

describe.skipIf(!win || shells.length === 0)("powershell version compat: through the bash tool", () => {
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

  async function viaTool(shell: string, command: string) {
    await using tmp = await tmpdir()
    return await withShell(shell, () =>
      Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const bash = await runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))
          const r = await Effect.runPromise(bash.execute({ command, description: "compat" }, ctx))
          return { exit: r.metadata.exit, output: r.metadata.output ?? "" }
        },
      }),
    )
  }

  // Case 13: a parse error used to abort the script before the UTF-8 setup ran,
  // so a zh-CN 5.1 returned the localized parser message as GBK mojibake.
  each("parse errors reach the model as readable text", async ({ shell }) => {
    const r = await viaTool(shell, "Write-Output (")
    expect(r.exit).not.toBe(0)
    expect(r.output.trim()).not.toBe("")
    expect(r.output).not.toContain("\uFFFD")
    expect(r.output).not.toContain("__mimo")
  })

  each("exit codes, UTF-8 and plain-text errors reach the model", async ({ shell }) => {
    expect((await viaTool(shell, "cmd /c exit 3")).exit).toBe(3)
    const text = await viaTool(shell, "Write-Output '中文输出'")
    expect(text.output).toContain("中文输出")
    const error = await viaTool(shell, "Get-Item does-not-exist")
    expect(error.exit).toBe(1)
    expect(error.output).not.toContain("\x1b[")
    expect(error.output).not.toContain("__mimo")
  })
})

describe.skipIf(!win || !Bun.which("pwsh.exe"))("powershell version compat: permission scan", () => {
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
  const ctx = (requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">>) => ({
    sessionID: SessionID.make("ses_test"),
    messageID: MessageID.make(""),
    callID: "",
    agent: "build",
    abort: AbortSignal.any([]),
    messages: [],
    metadata: () => Effect.void,
    ask: (req: Omit<Permission.Request, "id" | "sessionID" | "tool">) =>
      Effect.sync(() => {
        requests.push(req)
        throw new Error("stop")
      }),
  })

  // Case 10: pwsh 7 accepts pipeline-chain operators; a delete chained after
  // `&&`/`||` must still hit the forced bash_delete confirmation.
  for (const op of ["&&", "||"]) {
    test(`chained Remove-Item after ${op} still asks bash_delete [pwsh]`, async () => {
      await using tmp = await tmpdir({ init: (dir) => Bun.write(path.join(dir, "victim.txt"), "x") })
      const prev = process.env.SHELL
      process.env.SHELL = Bun.which("pwsh.exe")!
      Shell.acceptable.reset()
      try {
        await Instance.provide({
          directory: tmp.path,
          fn: async () => {
            const bash = await runtime.runPromise(BashTool.pipe(Effect.flatMap((info) => info.init())))
            const requests: Array<Omit<Permission.Request, "id" | "sessionID" | "tool">> = []
            await Effect.runPromise(
              bash
                .execute(
                  { command: `Write-Output a ${op} Remove-Item victim.txt`, description: "Chained delete" },
                  ctx(requests),
                )
                .pipe(Effect.catch(() => Effect.void)),
            ).catch(() => {})
            expect(requests.find((r) => r.permission === "bash_delete")).toBeDefined()
            expect(await Bun.file(path.join(tmp.path, "victim.txt")).exists()).toBe(true)
          },
        })
      } finally {
        if (prev === undefined) delete process.env.SHELL
        else process.env.SHELL = prev
        Shell.acceptable.reset()
      }
    }, 30_000)
  }
})

describe.skipIf(!win)("powershell version compat: PowerShell helper processes", () => {
  const stripPowerShell = () => {
    const prev = process.env.PATH
    process.env.PATH = (prev ?? "")
      .split(";")
      .filter((p) => !/WindowsPowerShell/i.test(p))
      .join(";")
    return () => {
      process.env.PATH = prev
    }
  }

  // Case 11: helpers (archive, clipboard, sound, uninstall, upgrade) must find
  // Windows PowerShell even when its directory is missing from PATH (Server Core,
  // trimmed PATH, enterprise images).
  test.skipIf(!Bun.which("pwsh.exe"))("extractZip works when only pwsh is on PATH", async () => {
    await using tmp = await tmpdir()
    const src = path.join(tmp.path, "src")
    await fs.mkdir(src)
    await Bun.write(path.join(src, "a.txt"), "hello")
    const zip = path.join(tmp.path, "a.zip")
    expect(Bun.spawnSync(["tar", "-a", "-c", "-f", zip, "-C", src, "a.txt"]).exitCode).toBe(0)
    const restore = stripPowerShell()
    try {
      expect(which("powershell.exe")).toBeFalsy()
      const out = path.join(tmp.path, "out")
      await extractZip(zip, out)
      expect(await Bun.file(path.join(out, "a.txt")).text()).toBe("hello")
    } finally {
      restore()
    }
  })

  // Case 12: `'` and `[ ]` in archive paths must stay literal (no quoting or
  // wildcard expansion) on every PowerShell version.
  test("extractZip handles quotes and brackets in paths", async () => {
    await using tmp = await tmpdir()
    const dir = path.join(tmp.path, "O'Brien [1]")
    await fs.mkdir(dir)
    await Bun.write(path.join(dir, "a.txt"), "hello")
    const zip = path.join(dir, "a.zip")
    expect(Bun.spawnSync(["tar", "-a", "-c", "-f", zip, "-C", dir, "a.txt"]).exitCode).toBe(0)
    const out = path.join(dir, "out")
    await extractZip(zip, out)
    expect(await Bun.file(path.join(out, "a.txt")).text()).toBe("hello")
  })
})
