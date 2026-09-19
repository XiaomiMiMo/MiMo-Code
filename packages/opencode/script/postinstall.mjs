#!/usr/bin/env node

import fs from "fs"
import path from "path"
import os from "os"
import childProcess from "child_process"
import { fileURLToPath } from "url"
import { createRequire } from "module"

const __dirname = path.dirname(fileURLToPath(import.meta.url))
const require = createRequire(import.meta.url)

function detectPlatformAndArch() {
  // Map platform names
  let platform
  switch (os.platform()) {
    case "darwin":
      platform = "darwin"
      break
    case "linux":
      platform = "linux"
      break
    case "win32":
      platform = "windows"
      break
    default:
      platform = os.platform()
      break
  }

  // Map architecture names
  let arch
  switch (os.arch()) {
    case "x64":
      arch = "x64"
      break
    case "arm64":
      arch = "arm64"
      break
    case "arm":
      arch = "arm"
      break
    default:
      arch = os.arch()
      break
  }

  return { platform, arch }
}

function supportsAvx2(platform, arch) {
  if (arch !== "x64") return false

  if (platform === "linux") {
    try {
      return /(^|\s)avx2(\s|$)/i.test(fs.readFileSync("/proc/cpuinfo", "utf8"))
    } catch {
      return false
    }
  }

  if (platform === "darwin") {
    try {
      const result = childProcess.spawnSync("sysctl", ["-n", "hw.optional.avx2_0"], {
        encoding: "utf8",
        timeout: 1500,
      })
      if (result.status !== 0) return false
      return (result.stdout || "").trim() === "1"
    } catch {
      return false
    }
  }

  if (platform === "windows") {
    const cmd =
      '(Add-Type -MemberDefinition "[DllImport(""kernel32.dll"")] public static extern bool IsProcessorFeaturePresent(int ProcessorFeature);" -Name Kernel32 -Namespace Win32 -PassThru)::IsProcessorFeaturePresent(40)'

    for (const exe of ["powershell.exe", "pwsh.exe", "pwsh", "powershell"]) {
      try {
        const result = childProcess.spawnSync(exe, ["-NoProfile", "-NonInteractive", "-Command", cmd], {
          encoding: "utf8",
          timeout: 3000,
          windowsHide: true,
        })
        if (result.status !== 0) continue
        const out = (result.stdout || "").trim().toLowerCase()
        if (out === "true" || out === "1") return true
        if (out === "false" || out === "0") return false
      } catch {
        continue
      }
    }

    return false
  }

  return false
}

function findBinary() {
  const { platform, arch } = detectPlatformAndArch()
  const binaryName = platform === "windows" ? "mimo.exe" : "mimo"
  const avx2 = supportsAvx2(platform, arch)
  const baseline = arch === "x64" && !avx2

  const packageNames = (() => {
    if (platform === "linux") {
      const musl = (() => {
        try {
          if (fs.existsSync("/etc/alpine-release")) return true
        } catch {}
        try {
          const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
          const text = ((result.stdout || "") + (result.stderr || "")).toLowerCase()
          if (text.includes("musl")) return true
        } catch {}
        return false
      })()
      const base = `@mimo-ai/mimocode-${platform}-${arch}`
      if (musl) {
        if (arch === "x64") {
          if (baseline) return [`${base}-baseline-musl`, `${base}-musl`, `${base}-baseline`, base]
          return [`${base}-musl`, `${base}-baseline-musl`, base, `${base}-baseline`]
        }
        return [`${base}-musl`, base]
      }
      if (arch === "x64") {
        if (baseline) return [`${base}-baseline`, base, `${base}-baseline-musl`, `${base}-musl`]
        return [base, `${base}-baseline`, `${base}-musl`, `${base}-baseline-musl`]
      }
      return [base, `${base}-musl`]
    }
    const base = `@mimo-ai/mimocode-${platform}-${arch}`
    if (arch === "x64") {
      if (baseline) return [`${base}-baseline`, base]
      return [base, `${base}-baseline`]
    }
    return [base]
  })()

  for (const packageName of packageNames) {
    try {
      const packageJsonPath = require.resolve(`${packageName}/package.json`)
      const packageDir = path.dirname(packageJsonPath)
      const binaryPath = path.join(packageDir, "bin", binaryName)
      if (fs.existsSync(binaryPath)) {
        return { binaryPath, binaryName }
      }
    } catch {}
  }

  throw new Error(`Could not find any compatible binary package. Tried: ${packageNames.join(", ")}`)
}

function printMigrationNotice() {
  const install = os.platform() === "win32"
    ? "irm https://mimo.xiaomi.com/install.ps1 | iex"
    : "curl -fsSL https://mimo.xiaomi.com/install | bash"
  console.log()
  console.log("  Recommended: install MiMoCode natively for a better install and upgrade experience:")
  console.log(`    ${install}`)
  console.log()
}

async function main() {
  printMigrationNotice()

  if (os.platform() === "win32") {
    // On Windows the bin/mimo wrapper finds the binary via node_modules traversal.
    // Skipping the .mimocode cache avoids creating an extensionless PE file that
    // may trigger antivirus false-positives.
    return
  }

  try {
    const { binaryPath } = findBinary()
    const target = path.join(__dirname, "bin", ".mimocode")
    if (fs.existsSync(target)) fs.unlinkSync(target)
    try {
      fs.linkSync(binaryPath, target)
    } catch {
      fs.copyFileSync(binaryPath, target)
    }
    fs.chmodSync(target, 0o755)
  } catch (error) {
    console.error("Failed to setup mimocode binary:", error.message)
    process.exit(1)
  }
}

try {
  void main()
} catch (error) {
  console.error("Postinstall script error:", error.message)
  process.exit(0)
}
