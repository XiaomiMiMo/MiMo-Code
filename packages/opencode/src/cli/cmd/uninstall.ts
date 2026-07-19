import type { Argv } from "yargs"
import { UI } from "../ui"
import * as prompts from "@clack/prompts"
import { AppRuntime } from "@/effect/app-runtime"
import { Installation } from "../../installation"
import { Global } from "../../global"
import fs from "fs/promises"
import path from "path"
import os from "os"
import { Filesystem } from "../../util"
import { Process } from "../../util"

interface UninstallArgs {
  keepConfig: boolean
  keepData: boolean
  dryRun: boolean
  force: boolean
}

interface RemovalTargets {
  directories: Array<{ path: string; label: string; keep: boolean }>
  shellConfig: string | null
  binary: string | null
}

export const UninstallCommand = {
  command: "uninstall",
  describe: "uninstall mimocode and remove all related files",
  builder: (yargs: Argv) =>
    yargs
      .option("keep-config", {
        alias: "c",
        type: "boolean",
        describe: "keep configuration files",
        default: false,
      })
      .option("keep-data", {
        alias: "d",
        type: "boolean",
        describe: "keep session data and snapshots",
        default: false,
      })
      .option("dry-run", {
        type: "boolean",
        describe: "show what would be removed without removing",
        default: false,
      })
      .option("force", {
        alias: "f",
        type: "boolean",
        describe: "skip confirmation prompts",
        default: false,
      }),

  handler: async (args: UninstallArgs) => {
    UI.empty()
    UI.println(UI.logo("  "))
    UI.empty()
    prompts.intro("Uninstall MiMoCode")

    const method = await AppRuntime.runPromise(Installation.Service.use((svc) => svc.method()))
    prompts.log.info(`Installation method: ${method}`)

    const targets = await collectRemovalTargets(args, method)

    await showRemovalSummary(targets, method)

    if (!args.force && !args.dryRun) {
      const confirm = await prompts.confirm({
        message: "Are you sure you want to uninstall?",
        initialValue: false,
      })
      if (!confirm || prompts.isCancel(confirm)) {
        prompts.outro("Cancelled")
        return
      }
    }

    if (args.dryRun) {
      prompts.log.warn("Dry run - no changes made")
      prompts.outro("Done")
      return
    }

    await executeUninstall(method, targets)

    prompts.outro("Done")
  },
}

async function collectRemovalTargets(args: UninstallArgs, method: Installation.Method): Promise<RemovalTargets> {
  const directories: RemovalTargets["directories"] = [
    { path: Global.Path.data, label: "Data", keep: args.keepData },
    { path: Global.Path.cache, label: "Cache", keep: false },
    { path: Global.Path.config, label: "Config", keep: args.keepConfig },
    { path: Global.Path.state, label: "State", keep: false },
  ]

  const shellConfig = method === "curl" && process.platform !== "win32" ? await getShellConfigFile() : null
  const binary = method === "curl" ? process.execPath : null

  return { directories, shellConfig, binary }
}

async function showRemovalSummary(targets: RemovalTargets, method: Installation.Method) {
  prompts.log.message("The following will be removed:")

  for (const dir of targets.directories) {
    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const size = await getDirectorySize(dir.path)
    const sizeStr = formatSize(size)
    const status = dir.keep ? UI.Style.TEXT_DIM + "(keeping)" : ""
    const prefix = dir.keep ? "○" : "✓"

    prompts.log.info(`  ${prefix} ${dir.label}: ${shortenPath(dir.path)} ${UI.Style.TEXT_DIM}(${sizeStr})${status}`)
  }

  if (targets.binary) {
    prompts.log.info(`  ✓ Binary: ${shortenPath(targets.binary)}`)
  }

  if (targets.shellConfig) {
    prompts.log.info(`  ✓ Shell PATH in ${shortenPath(targets.shellConfig)}`)
  }

  if (method === "curl" && process.platform === "win32") {
    prompts.log.info(`  ✓ User PATH (registry)`)
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string> = {
      npm: "npm uninstall -g @mimo-ai/cli",
      pnpm: "pnpm uninstall -g @mimo-ai/cli",
      bun: "bun remove -g @mimo-ai/cli",
      // TODO(mimocode): uncomment when published to these channels
      // brew: "brew uninstall mimocode",
      // choco: "choco uninstall mimocode",
      // scoop: "scoop uninstall mimocode",
    }
    prompts.log.info(`  ✓ Package: ${cmds[method] || method}`)
  }
}

async function executeUninstall(method: Installation.Method, targets: RemovalTargets) {
  const spinner = prompts.spinner()
  const errors: string[] = []

  for (const dir of targets.directories) {
    if (dir.keep) {
      prompts.log.step(`Skipping ${dir.label} (--keep-${dir.label.toLowerCase()})`)
      continue
    }

    const exists = await fs
      .access(dir.path)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    spinner.start(`Removing ${dir.label}...`)
    const err = await fs.rm(dir.path, { recursive: true, force: true }).catch((e) => e)
    if (err) {
      spinner.stop(`Failed to remove ${dir.label}`, 1)
      errors.push(`${dir.label}: ${err.message}`)
      continue
    }
    spinner.stop(`Removed ${dir.label}`)
  }

  if (targets.shellConfig) {
    spinner.start("Cleaning shell config...")
    const err = await cleanShellConfig(targets.shellConfig).catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean shell config", 1)
      errors.push(`Shell config: ${err.message}`)
    } else {
      spinner.stop("Cleaned shell config")
    }
  }

  if (method === "curl" && process.platform === "win32") {
    spinner.start("Cleaning User PATH...")
    const err = await cleanWindowsPath().catch((e) => e)
    if (err) {
      spinner.stop("Failed to clean User PATH", 1)
      errors.push(`User PATH: ${err.message}`)
    } else {
      spinner.stop("Cleaned User PATH")
    }
  }

  if (method !== "curl" && method !== "unknown") {
    const cmds: Record<string, string[]> = {
      npm: ["npm", "uninstall", "-g", "@mimo-ai/cli"],
      pnpm: ["pnpm", "uninstall", "-g", "@mimo-ai/cli"],
      bun: ["bun", "remove", "-g", "@mimo-ai/cli"],
      // TODO(mimocode): uncomment when published to these channels
      // brew: ["brew", "uninstall", "mimocode"],
      // choco: ["choco", "uninstall", "mimocode"],
      // scoop: ["scoop", "uninstall", "mimocode"],
    }

    const cmd = cmds[method]
    if (cmd) {
      spinner.start(`Running ${cmd.join(" ")}...`)
      const result = await Process.run(cmd, {
        nothrow: true,
      })
      if (result.code !== 0) {
        spinner.stop(`Package manager uninstall failed: exit code ${result.code}`, 1)
        prompts.log.warn(`You may need to run manually: ${cmd.join(" ")}`)
      } else {
        spinner.stop("Package removed")
      }
    } else {
      prompts.log.warn(`Uninstall not supported for method "${method}" yet, skipping package removal`)
    }
  }

  if (method === "curl" && targets.binary) {
    UI.empty()
    prompts.log.message("To finish removing the binary, run:")
    prompts.log.info(`  rm "${targets.binary}"`)

    const binDir = path.dirname(targets.binary)
    if (binDir.includes(".mimocode")) {
      prompts.log.info(`  rmdir "${binDir}" 2>/dev/null`)
    }
  }

  if (errors.length > 0) {
    UI.empty()
    prompts.log.warn("Some operations failed:")
    for (const err of errors) {
      prompts.log.error(`  ${err}`)
    }
  }

  UI.empty()
  prompts.log.success("Thank you for using MiMoCode!")
}

async function getShellConfigFile(): Promise<string | null> {
  const shell = path.basename(process.env.SHELL || "bash")
  const home = os.homedir()
  const xdgConfig = process.env.XDG_CONFIG_HOME || path.join(home, ".config")

  const configFiles: Record<string, string[]> = {
    fish: [path.join(xdgConfig, "fish", "config.fish")],
    zsh: [
      path.join(home, ".zshrc"),
      path.join(home, ".zshenv"),
      path.join(xdgConfig, "zsh", ".zshrc"),
      path.join(xdgConfig, "zsh", ".zshenv"),
    ],
    bash: [
      path.join(home, ".bashrc"),
      path.join(home, ".bash_profile"),
      path.join(home, ".profile"),
      path.join(xdgConfig, "bash", ".bashrc"),
      path.join(xdgConfig, "bash", ".bash_profile"),
    ],
    ash: [path.join(home, ".ashrc"), path.join(home, ".profile")],
    sh: [path.join(home, ".profile")],
  }

  const candidates = configFiles[shell] || configFiles.bash

  for (const file of candidates) {
    const exists = await fs
      .access(file)
      .then(() => true)
      .catch(() => false)
    if (!exists) continue

    const content = await Filesystem.readText(file).catch(() => "")
    if (content.includes("# mimocode") || content.includes(".mimocode/bin")) {
      return file
    }
  }

  return null
}

async function cleanShellConfig(file: string) {
  const content = await Filesystem.readText(file)
  const lines = content.split("\n")

  const filtered: string[] = []
  let skip = false

  for (const line of lines) {
    const trimmed = line.trim()

    if (trimmed === "# mimocode") {
      skip = true
      continue
    }

    if (skip) {
      skip = false
      if (trimmed.includes(".mimocode/bin") || trimmed.includes("fish_add_path")) {
        continue
      }
    }

    if (
      (trimmed.startsWith("export PATH=") && trimmed.includes(".mimocode/bin")) ||
      (trimmed.startsWith("fish_add_path") && trimmed.includes(".mimocode"))
    ) {
      continue
    }

    filtered.push(line)
  }

  while (filtered.length > 0 && filtered[filtered.length - 1].trim() === "") {
    filtered.pop()
  }

  const output = filtered.join("\n") + "\n"
  await Filesystem.write(file, output)
}

async function getDirectorySize(dir: string): Promise<number> {
  let total = 0

  const walk = async (current: string) => {
    const entries = await fs.readdir(current, { withFileTypes: true }).catch(() => [])

    for (const entry of entries) {
      const full = path.join(current, entry.name)
      if (entry.isDirectory()) {
        await walk(full)
        continue
      }
      if (entry.isFile()) {
        const stat = await fs.stat(full).catch(() => null)
        if (stat) total += stat.size
      }
    }
  }

  await walk(dir)
  return total
}

function formatSize(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(1)} GB`
}

function shortenPath(p: string): string {
  const home = os.homedir()
  if (p.startsWith(home)) {
    return p.replace(home, "~")
  }
  return p
}

async function cleanWindowsPath() {
  const installDir = path.join(os.homedir(), ".mimocode", "bin")
  const script = `
    $installDir = $env:MIMOCODE_UNINSTALL_DIR
    $userPath = [Environment]::GetEnvironmentVariable('PATH', 'User')
    if ($userPath -and $userPath -like "*$installDir*") {
      $newPath = ($userPath -split ';' | Where-Object { $_ -ne $installDir }) -join ';'
      [Environment]::SetEnvironmentVariable('PATH', $newPath, 'User')
    }
  `
  const result = await Process.run(["powershell", "-ep", "Bypass", "-c", script], {
    nothrow: true,
    env: { ...process.env, MIMOCODE_UNINSTALL_DIR: installDir },
  })
  if (result.code !== 0) throw new Error(result.stderr.toString() || "Failed to clean User PATH")
}
