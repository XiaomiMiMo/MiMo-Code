import { afterEach, describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import fs from "node:fs"
import os from "node:os"
import path from "node:path"

const node = Bun.which("node") ?? process.execPath
const tmpRoots: string[] = []

afterEach(() => {
  for (const dir of tmpRoots.splice(0)) {
    fs.rmSync(dir, { recursive: true, force: true })
  }
})

function tmpdir() {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-launcher-"))
  tmpRoots.push(dir)
  return dir
}

function copyLauncher(root: string) {
  const target = path.join(root, "bin", "mimo")
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(__dirname, "../../bin/mimo"), target)
}

function binaryPackage(root: string, name: string, binary: string) {
  const dir = path.join(root, "node_modules", name, "bin")
  fs.mkdirSync(dir, { recursive: true })
  fs.writeFileSync(path.join(dir, binary), "")
}

function runNode(root: string, script: string) {
  return spawnSync(node, ["-e", script], {
    cwd: root,
    encoding: "utf8",
  })
}

describe("mimo launcher binary fallback", () => {
  test("tries baseline mimocode binary after avx2 binary exits with SIGILL", () => {
    const root = tmpdir()
    copyLauncher(root)
    binaryPackage(root, "opencode-linux-x64", "opencode")
    binaryPackage(root, "opencode-linux-x64-baseline", "opencode")
    binaryPackage(root, "mimocode-linux-x64", "mimo")
    binaryPackage(root, "mimocode-linux-x64-baseline", "mimo")

    const result = runNode(
      root,
      `
        const os = require("os")
        os.platform = () => "linux"
        os.arch = () => "x64"

        const fs = require("fs")
        const readFileSync = fs.readFileSync
        fs.readFileSync = (file, ...args) =>
          file === "/proc/cpuinfo" ? "flags: avx2" : readFileSync.call(fs, file, ...args)

        const childProcess = require("child_process")
        const calls = []
        childProcess.spawnSync = (target) => {
          if (target === "ldd") return { status: 0, stdout: "ldd (GNU libc)" }
          calls.push(target)
          if (target.includes("mimocode-linux-x64/bin/mimo")) return { status: null, signal: "SIGILL" }
          if (target.includes("mimocode-linux-x64-baseline/bin/mimo")) return { status: 0, signal: null }
          if (target.includes("opencode-linux-x64/bin/opencode")) return { status: null, signal: "SIGILL" }
          if (target.includes("opencode-linux-x64-baseline/bin/opencode")) return { status: 0, signal: null }
          return { status: 1, signal: null }
        }

        process.argv = ["node", "./bin/mimo"]
        process.exit = (code) => {
          console.log(JSON.stringify({ code, calls }))
          throw new Error("EXIT")
        }

        try {
          require("./bin/mimo")
        } catch (error) {
          if (error.message !== "EXIT") throw error
        }
      `,
    )

    expect(result.stderr).toContain("SIGILL")
    expect(result.status).toBe(0)
    const output = JSON.parse(result.stdout.trim())
    expect(output).toMatchObject({ code: 0 })
    expect(output.calls.some((item: string) => item.includes("mimocode-linux-x64/bin/mimo"))).toBe(true)
    expect(output.calls.some((item: string) => item.includes("mimocode-linux-x64-baseline/bin/mimo"))).toBe(true)
  })
})
