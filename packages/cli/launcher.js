#!/usr/bin/env node
// FDS launcher core: detect the one platform target, fetch its binary into
// package-local vendor/, and spawn it. Shared by mimo.js and postinstall.mjs.

import childProcess from "child_process"
import fs from "fs"
import path from "path"
import os from "os"
import { Readable } from "stream"
import { pipeline } from "stream/promises"
import { createHash } from "crypto"
import { fileURLToPath } from "url"

export const DEFAULT_FDS_BASE = "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode"

/** Every target published to FDS / GitHub (matches script/release.ts platforms). */
export const PLATFORMS = [
  "mimocode-linux-arm64",
  "mimocode-linux-x64",
  "mimocode-linux-x64-baseline",
  "mimocode-linux-arm64-musl",
  "mimocode-linux-x64-musl",
  "mimocode-linux-x64-baseline-musl",
  "mimocode-darwin-arm64",
  "mimocode-darwin-x64",
  "mimocode-darwin-x64-baseline",
  "mimocode-windows-arm64",
  "mimocode-windows-x64",
  "mimocode-windows-x64-baseline",
]

export function mapPlatform(value = os.platform()) {
  if (value === "win32") return "windows"
  return value
}

export function mapArch(value = os.arch()) {
  return value
}

export function supportsAvx2(platform = mapPlatform(), arch = mapArch()) {
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
        // try next shell
      }
    }
    return false
  }

  return false
}

export function isMusl(platform = mapPlatform()) {
  if (platform !== "linux") return false
  try {
    if (fs.existsSync("/etc/alpine-release")) return true
  } catch {
    // ignore
  }
  try {
    const result = childProcess.spawnSync("ldd", ["--version"], { encoding: "utf8" })
    const text = ((result.stdout || "") + (result.stderr || "")).toLowerCase()
    return text.includes("musl")
  } catch {
    return false
  }
}

/**
 * Exact target name for this host — one of PLATFORMS.
 * `options.platform` / `options.arch` / `options.avx2` / `options.musl` override detection (tests).
 */
export function detectTarget(options = {}) {
  const platform = options.platform ?? mapPlatform()
  const arch = options.arch ?? mapArch()
  if (platform !== "linux" && platform !== "darwin" && platform !== "windows") {
    throw new Error(`Unsupported platform: ${options.platform ?? os.platform()}`)
  }
  if (arch !== "x64" && arch !== "arm64") {
    throw new Error(`Unsupported architecture: ${options.arch ?? os.arch()}`)
  }

  const avx2 = options.avx2 ?? supportsAvx2(platform, arch)
  const musl = options.musl ?? isMusl(platform)
  const baseline = arch === "x64" && !avx2
  const parts = [platform, arch]
  if (baseline) parts.push("baseline")
  if (musl) parts.push("musl")
  const target = `mimocode-${parts.join("-")}`
  if (!PLATFORMS.includes(target)) {
    throw new Error(`Unsupported target: ${target}`)
  }
  return target
}

export function binaryNameFor(target) {
  return target.includes("windows") ? "mimo.exe" : "mimo"
}

export function archiveNameFor(target) {
  return target.includes("linux") ? `${target}.tar.gz` : `${target}.zip`
}

export function packageRoot(fromDir) {
  return path.resolve(fromDir ?? path.dirname(fileURLToPath(import.meta.url)))
}

export function readVersion(root) {
  const raw = fs.readFileSync(path.join(root, "package.json"), "utf8")
  const version = JSON.parse(raw).version
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid package version: ${version}`)
  }
  return version
}

export function fdsBase() {
  return (process.env.MIMO_FDS_BASE || DEFAULT_FDS_BASE).replace(/\/+$/, "")
}

export function releaseUrl(version, target) {
  return `${fdsBase()}/releases/v${version}/${archiveNameFor(target)}`
}

export function vendorBinaryPath(root, target) {
  return path.join(root, "vendor", binaryNameFor(target))
}

function exec(file, args, options = {}) {
  return new Promise((resolve, reject) => {
    const child = childProcess.spawn(file, args, { stdio: ["ignore", "pipe", "pipe"], ...options })
    let stdout = ""
    let stderr = ""
    child.stdout?.on("data", (chunk) => {
      stdout += chunk
    })
    child.stderr?.on("data", (chunk) => {
      stderr += chunk
    })
    child.on("error", reject)
    child.on("close", (code) => {
      if (code === 0) resolve({ stdout, stderr })
      else reject(new Error(`${file} ${args.join(" ")} failed with code ${code}: ${stderr || stdout}`))
    })
  })
}

async function downloadTo(url, dest, { timeoutMs = 15 * 60_000 } = {}) {
  // Large platform archives (~100MB+); a short whole-body timeout aborts slow
  // but healthy first-run downloads.
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok || !res.body) {
    throw new Error(`FDS download failed ${res.status} for ${url}`)
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
}

async function verifySha256(filePath, url) {
  // Optional check: enforce only when a well-formed checksum is published.
  // Missing/erroring *.sha256 must not brick first-run (FDS may not 404).
  const checksumUrl = `${url}.sha256`
  let expected
  try {
    const res = await fetch(checksumUrl, { signal: AbortSignal.timeout(60_000) })
    if (!res.ok) return false
    const text = (await res.text()).trim().split(/\s+/)[0]
    if (!/^[a-f0-9]{64}$/i.test(text)) return false
    expected = text.toLowerCase()
  } catch {
    return false
  }

  const hash = createHash("sha256")
  await pipeline(fs.createReadStream(filePath), hash)
  const actual = hash.digest("hex")
  if (actual !== expected) {
    throw new Error(`Checksum mismatch for ${url}: expected ${expected}, got ${actual}`)
  }
  return true
}

async function extractBinary(archivePath, target, dest) {
  const name = binaryNameFor(target)
  const work = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mimocode-extract-"))
  try {
    if (target.includes("linux")) {
      await exec("tar", ["-xzf", archivePath, "-C", work])
    } else {
      // bsdtar / macOS tar / Windows tar all handle zip.
      await exec("tar", ["-xf", archivePath, "-C", work])
    }
    const extracted = path.join(work, name)
    if (!fs.existsSync(extracted)) {
      throw new Error(`Archive ${path.basename(archivePath)} is missing ${name}`)
    }
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.copyFile(extracted, dest)
    await fs.promises.chmod(dest, 0o755)
  } finally {
    await fs.promises.rm(work, { recursive: true, force: true })
  }
}

/**
 * Ensure the vendor binary exists under `root`. Downloads exactly one FDS
 * archive for this host when missing. Returns the absolute binary path.
 */
export async function ensureBinary(options = {}) {
  const root = options.root || packageRoot()
  const target = options.target || detectTarget()
  const version = options.version || readVersion(root)
  const dest = options.dest || vendorBinaryPath(root, target)
  const url = options.url || releaseUrl(version, target)
  const log = options.log || (() => {})

  if (fs.existsSync(dest)) return dest

  const archiveName = archiveNameFor(target)
  // Unique partial per attempt so concurrent first-runs do not clobber each other.
  const partial = `${dest}.partial.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mimocode-fetch-"))
  const archivePath = path.join(tmpDir, archiveName)
  try {
    log(`Downloading mimo ${version} (${target}) from FDS…`)
    await downloadTo(url, archivePath)
    await verifySha256(archivePath, url)
    await extractBinary(archivePath, target, partial)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    try {
      await fs.promises.rename(partial, dest)
    } catch (error) {
      // Windows rename fails if dest exists — another first-run won the race.
      if (fs.existsSync(dest)) {
        await fs.promises.rm(partial, { force: true })
        return dest
      }
      throw error
    }
    log(`Installed ${dest}`)
    return dest
  } finally {
    await fs.promises.rm(partial, { force: true })
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
}

export function runBinary(targetPath, args = process.argv.slice(2)) {
  const result = childProcess.spawnSync(targetPath, args, { stdio: "inherit" })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  if (typeof result.status === "number") {
    process.exit(result.status)
  }
  // Killed by a signal — propagate a non-zero code instead of looking clean.
  process.exit(result.signal ? 1 : 0)
}

/**
 * Windows locks a running PE. Executing vendor/mimo.exe in place would block
 * `npm uninstall`/`upgrade` from deleting the package directory. Copy the
 * binary out to %TEMP% once per version and run that; vendor/ stays deletable.
 */
export function stageWindowsRunCopy(sourcePath, version) {
  if (process.platform !== "win32") return sourcePath
  const dir = path.join(os.tmpdir(), "mimocode-bin", version || "dev")
  const runPath = path.join(dir, path.basename(sourcePath))
  try {
    const sourceStat = fs.statSync(sourcePath)
    let reuse = false
    try {
      const destStat = fs.statSync(runPath)
      // mtime+size: catch a replaced vendor binary of the same length.
      reuse = destStat.size === sourceStat.size && destStat.mtimeMs >= sourceStat.mtimeMs
    } catch {
      reuse = false
    }
    if (!reuse) {
      fs.mkdirSync(dir, { recursive: true })
      const tmp = `${runPath}.tmp.${process.pid}.${Math.random().toString(36).slice(2, 8)}`
      fs.copyFileSync(sourcePath, tmp)
      fs.chmodSync(tmp, 0o755)
      try {
        fs.renameSync(tmp, runPath)
      } catch {
        // Concurrent winner already placed runPath.
        fs.rmSync(tmp, { force: true })
        if (!fs.existsSync(runPath)) throw new Error(`failed to stage ${runPath}`)
      }
    }
    return runPath
  } catch {
    // Fall back to running the package file (may block uninstall while running).
    return sourcePath
  }
}
