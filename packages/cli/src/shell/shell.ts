import { Flag } from "@/flag/flag"
import { lazy } from "@/util/lazy"
import { Filesystem, Log } from "@/util"
import { which } from "@/util/which"
import path from "path"
import { lstatSync } from "fs"
import { spawn, spawnSync, type ChildProcess } from "child_process"
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

// MSYS2/Cygwin-style /usr/bin/<shell> paths; Git for Windows ships some of these shells.
function msys(shell: string) {
  if (name(shell) === "bash") return gitbash()
  const git = which("git")
  const file = git ? path.join(git, "..", "..", "usr", "bin", `${name(shell)}.exe`) : undefined
  return file && present(file) ? file : undefined
}

// On Windows $SHELL is inherited from Git Bash/MSYS2/Cygwin terminals or set by hand and
// may name a POSIX path or a stale file; returns undefined when it names nothing runnable.
function full(file: string) {
  if (process.platform !== "win32") return file
  const shell = Filesystem.windowsPath(file)
  if (path.win32.dirname(shell) === ".") return which(shell) ?? (name(shell) === "pwsh" ? storePwsh() : undefined)
  if (present(shell)) return shell
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
// maps the last statement's outcome to the native exit code.
const POWERSHELL_BOOTSTRAP = [
  "$__mimoCommand = $env:MIMO_PS_COMMAND",
  "Remove-Item Env:MIMO_PS_COMMAND -ErrorAction Ignore",
  // Constrained Language Mode forbids the type/method calls below.
  "if ($ExecutionContext.SessionState.LanguageMode -ne 'FullLanguage') { Invoke-Expression $__mimoCommand; exit $LASTEXITCODE }",
  // InputEncoding too: Windows PowerShell 5.1 otherwise prefixes text piped to native commands with a BOM.
  "try { $OutputEncoding = [Console]::OutputEncoding = [Console]::InputEncoding = [System.Text.UTF8Encoding]::new($false) } catch {}",
  "if ($PSStyle) { $PSStyle.OutputRendering = 'PlainText' }",
  // 5.1 writes UTF-16 (`>`) or the ANSI code page (Set-Content) by default, and aliases curl/wget to Invoke-WebRequest.
  "if ($PSVersionTable.PSVersion.Major -lt 6) { foreach ($__c in 'Out-File', 'Set-Content', 'Add-Content') { $PSDefaultParameterValues[\"${__c}:Encoding\"] = 'utf8' }; if (Get-Command curl.exe -CommandType Application -ErrorAction Ignore) { Remove-Item Alias:curl, Alias:wget -Force -ErrorAction Ignore } }",
  "$global:LASTEXITCODE = 0",
  // Parse the command alone first so a parse error never quotes the appended `$?` capture.
  "try { [void][ScriptBlock]::Create($__mimoCommand); $__mimoBlock = [ScriptBlock]::Create($__mimoCommand + [Environment]::NewLine + '$__mimoOk = $?') } catch { $__e = $_.Exception; if ($__e.InnerException) { $__e = $__e.InnerException }; [Console]::Error.WriteLine($__e.Message); exit 1 }",
  ". $__mimoBlock",
  "if ($__mimoOk -ne $false) { exit 0 }",
  "if ($LASTEXITCODE) { exit $LASTEXITCODE }",
  // Before pwsh 7.2, `native 2>&1` marks a successful command as failed once it writes to stderr.
  "if ($Error.Count -and \"$($Error[0].FullyQualifiedErrorId)\" -like 'NativeCommandError*') { exit 0 }",
  "exit 1",
].join("; ")

export function powershell(command: string) {
  return {
    args: ["-NoLogo", "-NoProfile", "-NonInteractive", "-ExecutionPolicy", "Bypass", "-Command", POWERSHELL_BOOTSTRAP],
    // pwsh 7.2-7.5 decide on ANSI error colouring at startup and ignore a later $PSStyle.OutputRendering.
    env: { MIMO_PS_COMMAND: command, TERM: "dumb" },
  }
}

const versions = new Map<string, string | undefined>()

// Windows PowerShell is always 5.1 on supported Windows; pwsh is probed once per path.
export function powershellVersion(file: string) {
  if (name(file) === "powershell") return "5.1"
  if (versions.has(file)) return versions.get(file)
  const result = spawnSync(file, ["-NoLogo", "-NoProfile", "-NonInteractive", "-Command", "$PSVersionTable.PSVersion.ToString()"], {
    encoding: "utf8",
    timeout: 10_000,
    windowsHide: true,
    stdio: ["ignore", "pipe", "ignore"],
    env: childProcessEnv(),
  })
  const version = /^\d+\.\d+(\.\d+)?/.exec(result.stdout?.trim() ?? "")?.[0]
  versions.set(file, version)
  return version
}

// cmd.exe: switch the code page to 65001. `&` (not `&&`) so the user command's
// exit code is preserved and a chcp failure doesn't block it; redirect both
// stdout and stderr so chcp output never pollutes the result.
export const CMD_UTF8_PREFIX = "chcp 65001 >nul 2>nul & "

export * as Shell from "./shell"
