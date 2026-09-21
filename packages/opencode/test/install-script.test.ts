import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-install-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function runInstall(tmp: string) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn("bash", [path.join(import.meta.dir, "..", "..", "..", "install"), "--binary", path.join(tmp, "mimo")], {
      env: {
        ...process.env,
        HOME: path.join(tmp, "home"),
        SHELL: "/bin/zsh",
        PATH: process.env.PATH ?? "",
      },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    proc.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    proc.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    proc.on("close", (code) => resolve({ code, stdout, stderr }))
  })
}

describe("install script", () => {
  test("prints a shell refresh hint after adding mimo to shell config", async () => {
    await using tmp = await tmpdir()
    await fs.mkdir(path.join(tmp.path, "home"), { recursive: true })
    await fs.writeFile(path.join(tmp.path, "home", ".zshrc"), "# test shell config\n")
    await fs.writeFile(path.join(tmp.path, "mimo"), "#!/usr/bin/env sh\n")

    const result = await runInstall(tmp.path)

    expect(result.code).toBe(0)
    expect(await fs.readFile(path.join(tmp.path, "home", ".zshrc"), "utf8")).toContain(
      `export PATH=${path.join(tmp.path, "home", ".mimocode", "bin")}:$PATH`,
    )
    expect(result.stdout + result.stderr).toContain("Open a new terminal or run:")
    expect(result.stdout + result.stderr).toContain(`source ${path.join(tmp.path, "home", ".zshrc")}`)
  })
})
