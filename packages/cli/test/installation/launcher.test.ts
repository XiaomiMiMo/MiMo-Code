import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import fs from "fs"
import { Hono } from "hono"
import { basicAuth } from "hono/basic-auth"
import { tmpdir } from "../fixture/fixture"

import {
  PLATFORMS,
  detectTarget,
  archiveNameFor,
  binaryNameFor,
  releaseUrl,
  vendorBinaryPath,
  DEFAULT_FDS_BASE,
  ensureBinary,
  stageWindowsRunCopy,
  tarCommand,
} from "../../launcher.js"

describe("launcher targets", () => {
  test("covers the full published matrix (12 platforms)", () => {
    expect(PLATFORMS).toHaveLength(12)
    expect(new Set(PLATFORMS).size).toBe(12)
  })

  test.each([
    [{ platform: "linux", arch: "arm64", avx2: false, musl: false }, "mimocode-linux-arm64"],
    [{ platform: "linux", arch: "x64", avx2: true, musl: false }, "mimocode-linux-x64"],
    [{ platform: "linux", arch: "x64", avx2: false, musl: false }, "mimocode-linux-x64-baseline"],
    [{ platform: "linux", arch: "arm64", avx2: false, musl: true }, "mimocode-linux-arm64-musl"],
    [{ platform: "linux", arch: "x64", avx2: true, musl: true }, "mimocode-linux-x64-musl"],
    [{ platform: "linux", arch: "x64", avx2: false, musl: true }, "mimocode-linux-x64-baseline-musl"],
    [{ platform: "darwin", arch: "arm64", avx2: true, musl: false }, "mimocode-darwin-arm64"],
    [{ platform: "darwin", arch: "x64", avx2: true, musl: false }, "mimocode-darwin-x64"],
    [{ platform: "darwin", arch: "x64", avx2: false, musl: false }, "mimocode-darwin-x64-baseline"],
    [{ platform: "windows", arch: "arm64", avx2: true, musl: false }, "mimocode-windows-arm64"],
    [{ platform: "windows", arch: "x64", avx2: true, musl: false }, "mimocode-windows-x64"],
    [{ platform: "windows", arch: "x64", avx2: false, musl: false }, "mimocode-windows-x64-baseline"],
  ])("detectTarget %o → %s", (options, expected) => {
    expect(detectTarget(options)).toBe(expected)
    expect(PLATFORMS).toContain(expected)
  })

  test("rejects hosts outside the matrix", () => {
    expect(() => detectTarget({ platform: "freebsd", arch: "x64" })).toThrow(/Unsupported platform/)
    expect(() => detectTarget({ platform: "linux", arch: "ia32" })).toThrow(/Unsupported architecture/)
    // arm64 never gets a baseline suffix even without AVX2
    expect(detectTarget({ platform: "darwin", arch: "arm64", avx2: false, musl: false })).toBe("mimocode-darwin-arm64")
  })

  test("archive and binary names follow the release layout", () => {
    expect(archiveNameFor("mimocode-linux-x64")).toBe("mimocode-linux-x64.tar.gz")
    expect(archiveNameFor("mimocode-linux-x64-baseline-musl")).toBe("mimocode-linux-x64-baseline-musl.tar.gz")
    expect(archiveNameFor("mimocode-darwin-arm64")).toBe("mimocode-darwin-arm64.zip")
    expect(archiveNameFor("mimocode-windows-x64-baseline")).toBe("mimocode-windows-x64-baseline.zip")
    expect(binaryNameFor("mimocode-linux-x64")).toBe("mimo")
    expect(binaryNameFor("mimocode-windows-x64")).toBe("mimo.exe")
  })

  test("release URL pins the package version and honors MIMO_FDS_BASE", () => {
    const previous = process.env.MIMO_FDS_BASE
    try {
      delete process.env.MIMO_FDS_BASE
      expect(releaseUrl("1.2.3", "mimocode-linux-x64")).toBe(
        `${DEFAULT_FDS_BASE}/releases/v1.2.3/mimocode-linux-x64.tar.gz`,
      )
      process.env.MIMO_FDS_BASE = "https://mirror.example/mimo/"
      expect(releaseUrl("1.2.3", "mimocode-darwin-arm64")).toBe(
        "https://mirror.example/mimo/releases/v1.2.3/mimocode-darwin-arm64.zip",
      )
    } finally {
      if (previous === undefined) delete process.env.MIMO_FDS_BASE
      else process.env.MIMO_FDS_BASE = previous
    }
  })

  test("vendor path is package-local", async () => {
    await using tmp = await tmpdir()
    const dest = vendorBinaryPath(tmp.path, "mimocode-windows-x64")
    expect(dest).toBe(path.join(tmp.path, "vendor", "mimo.exe"))
  })

  test("stageWindowsRunCopy is identity off-Windows (vendor stays the real file)", async () => {
    if (process.platform === "win32") return
    await using tmp = await tmpdir()
    const source = path.join(tmp.path, "vendor", "mimo")
    fs.mkdirSync(path.dirname(source), { recursive: true })
    fs.writeFileSync(source, "bin")
    expect(stageWindowsRunCopy(source, "9.9.9")).toBe(source)
    expect(fs.readFileSync(source, "utf8")).toBe("bin")
  })
})

describe("tarCommand", () => {
  test("uses tar from PATH off Windows", () => {
    expect(tarCommand({ platform: "linux" })).toBe("tar")
    expect(tarCommand({ platform: "darwin" })).toBe("tar")
  })

  test("returns %SystemRoot%\\System32\\tar.exe when it exists", async () => {
    await using tmp = await tmpdir()
    const systemTar = path.join(tmp.path, "System32", "tar.exe")
    fs.mkdirSync(path.dirname(systemTar), { recursive: true })
    fs.writeFileSync(systemTar, "")
    expect(tarCommand({ platform: "windows", env: { SystemRoot: tmp.path } })).toBe(systemTar)
    // Git Bash and MSYS pass the variables upper-case; a plain env object is case-sensitive.
    expect(tarCommand({ platform: "windows", env: { SYSTEMROOT: tmp.path } })).toBe(systemTar)
    expect(tarCommand({ platform: "windows", env: { windir: tmp.path } })).toBe(systemTar)
  })

  test("falls back to tar from PATH when Windows has no system tar", async () => {
    await using tmp = await tmpdir()
    expect(tarCommand({ platform: "windows", env: { SystemRoot: tmp.path } })).toBe("tar")
    expect(tarCommand({ platform: "windows", env: {} })).toBe("tar")
    expect(tarCommand({ platform: "windows", env: { SystemRoot: "." } })).toBe("tar")
  })
})

describe("ensureBinary", () => {
  // Git for Windows puts GNU tar ahead of System32\tar.exe; GNU tar cannot unpack the release zip.
  test.skipIf(process.platform !== "win32")("extracts a Windows zip when another tar comes first on PATH", async () => {
    const systemTar = path.join(process.env.SystemRoot ?? "C:\\Windows", "System32", "tar.exe")
    if (!fs.existsSync(systemTar)) return
    await using tmp = await tmpdir()
    const root = tmp.path
    const target = "mimocode-windows-x64"

    const work = path.join(root, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "mimo.exe"), "binary-bytes")
    const archivePath = path.join(root, `${target}.zip`)
    expect(Bun.spawnSync([systemTar, "-a", "-cf", archivePath, "-C", work, "mimo.exe"]).exitCode).toBe(0)

    // A tar.exe that cannot extract anything, first on PATH.
    const shadow = path.join(root, "shadow")
    fs.mkdirSync(shadow)
    fs.copyFileSync(path.join(path.dirname(systemTar), "where.exe"), path.join(shadow, "tar.exe"))
    const previousPath = process.env.PATH
    const server = Bun.serve({
      port: 0,
      fetch(req) {
        if (new URL(req.url).pathname.endsWith(".sha256")) return new Response(null, { status: 404 })
        return new Response(Bun.file(archivePath))
      },
    })
    try {
      process.env.PATH = `${shadow}${path.delimiter}${previousPath ?? ""}`
      const dest = await ensureBinary({
        root,
        target,
        version: "9.9.9",
        url: `http://127.0.0.1:${server.port}/releases/v9.9.9/${target}.zip`,
      })
      expect(dest).toBe(vendorBinaryPath(root, target))
      expect(fs.readFileSync(dest, "utf8")).toBe("binary-bytes")
    } finally {
      if (previousPath === undefined) delete process.env.PATH
      else process.env.PATH = previousPath
      await server.stop(true)
    }
  })

  test("downloads, extracts, and caches a linux archive", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const target = "mimocode-linux-x64"
    const binary = path.join(root, "vendor", "mimo")

    // Build a real tar.gz that looks like the release layout (binary at archive root).
    const work = path.join(root, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "mimo"), "#!/bin/sh\necho ok\n")
    const archivePath = path.join(root, "mimocode-linux-x64.tar.gz")
    const tar = Bun.spawnSync([tarCommand(), "-czf", archivePath, "-C", work, "mimo"])
    expect(tar.exitCode).toBe(0)

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith(".sha256")) return new Response(null, { status: 404 })
        return new Response(Bun.file(archivePath))
      },
    })
    try {
      const url = `http://127.0.0.1:${server.port}/releases/v9.9.9/${target}.tar.gz`
      const dest = await ensureBinary({
        root,
        target,
        version: "9.9.9",
        url,
      })
      expect(dest).toBe(binary)
      expect(fs.existsSync(binary)).toBe(true)
      expect(fs.readFileSync(binary, "utf8")).toContain("echo ok")
      expect(fs.existsSync(`${binary}.partial`)).toBe(false)

      // Second call must not re-download.
      let calls = 0
      const counting = Bun.serve({
        port: 0,
        fetch() {
          calls++
          return new Response(Bun.file(archivePath))
        },
      })
      try {
        const again = await ensureBinary({
          root,
          target,
          version: "9.9.9",
          url: `http://127.0.0.1:${counting.port}/releases/v9.9.9/${target}.tar.gz`,
        })
        expect(again).toBe(binary)
        expect(calls).toBe(0)
      } finally {
        await counting.stop(true)
      }
    } finally {
      await server.stop(true)
    }
  })

  test("prefers a published sha256 and rejects mismatches", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const target = "mimocode-linux-x64"
    const work = path.join(root, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "mimo"), "binary-bytes")
    const archivePath = path.join(root, "a.tar.gz")
    Bun.spawnSync([tarCommand(), "-czf", archivePath, "-C", work, "mimo"])
    const bytes = fs.readFileSync(archivePath)
    const good = createHash("sha256").update(bytes).digest("hex")

    for (const [checksum, ok] of [
      [good, true],
      ["0".repeat(64), false],
    ] as const) {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname.endsWith(".sha256")) return new Response(checksum)
          return new Response(new Uint8Array(bytes))
        },
      })
      try {
        const dest = path.join(root, "vendor", `mimo-${checksum.slice(0, 4)}`)
        const run = ensureBinary({
          root,
          target,
          version: "9.9.9",
          dest,
          url: `http://127.0.0.1:${server.port}/releases/v9.9.9/${target}.tar.gz`,
        })
        if (ok) {
          await run
          expect(fs.existsSync(dest)).toBe(true)
        } else {
          await expect(run).rejects.toThrow(/Checksum mismatch/)
          expect(fs.existsSync(dest)).toBe(false)
        }
      } finally {
        await server.stop(true)
      }
    }
  })

  test("checks the archive after an authenticated server releases the same endpoint", async () => {
    await using tmp = await tmpdir()
    const target = "mimocode-linux-x64"
    const work = path.join(tmp.path, "build")
    fs.mkdirSync(work)
    fs.writeFileSync(path.join(work, "mimo"), "binary-bytes")
    const archivePath = path.join(tmp.path, "a.tar.gz")
    expect(Bun.spawnSync([tarCommand(), "-czf", archivePath, "-C", work, "mimo"]).exitCode).toBe(0)

    const app = new Hono()
    app.use("*", basicAuth({ username: "test", password: "test-password" }))
    app.get("*", (c) => c.text("authenticated"))
    const previous = Bun.serve({ hostname: "127.0.0.1", port: 0, fetch: app.fetch })
    const port = previous.port
    const url = `http://127.0.0.1:${port}/releases/v9.9.9/${target}.tar.gz`
    try {
      const response = await fetch(url)
      expect(response.status).toBe(401)
      expect(await response.text()).toBe("Unauthorized")
    } finally {
      await previous.stop(true)
    }

    const requests: string[] = []
    const server = Bun.serve({
      hostname: "127.0.0.1",
      port,
      fetch(req) {
        const pathname = new URL(req.url).pathname
        requests.push(pathname)
        if (pathname.endsWith(".sha256")) return new Response("0".repeat(64))
        return new Response(Bun.file(archivePath))
      },
    })
    try {
      const dest = vendorBinaryPath(tmp.path, target)
      await expect(ensureBinary({ root: tmp.path, target, version: "9.9.9", url })).rejects.toThrow(/Checksum mismatch/)
      expect(requests).toEqual([new URL(url).pathname, `${new URL(url).pathname}.sha256`])
      expect(fs.existsSync(dest)).toBe(false)
      expect(fs.readdirSync(tmp.path).sort()).toEqual(["a.tar.gz", "build"])
    } finally {
      await server.stop(true)
    }
  })

  test("skips checksum when the endpoint is missing or unhealthy (does not brick install)", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const target = "mimocode-linux-x64"
    const work = path.join(root, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "mimo"), "binary-bytes")
    const archivePath = path.join(root, "a.tar.gz")
    Bun.spawnSync([tarCommand(), "-czf", archivePath, "-C", work, "mimo"])

    for (const status of [404, 403, 500] as const) {
      const server = Bun.serve({
        port: 0,
        fetch(req) {
          const url = new URL(req.url)
          if (url.pathname.endsWith(".sha256")) return new Response("missing", { status })
          return new Response(Bun.file(archivePath))
        },
      })
      try {
        const dest = path.join(root, "vendor", `mimo-${status}`)
        await ensureBinary({
          root,
          target,
          version: "9.9.9",
          dest,
          url: `http://127.0.0.1:${server.port}/releases/v9.9.9/${target}.tar.gz`,
        })
        expect(fs.existsSync(dest)).toBe(true)
      } finally {
        await server.stop(true)
      }
    }
  })
})
