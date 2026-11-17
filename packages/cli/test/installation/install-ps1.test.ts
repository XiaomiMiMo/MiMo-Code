// End-to-end test of install.ps1 in the staging mode `mimo upgrade` uses on
// Windows: same argv as upgradeCurlWindows (`irm $env:INSTALL_SCRIPT_URL | iex`),
// with the script and release zip served from a local HTTP server.
import { afterAll, beforeAll, describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"

const win = process.platform === "win32"
const script = path.join(import.meta.dir, "../../../../install.ps1")
const shells = win
  ? [
      Bun.which("powershell.exe"),
      Bun.which("pwsh.exe"),
      ...(process.env.MIMOCODE_TEST_PS_EXTRA ?? "").split(";"),
    ].filter((s): s is string => Boolean(s))
  : []

let server: ReturnType<typeof Bun.serve> | undefined
let zip: ArrayBuffer
let release: "ok" | "missing" | "corrupt" = "ok"

beforeAll(async () => {
  if (!win) return
  await using tmp = await tmpdir()
  await Bun.write(path.join(tmp.path, "mimo.exe"), "fake-binary")
  const out = path.join(tmp.path, "release.zip")
  expect(Bun.spawnSync(["tar", "-a", "-c", "-f", out, "-C", tmp.path, "mimo.exe"]).exitCode).toBe(0)
  zip = await Bun.file(out).arrayBuffer()
  server = Bun.serve({
    hostname: "127.0.0.1",
    port: 0,
    fetch: async (req) => {
      const url = new URL(req.url)
      if (url.pathname === "/install.ps1") return new Response(Bun.file(script))
      if (url.pathname.endsWith("/releases/latest")) return new Response("1.2.3")
      if (url.pathname.endsWith(".zip")) {
        if (release === "missing") return new Response("not found", { status: 404 })
        if (release === "corrupt") return new Response("this is not a zip")
        return new Response(zip)
      }
      return new Response("not found", { status: 404 })
    },
  })
})

afterAll(() => server?.stop(true))

// Simulates a mimo process started from a pwsh session whose PSModulePath puts
// an Archive module that only works on .NET Core ahead of Windows PowerShell's.
async function ps7ModulePath(dir: string) {
  const mod = path.join(dir, "ps7-modules", "Microsoft.PowerShell.Archive")
  await fs.mkdir(mod, { recursive: true })
  await Bun.write(
    path.join(mod, "Microsoft.PowerShell.Archive.psm1"),
    [
      "function Expand-Archive { param([string]$Path, [string]$DestinationPath, [switch]$Force)",
      "  Add-Type -AssemblyName System.IO.Compression.FileSystem",
      "  [IO.Compression.ZipFile]::ExtractToDirectory($Path, $DestinationPath, [bool]$Force) }",
    ].join("\n"),
  )
  return [path.join(dir, "ps7-modules"), process.env.PSModulePath].filter(Boolean).join(";")
}

// Async spawn: a sync spawn would block the event loop serving the script.
async function upgrade(shell: string, stage: string, env: Record<string, string> = {}) {
  const proc = Bun.spawn(
    [
      shell,
      "-NoProfile",
      "-NonInteractive",
      "-ep",
      "Bypass",
      "-c",
      "[Console]::OutputEncoding = [System.Text.Encoding]::UTF8; irm $env:INSTALL_SCRIPT_URL | iex",
    ],
    {
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      timeout: 60_000,
      env: {
        ...process.env,
        MIMOCODE_INSTALL_DIR: stage,
        VERSION: "1.2.3",
        INSTALL_SCRIPT_URL: `${server!.url}install.ps1`,
        MIMO_FDS_BASE: server!.url.toString(),
        ...env,
      },
    },
  )
  const [stdout, stderr, code] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { code, output: stdout + stderr }
}

describe.skipIf(!win || shells.length === 0)("install.ps1 staging (mimo upgrade on Windows)", () => {
  for (const shell of shells) {
    const label = path.relative(process.env.TEMP ?? "", shell).startsWith("..") ? path.basename(shell) : shell

    test(`stages mimo.exe [${label}]`, async () => {
      release = "ok"
      await using tmp = await tmpdir()
      const stage = path.join(tmp.path, "stage")
      const r = await upgrade(shell, stage)
      expect(r.code, r.output).toBe(0)
      expect(await Bun.file(path.join(stage, "mimo.exe")).text()).toBe("fake-binary")
    }, 90_000)

    test(`stages mimo.exe when a PowerShell 7 Archive module is inherited [${label}]`, async () => {
      release = "ok"
      await using tmp = await tmpdir()
      const stage = path.join(tmp.path, "stage")
      const r = await upgrade(shell, stage, { PSModulePath: await ps7ModulePath(tmp.path) })
      expect(r.code, r.output).toBe(0)
      expect(await Bun.file(path.join(stage, "mimo.exe")).exists()).toBe(true)
    }, 90_000)

    test(`exits non-zero when the download fails [${label}]`, async () => {
      release = "missing"
      await using tmp = await tmpdir()
      const stage = path.join(tmp.path, "stage")
      const r = await upgrade(shell, stage)
      expect(r.code, r.output).not.toBe(0)
      expect(r.output).toContain("Failed to download")
      expect(await Bun.file(path.join(stage, "mimo.exe")).exists()).toBe(false)
    }, 90_000)

    test(`exits non-zero when the archive is corrupt [${label}]`, async () => {
      release = "corrupt"
      await using tmp = await tmpdir()
      const stage = path.join(tmp.path, "stage")
      const r = await upgrade(shell, stage)
      expect(r.code, r.output).not.toBe(0)
      expect(r.output).toContain("Failed to extract archive")
    }, 90_000)
  }
})
