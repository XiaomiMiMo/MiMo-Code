import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

const worker = path.join(import.meta.dir, "fixture", "global-paths-worker.ts")

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-home-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

type PathsResult = {
  data: string
  config: string
  state: string
  cache: string
  bin: string
  log: string
  home: string
}

async function runWorker(env: Record<string, string>): Promise<{ ok: true; paths: PathsResult } | { ok: false; code: number | null; stderr: string }> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [worker], {
      env: { ...process.env, ...env },
      stdio: ["ignore", "pipe", "pipe"],
    })
    let stdout = ""
    let stderr = ""
    child.stdout.on("data", (chunk) => {
      stdout += chunk.toString()
    })
    child.stderr.on("data", (chunk) => {
      stderr += chunk.toString()
    })
    child.on("close", (code) => {
      if (code !== 0) {
        resolve({ ok: false, code, stderr })
        return
      }
      try {
        const line = stdout.trim().split("\n").pop() ?? ""
        resolve({ ok: true, paths: JSON.parse(line) as PathsResult })
      } catch (err) {
        resolve({ ok: false, code, stderr: `parse error: ${err}\nstdout: ${stdout}` })
      }
    })
  })
}

describe("MIMOCODE_HOME end-to-end", () => {
  test("sets all four paths under the profile root", async () => {
    await using tmp = await tmpdir()
    const result = await runWorker({ MIMOCODE_HOME: tmp.path })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    expect(result.paths.config).toBe(path.join(tmp.path, "config"))
    expect(result.paths.data).toBe(path.join(tmp.path, "data"))
    expect(result.paths.state).toBe(path.join(tmp.path, "state"))
    expect(result.paths.cache).toBe(path.join(tmp.path, "cache"))
    expect(result.paths.bin).toBe(path.join(tmp.path, "cache", "bin"))
    expect(result.paths.log).toBe(path.join(tmp.path, "data", "log"))
  })

  test("auto-creates all four subdirs under a nonexistent root", async () => {
    await using tmp = await tmpdir()
    const nested = path.join(tmp.path, "deeply", "nested", "profile")
    const result = await runWorker({ MIMOCODE_HOME: nested })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Directories should now exist
    for (const sub of ["config", "data", "state", "cache"]) {
      const stat = await fs.stat(path.join(nested, sub))
      expect(stat.isDirectory()).toBe(true)
    }
  })

  test("two profiles have fully isolated data (write in A, not visible in B, A survives restart)", async () => {
    await using a = await tmpdir()
    await using b = await tmpdir()

    // First run with profile A initializes its directories
    const resultA = await runWorker({ MIMOCODE_HOME: a.path })
    expect(resultA.ok).toBe(true)
    if (!resultA.ok) return
    expect(resultA.paths.data).toBe(path.join(a.path, "data"))

    // Write a marker file inside profile A's data dir
    const marker = "isolation-marker.txt"
    await fs.writeFile(path.join(resultA.paths.data, marker), "profile-a-data")

    // Run with profile B — marker must not exist in B's data dir
    const resultB = await runWorker({ MIMOCODE_HOME: b.path })
    expect(resultB.ok).toBe(true)
    if (!resultB.ok) return
    expect(resultB.paths.data).toBe(path.join(b.path, "data"))
    expect(resultB.paths.data).not.toBe(resultA.paths.data)
    await expect(
      fs.access(path.join(resultB.paths.data, marker)),
    ).rejects.toThrow()

    // Run again with profile A — marker must still be there
    const resultA2 = await runWorker({ MIMOCODE_HOME: a.path })
    expect(resultA2.ok).toBe(true)
    if (!resultA2.ok) return
    const reread = await fs.readFile(
      path.join(resultA2.paths.data, marker),
      "utf-8",
    )
    expect(reread).toBe("profile-a-data")
  })

  test("relative path causes startup failure with clear error", async () => {
    const result = await runWorker({ MIMOCODE_HOME: "./relative-path" })
    expect(result.ok).toBe(false)
    if (result.ok) return
    expect(result.stderr).toMatch(/MIMOCODE_HOME must be an absolute path/)
  })

  test("empty string falls through to XDG behavior", async () => {
    await using tmp = await tmpdir()
    // Isolate XDG to tmp so we can see it used
    const result = await runWorker({
      MIMOCODE_HOME: "",
      XDG_CONFIG_HOME: path.join(tmp.path, "config"),
      XDG_DATA_HOME: path.join(tmp.path, "data"),
      XDG_STATE_HOME: path.join(tmp.path, "state"),
      XDG_CACHE_HOME: path.join(tmp.path, "cache"),
    })
    expect(result.ok).toBe(true)
    if (!result.ok) return
    // Paths should reflect XDG layout (ends with "/mimocode"), not MIMOCODE_HOME layout
    expect(result.paths.config).toBe(path.join(tmp.path, "config", "mimocode"))
    expect(result.paths.data).toBe(path.join(tmp.path, "data", "mimocode"))
  })
})
