import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem, Log } from "@/util"
import { which } from "@/util/which"
import path from "path"
import { lstatSync } from "fs"
import { execFile, spawn, type ChildProcess } from "child_process"
import { setTimeout as sleep } from "node:timers/promises"
import { childProcessEnv } from "@/util/child-process-env"

const log = Log.create({ service: "shell" })

const SIGKILL_TIMEOUT_MS = 200

const BLACKLIST = new Set(["fish", "nu"])
const LOGIN = new Set(["bash", "dash", "fish", "ksh", "sh", "zsh"])
const POSIX = new Set(["bash", "dash", "ksh", "sh", "zsh"])

export async function killTree(proc: ChildProcess, opts?: { exited?: () => boolean }): Promise<void> {
  const pid = proc.pid
  if (!pid || opts?.exited?.()) return

  if (process.platform === "win32") {
    await new Promise<void>((resolve) => {
      const killer = spawn("taskkill", ["/pid", String(pid), "/f", "/t"], {
        stdio: "ignore",
        windowsHide: true,
        env: childProcessEnv(),
      })
      killer.once("exit", () => resolve())
      killer.once("error", () => resolve())
    })
    return
  }

  try {
    process.kill(-pid, "SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      process.kill(-pid, "SIGKILL")
    }
  } catch (_e) {
    proc.kill("SIGTERM")
    await sleep(SIGKILL_TIMEOUT_MS)
    if (!opts?.exited?.()) {
      proc.kill("SIGKILL")
    }
  }
}

// lstat: Microsoft Store execution aliases are reparse points that stat() rejects with EACCES.
function present(file: string) {
  try {
    const info = lstatSync(file, { throwIfNoEntry: false })
    return info !== undefined && !info.isDirectory()
  } catch {
    return false
  }
}

// PowerShell 7 from the Microsoft Store is reachable only through an execution
// alias, which which() skips because it cannot stat it.
function storePwsh() {
  const root = process.env.LOCALAPPDATA
  const file = root ? path.join(root, "Microsoft", "WindowsApps", "pwsh.exe") : undefined
  return file && present(file) ? file : undefined
}

// MSYS2/Cygwin-style /usr/bin/<shell> or /bin/<shell> paths, mapped onto the Git for
// Windows, MSYS2 or Cygwin installation that ships that shell.
function msys(shell: string) {
  const bash = name(shell) === "bash" ? gitbash() : undefined
  if (bash) return bash
  const git = which("git")
  const drive = `${process.env.SystemDrive || "C:"}${path.sep}`
  const roots = [
    ...(git ? [path.join(git, "..", "..")] : []),
    path.join(drive, "msys64"),
    path.join(drive, "cygwin64"),
    path.join(drive, "cygwin"),
  ]
  return roots
    .flatMap((root) => [path.join(root, "usr", "bin"), path.join(root, "bin")])
    .map((dir) => path.join(dir, `${name(shell)}.exe`))
    .find(present)
}

// On Windows $SHELL is inherited from Git Bash/MSYS2/Cygwin terminals or set by hand and
// may name a POSIX path or a stale file; returns undefined when it names nothing runnable.
function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = Filesystem.windowsPath(file)
  if (path.win32.dirname(shell) === ".") return which(shell) ?? (name(shell) === "pwsh" ? storePwsh() : undefined)
  if (present(shell)) return shell
  // CreateProcess appends .exe to an extensionless path, so e.g. C:/msys64/usr/bin/bash is valid.
  if (!path.win32.extname(shell) && present(`${shell}.exe`)) return `${shell}.exe`
  return shell.startsWith("/") ? msys(shell) : undefined
}

function pick() {
  return which("pwsh.exe") ?? storePwsh() ?? which("powershell.exe") ?? undefined
}

function select(file: string | undefined, opts?: { acceptable?: boolean }) {
  if (file && (!opts?.acceptable || !BLACKLIST.has(name(file)))) {
    const shell = full(file)
    if (shell) return shell
    log.warn("ignoring SHELL that does not resolve to an executable", { shell: file })
  }
  if (process.platform === "win32") {
    const shell = pick()
    if (shell) return shell
  }
  return fallback()
}

export function gitbash() {
  if (process.platform !== "win32") return
  if (Flag.MIMOCODE_GIT_BASH_PATH) return Flag.MIMOCODE_GIT_BASH_PATH
  const git = which("git")
  if (!git) return
  const file = path.join(git, "..", "..", "bin", "bash.exe")
  if (Filesystem.stat(file)?.size) return file
}

function fallback() {
  if (process.platform === "win32") {
    const file = gitbash()
    if (file) return file
    return process.env.COMSPEC || "cmd.exe"
  }
  if (process.platform === "darwin") return "/bin/zsh"
  const bash = which("bash")
  if (bash) return bash
  return "/bin/sh"
}

export function name(file: string) {
  if (process.platform === "win32") return path.win32.parse(Filesystem.windowsPath(file)).name.toLowerCase()
  return path.basename(file).toLowerCase()
}

export function login(file: string) {
  return LOGIN.has(name(file))
}

export function posix(file: string) {
  return POSIX.has(name(file))
}

export const preferred = lazy(() => select(process.env.SHELL))

export const acceptable = lazy(() => select(process.env.SHELL, { acceptable: true }))

// On non-UTF-8 Windows locales (e.g. zh-CN ACP 936/GBK) shell subprocesses emit
// output in the legacy code page, which we decode as UTF-8 → mojibake.

// The command arrives through MIMO_PS_COMMAND instead of being spliced into
// -Command, so this setup still runs when the command has a parse error and error
// records only quote the user's text. -Command itself reports just 0/1, so the tail
// maps the last statement's outcome to an exit code.
const POWERSHELL_BOOTSTRAP = [
  "$__mimoCommand = $env:MIMO_PS_COMMAND",
  "Remove-Item Env:MIMO_PS_COMMAND -ErrorAction Ignore",
  // Constrained Language Mode forbids the type/method calls below; $? is always true after
  // Invoke-Expression, so new error records stand in for failure there.
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { $__mimoErrors = $Error.Count; $global:LASTEXITCODE = 0; Invoke-Expression $__mimoCommand; if ($LASTEXITCODE) { exit $LASTEXITCODE }; if ($Error.Count -gt $__mimoErrors) { exit 1 }; exit 0 }",
  // Separate trys so one failing setter (e.g. no console attached) does not skip the others.
  // InputEncoding too: Windows PowerShell 5.1 otherwise prefixes text piped to native commands with a BOM.
  "$__mimoUtf8 = [System.Text.UTF8Encoding]::new($false)",
  "try { $OutputEncoding = $__mimoUtf8 } catch {}",
  "try { [Console]::OutputEncoding = $__mimoUtf8 } catch {}",
  "try { [Console]::InputEncoding = $__mimoUtf8 } catch {}",
  "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
  // 5.1 writes UTF-16 (`>`) or the ANSI code page (Set-Content) by default.
  "if ($PSVersionTable.PSVersion.Major -lt 6) { foreach ($__c in 'Out-File', 'Set-Content', 'Add-Content') { $PSDefaultParameterValues[\"${__c}:Encoding\"] = 'utf8' } }",
  "$global:LASTEXITCODE = 0",
  // Parse the command alone first so a parse error never quotes the appended `$?` capture.
  "try { $__mimoParsed = [ScriptBlock]::Create($__mimoCommand); $__mimoBlock = [ScriptBlock]::Create($__mimoCommand + [Environment]::NewLine + '$__mimoOk = $?') } catch { $__e = $_.Exception; if ($__e.InnerException) { $__e = $__e.InnerException }; [Console]::Error.WriteLine($__e.Message); exit 1 }",
  ". $__mimoBlock",
  "if ($__mimoOk -ne $false) { exit 0 }",
  // $LASTEXITCODE belongs to the last statement only if that statement ran an external
  // program; otherwise it may be left over from an earlier command. Unresolvable names
  // (e.g. `& $exe`) count as external.
  "$__mimoLast = if ($__mimoParsed.Ast.EndBlock) { $__mimoParsed.Ast.EndBlock.Statements | Select-Object -Last 1 }",
  "$__mimoNative = @(if ($__mimoLast) { $__mimoLast.FindAll({ param($n) $n -is [System.Management.Automation.Language.CommandAst] }, $true) | Where-Object { $__n = $_.GetCommandName(); $__r = if ($__n) { Get-Command $__n -ErrorAction Ignore | Select-Object -First 1 }; if ($__r.CommandType -eq 'Alias') { $__r = $__r.ResolvedCommand }; -not $__r -or $__r.CommandType -eq 'Application' } }).Count -gt 0",
  "if ($__mimoNative -and $LASTEXITCODE) { exit $LASTEXITCODE }",
  // Before pwsh 7.2, `native 2>&1` marks a successful command as failed once it writes to stderr.
  "if ($__mimoNative -and $Error.Count -and \"$($Error[0].FullyQualifiedErrorId)\" -like 'NativeCommandError*') { exit 0 }",
  "exit 1",
].join("; ")

export function powershell(command: string) {
  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_BOOTSTRAP],
    // pwsh 7.2-7.5 decide on ANSI error colouring at startup and ignore a later $PSStyle.OutputRendering.
    env: { MIMO_PS_COMMAND: command, TERM: "dumb" },
  }
}

const versions = new Map<string, string>()
const probes = new Map<string, Promise<string | undefined>>()

// Windows PowerShell is always 5.1 on supported Windows; pwsh versions come from
// probePowershellVersion() and are undefined until a probe has succeeded.
export function powershellVersion(file: string) {
  if (name(file) === "powershell") return "5.1"
  return versions.get(file)
}

// Async so a cold pwsh start does not block the event loop. Failures are not cached,
// so a later call retries instead of pinning an unknown version for the process.
export function probePowershellVersion(file: string): Promise<string | undefined> {
  const known = powershellVersion(file)
  if (known) return Promise.resolve(known)
  const pending = probes.get(file)
  if (pending) return pending
  const probe = new Promise<string | undefined>((resolve) => {
    execFile(
      file,
      ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"],
      { encoding: "utf8", timeout: 10_000, windowsHide: true, env: childProcessEnv() },
      (_error, stdout) => resolve(/^\d+\.\d+(\.\d+)?/.exec(stdout?.trim() ?? "")?.[0]),
    ).stdin?.end()
  }).then((version) => {
    probes.delete(file)
    if (version) versions.set(file, version)
    return version
  })
  probes.set(file, probe)
  return probe
}

// cmd.exe: switch the code page to 65001. `&` (not `&&`) so the user command's
// exit code is preserved and a chcp failure doesn't block it; redirect both
// stdout and stderr so chcp output never pollutes the result.
export const CMD_UTF8_PREFIX = "chcp 65001 >nul 2>nul & "

export * as Shell from "./shell"
