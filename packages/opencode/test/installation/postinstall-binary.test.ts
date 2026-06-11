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
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "mimocode-install-"))
  tmpRoots.push(dir)
  return dir
}

function copyRepoFile(root: string, from: string, to: string) {
  const target = path.join(root, to)
  fs.mkdirSync(path.dirname(target), { recursive: true })
  fs.copyFileSync(path.join(__dirname, "../..", from), target)
}

function binaryPackage(root: string, name: string, binary: string, content = name) {
  const dir = path.join(root, "node_modules", name)
  fs.mkdirSync(path.join(dir, "bin"), { recursive: true })
  fs.writeFileSync(path.join(dir, "package.json"), JSON.stringify({ name, version: "0.0.0" }))
  fs.writeFileSync(path.join(dir, "bin", binary), content)
}

function runNode(root: string, script: string) {
  return spawnSync(node, ["-e", script], {
    cwd: root,
    encoding: "utf8",
  })
}

describe("postinstall binary setup", () => {
  test("links the baseline mimocode binary when linux x64 lacks avx2", () => {
    const root = tmpdir()
    copyRepoFile(root, "script/postinstall.mjs", "postinstall.mjs")
    fs.mkdirSync(path.join(root, "bin"))
    binaryPackage(root, "mimocode-linux-x64", "mimo", "avx2")
    binaryPackage(root, "mimocode-linux-x64-baseline", "mimo", "baseline")

    const result = runNode(
      root,
      `
        const os = require("os")
        os.platform = () => "linux"
        os.arch = () => "x64"
        const fs = require("fs")
        const readFileSync = fs.readFileSync
        fs.readFileSync = (file, ...args) =>
          file === "/proc/cpuinfo" ? "flags: sse4_2" : readFileSync.call(fs, file, ...args)
        import("./postinstall.mjs")
      `,
    )

    expect(result.stderr).toBe("")
    expect(result.status).toBe(0)
    expect(fs.readFileSync(path.join(root, "bin", ".mimocode"), "utf8")).toBe("baseline")
  })
})
