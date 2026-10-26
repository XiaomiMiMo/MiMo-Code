import { describe, expect, test } from "bun:test"
import { tmpdir } from "../fixture/fixture"
import fs from "fs"
import path from "path"

import * as launcher from "../../launcher.js"

const BIN_PATH = path.join(import.meta.dirname, "../../mimo.js")
const LAUNCHER_PATH = path.join(import.meta.dirname, "../../launcher.js")

function stageLauncher(dir: string) {
  fs.mkdirSync(dir, { recursive: true })
  fs.copyFileSync(BIN_PATH, path.join(dir, "mimo.js"))
  fs.copyFileSync(LAUNCHER_PATH, path.join(dir, "launcher.js"))
  fs.writeFileSync(
    path.join(dir, "package.json"),
    JSON.stringify({
      name: "@mimo-ai/cli",
      version: "9.9.9",
      type: "module",
      bin: { mimo: "./mimo.js" },
    }),
  )
}

function runMimo(dir: string, args: string[], env: Record<string, string> = {}) {
  // Async spawn: a Bun.serve stub in this process must stay free to answer HTTP.
  return Bun.spawn(["node", path.join(dir, "mimo.js"), ...args], {
    cwd: dir,
    env: { ...process.env, ...env },
    stdout: "pipe",
    stderr: "pipe",
  })
}

async function waitMimo(proc: ReturnType<typeof runMimo>) {
  const [stdout, stderr, exitCode] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
    proc.exited,
  ])
  return { exitCode, stdout, stderr }
}

describe("bin/mimo launcher", () => {
  test("forwards argv and exit code to MIMOCODE_BIN_PATH without network", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stageLauncher(dir)

    const sh = path.join(dir, "fake-mimo")
    fs.writeFileSync(sh, `#!/bin/sh\necho "argv:$*"\nexit 0\n`)
    fs.chmodSync(sh, 0o755)
    const result = await waitMimo(
      runMimo(dir, ["--version", "hello"], {
        MIMOCODE_BIN_PATH: sh,
        MIMO_FDS_BASE: "http://127.0.0.1:9",
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("argv:--version hello")

    const failSh = path.join(dir, "fake-mimo-fail")
    fs.writeFileSync(failSh, `#!/bin/sh\nexit 7\n`)
    fs.chmodSync(failSh, 0o755)
    const failed = await waitMimo(
      runMimo(dir, [], {
        MIMOCODE_BIN_PATH: failSh,
        MIMO_FDS_BASE: "http://127.0.0.1:9",
      }),
    )
    expect(failed.exitCode).toBe(7)
  })

  test("runs package-local vendor binary without downloading", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stageLauncher(dir)

    const target = launcher.detectTarget()
    const dest = launcher.vendorBinaryPath(dir, target)
    fs.mkdirSync(path.dirname(dest), { recursive: true })
    if (target.includes("windows")) {
      fs.writeFileSync(dest, "x")
      expect(fs.existsSync(dest)).toBe(true)
      return
    }
    fs.writeFileSync(dest, `#!/bin/sh\necho "vendor-run:$*"\n`)
    fs.chmodSync(dest, 0o755)

    const result = await waitMimo(
      runMimo(dir, ["hello"], {
        MIMOCODE_BIN_PATH: "",
        MIMO_FDS_BASE: "http://127.0.0.1:9",
      }),
    )
    expect(result.exitCode).toBe(0)
    expect(result.stdout).toContain("vendor-run:hello")
  })

  test("downloads from FDS on first run when vendor is missing", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stageLauncher(dir)

    const target = launcher.detectTarget()
    const binaryName = launcher.binaryNameFor(target)
    const archiveName = launcher.archiveNameFor(target)
    const work = path.join(dir, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, binaryName), target.includes("windows") ? "fake-pe" : `#!/bin/sh\necho "downloaded-run:$*"\n`)
    const archivePath = path.join(dir, archiveName)
    if (target.includes("linux")) {
      expect(Bun.spawnSync([launcher.tarCommand(), "-czf", archivePath, "-C", work, binaryName]).exitCode).toBe(0)
    } else {
      expect(Bun.spawnSync([launcher.tarCommand(), "-cf", archivePath, "-C", work, binaryName]).exitCode).toBe(0)
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
      const result = await waitMimo(
        runMimo(dir, ["hi"], {
          MIMOCODE_BIN_PATH: "",
          MIMO_FDS_BASE: `http://127.0.0.1:${server.port}`,
        }),
      )
      expect(fs.existsSync(path.join(dir, "vendor", binaryName))).toBe(true)
      if (target.includes("windows")) {
        return
      }
      expect(result.exitCode).toBe(0)
      expect(result.stdout).toContain("downloaded-run:hi")
    } finally {
      await server.stop(true)
    }
  })

  test("reports FDS failure with a native install recommendation", async () => {
    await using tmp = await tmpdir()
    const dir = tmp.path
    stageLauncher(dir)

    const result = await waitMimo(
      runMimo(dir, [], {
        MIMOCODE_BIN_PATH: "",
        MIMO_FDS_BASE: "http://127.0.0.1:9",
      }),
    )
    expect(result.exitCode).toBe(1)
    const combined = result.stdout + result.stderr
    expect(combined).toMatch(/Failed to install MiMoCode binary/i)
    if (process.platform === "win32") {
      expect(combined).toContain("irm https://mimo.xiaomi.com/install.ps1 | iex")
    } else {
      expect(combined).toContain("curl -fsSL https://mimo.xiaomi.com/install | bash")
    }
  })
})
