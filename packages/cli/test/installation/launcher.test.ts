import { describe, expect, test } from "bun:test"
import { createHash } from "crypto"
import path from "path"
import fs from "fs"
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
})

describe("ensureBinary", () => {
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
    const tar = Bun.spawnSync(["tar", "-czf", archivePath, "-C", work, "mimo"])
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
        counting.stop()
      }
    } finally {
      server.stop()
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
    Bun.spawnSync(["tar", "-czf", archivePath, "-C", work, "mimo"])
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
          return new Response(bytes)
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
        server.stop()
      }
    }
  })

  test("fails closed when the checksum endpoint errors (not 404)", async () => {
    await using tmp = await tmpdir()
    const root = tmp.path
    const target = "mimocode-linux-x64"
    const work = path.join(root, "build")
    fs.mkdirSync(work, { recursive: true })
    fs.writeFileSync(path.join(work, "mimo"), "binary-bytes")
    const archivePath = path.join(root, "a.tar.gz")
    Bun.spawnSync(["tar", "-czf", archivePath, "-C", work, "mimo"])

    const server = Bun.serve({
      port: 0,
      fetch(req) {
        const url = new URL(req.url)
        if (url.pathname.endsWith(".sha256")) return new Response("oops", { status: 500 })
        return new Response(Bun.file(archivePath))
      },
    })
    try {
      await expect(
        ensureBinary({
          root,
          target,
          version: "9.9.9",
          dest: path.join(root, "vendor", "mimo"),
          url: `http://127.0.0.1:${server.port}/releases/v9.9.9/${target}.tar.gz`,
        }),
      ).rejects.toThrow(/Checksum fetch failed/)
      expect(fs.existsSync(path.join(root, "vendor", "mimo"))).toBe(false)
    } finally {
      server.stop()
    }
  })
})
