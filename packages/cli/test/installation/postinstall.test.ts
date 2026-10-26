import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import fs from "fs"
import path from "path"
import os from "os"
import { tarCommand } from "../../launcher.js"

const SCRIPT_PATH = path.join(import.meta.dirname, "../../postinstall.mjs")
const LAUNCHER_PATH = path.join(import.meta.dirname, "../../launcher.js")

function stagePackage(dir: string) {
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
  fs.copyFileSync(SCRIPT_PATH, path.join(dir, "postinstall.mjs"))
  fs.copyFileSync(LAUNCHER_PATH, path.join(dir, "launcher.js"))
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({ name: "@mimo-ai/cli", version: "9.9.9", type: "module", bin: { mimo: "./mimo.js" } }),
  )
}

function runPostinstall(dir: string, env: Record<string, string> = {}) {
  // Async spawn: a Bun.serve stub in this process must stay free to answer HTTP.
  return Bun.spawn(["node", "postinstall.mjs"], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function waitPostinstall(proc: ReturnType<typeof runPostinstall>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("postinstall", () => {
  test("prints migration notice on stdout", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stagePackage(dir)

    // Point at a closed port so prefetch fails quickly and stays best-effort.
    const result = await waitPostinstall(
      runPostinstall(dir, {
        MIMO_FDS_BASE: "http://127.0.0.1:9",
        MIMOCODE_BIN_PATH: "",
      }),
    )

    expect(result.exitCode).toBe(0)
    const stdout = result.stdout.toString()
    expect(stdout).toContain("Recommended: install MiMoCode natively for a better")
    expect(stdout).toContain(os.platform() === "win32" ? "    irm" : "    curl")
  })

  test("best-effort prefetch leaves vendor empty and exits 0 when FDS is down", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stagePackage(dir)

    const result = await waitPostinstall(
      runPostinstall(dir, {
        MIMO_FDS_BASE: "http://127.0.0.1:9",
        MIMOCODE_BIN_PATH: "",
      }),
    )

    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(path.join(dir, "vendor"))).toBe(false)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/skipped binary prefetch|first `mimo` run/i)
  })

  test("prefetches into package-local vendor when FDS serves the archive", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stagePackage(dir)

    const target = launcherTarget()
    const archiveName = target.includes("linux") ? `${target}.tar.gz` : `${target}.zip`
    const work = path.join(dir, "build")
    fs.mkdirSync(work, { recursive: true })
    const binaryName = target.includes("windows") ? "mimo.exe" : "mimo"
    fs.writeFileSync(path.join(work, binaryName), "FAKE_BINARY")
    const archivePath = path.join(dir, archiveName)
    if (target.includes("linux")) {
      const pack = Bun.spawnSync([tarCommand(), "-czf", archivePath, "-C", work, binaryName])
      expect(pack.exitCode).toBe(0)
    } else {
      const pack = Bun.spawnSync([tarCommand(), "-cf", archivePath, "-C", work, binaryName])
      expect(pack.exitCode).toBe(0)
    }

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith(".sha256")) return new Response(null, { status: 404 })
        return new Response(Bun.file(archivePath))
      },
    })
    try {
      const result = await waitPostinstall(
        runPostinstall(dir, {
          MIMO_FDS_BASE: `http://127.0.0.1:${server.port}`,
          MIMOCODE_BIN_PATH: "",
        }),
      )
      expect(result.exitCode).toBe(0)
      const dest = path.join(dir, "vendor", binaryName)
      expect(fs.existsSync(dest)).toBe(true)
      expect(fs.readFileSync(dest, "utf8")).toBe("FAKE_BINARY")
    } finally {
      await server.stop(true)
    }
  })

  test("skips download when MIMOCODE_BIN_PATH is set", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stagePackage(dir)

    const result = await waitPostinstall(
      runPostinstall(dir, {
        MIMO_FDS_BASE: "http://127.0.0.1:9",
        MIMOCODE_BIN_PATH: "/nonexistent/escape-hatch",
      }),
    )

    expect(result.exitCode).toBe(0)
    expect(fs.existsSync(path.join(dir, "vendor"))).toBe(false)
    expect(result.stdout).toContain("Recommended: install MiMoCode natively")
  })
})

function launcherTarget() {
  // Mirror detectTarget naming for the current host (x64/arm64 only in CI).
  const platform = os.platform() === "win32" ? "windows" : os.platform() === "darwin" ? "darwin" : "linux"
  const arch = os.arch() === "x64" || os.arch() === "arm64" ? os.arch() : "x64"
  return `mimocode-${platform}-${arch}`
}
