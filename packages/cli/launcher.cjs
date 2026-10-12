#!/usr/bin/env node
// FDS launcher core: detect the one platform target, fetch its binary into
// package-local vendor/, and spawn it. Shared by bin/mimo and postinstall.mjs.
// CommonJS so both the bin wrapper (require) and postinstall (createRequire) can load it.

const childProcess = require("child_process")
const fs = require("fs")
const path = require("path")
const os = require("os")
const { Readable } = require("stream")
const { pipeline } = require("stream/promises")
const { createHash } = require("crypto")

const DEFAULT_FDS_BASE = "https://mimocode.cnbj1.mi-fds.com/mimocode/mimocode"

/** Every target published to FDS / GitHub (matches script/release.ts platforms). */
const PLATFORMS = [
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

function mapPlatform(value = os.platform()) {
  if (value === "win32") return "windows"
  if (value === "darwin" || value === "linux") return value
  return value
}

function mapArch(value = os.arch()) {
  if (value === "x64" || value === "arm64" || value === "arm") return value
  return value
}

function supportsAvx2(platform = mapPlatform(), arch = mapArch()) {
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

function isMusl(platform = mapPlatform()) {
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
 * Throws when the host is outside the published matrix.
 * `options.platform` / `options.arch` / `options.avx2` / `options.musl` override detection (tests).
 */
function detectTarget(options = {}) {
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

function binaryNameFor(target) {
  return target.includes("windows") ? "mimo.exe" : "mimo"
}

function archiveNameFor(target) {
  return target.includes("linux") ? `${target}.tar.gz` : `${target}.zip`
}

function packageRoot(fromDir = __dirname) {
  return path.resolve(fromDir)
}

function readVersion(root) {
  const raw = fs.readFileSync(path.join(root, "package.json"), "utf8")
  const version = JSON.parse(raw).version
  if (!version || !/^\d+\.\d+\.\d+/.test(version)) {
    throw new Error(`Invalid package version: ${version}`)
  }
  return version
}

function fdsBase() {
  return (process.env.MIMO_FDS_BASE || DEFAULT_FDS_BASE).replace(/\/+$/, "")
}

function releaseUrl(version, target) {
  return `${fdsBase()}/releases/v${version}/${archiveNameFor(target)}`
}

function vendorBinaryPath(root, target) {
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

async function downloadTo(url, dest, { timeoutMs = 120_000 } = {}) {
  const res = await fetch(url, { redirect: "follow", signal: AbortSignal.timeout(timeoutMs) })
  if (!res.ok || !res.body) {
    throw new Error(`FDS download failed ${res.status} for ${url}`)
  }
  await pipeline(Readable.fromWeb(res.body), fs.createWriteStream(dest))
}

async function verifySha256(filePath, url) {
  const checksumUrl = `${url}.sha256`
  let expected
  try {
    const res = await fetch(checksumUrl, { signal: AbortSignal.timeout(30_000) })
    if (res.status === 404) return false
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
async function ensureBinary(options = {}) {
  const root = options.root || packageRoot()
  const target = options.target || detectTarget()
  const version = options.version || readVersion(root)
  const dest = options.dest || vendorBinaryPath(root, target)
  const url = options.url || releaseUrl(version, target)
  const log = options.log || (() => {})

  if (fs.existsSync(dest)) return dest

  const archiveName = archiveNameFor(target)
  const partial = `${dest}.partial`
  const tmpDir = await fs.promises.mkdtemp(path.join(os.tmpdir(), "mimocode-fetch-"))
  const archivePath = path.join(tmpDir, archiveName)
  try {
    log(`Downloading mimo ${version} (${target}) from FDS…`)
    await downloadTo(url, archivePath)
    await verifySha256(archivePath, url)
    await extractBinary(archivePath, target, partial)
    await fs.promises.mkdir(path.dirname(dest), { recursive: true })
    await fs.promises.rename(partial, dest)
    log(`Installed ${dest}`)
    return dest
  } finally {
    await fs.promises.rm(partial, { force: true })
    await fs.promises.rm(tmpDir, { recursive: true, force: true })
  }
}

function runBinary(targetPath, args = process.argv.slice(2)) {
  const result = childProcess.spawnSync(targetPath, args, { stdio: "inherit" })
  if (result.error) {
    console.error(result.error.message)
    process.exit(1)
  }
  const code = typeof result.status === "number" ? result.status : 0
  process.exit(code)
}

module.exports = {
  DEFAULT_FDS_BASE,
  PLATFORMS,
  archiveNameFor,
  binaryNameFor,
  detectTarget,
  ensureBinary,
  fdsBase,
  isMusl,
  mapArch,
  mapPlatform,
  packageRoot,
  readVersion,
  releaseUrl,
  runBinary,
  supportsAvx2,
  vendorBinaryPath,
}
