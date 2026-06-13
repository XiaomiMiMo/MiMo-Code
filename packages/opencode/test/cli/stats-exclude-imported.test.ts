import { describe, expect, test } from "bun:test"
import { spawn } from "child_process"
import fs from "fs/promises"
import os from "os"
import path from "path"

async function tmpdir() {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "mimocode-stats-test-"))
  return {
    path: dir,
    async [Symbol.asyncDispose]() {
      await fs.rm(dir, { recursive: true, force: true })
    },
  }
}

async function writeClaudeSession(home: string, cwd: string, prompt: string) {
  await fs.mkdir(path.join(home, ".claude", "projects", "repo"), { recursive: true })
  await fs.writeFile(
    path.join(home, ".claude", "projects", "repo", "11111111-1111-1111-1111-111111111111.jsonl"),
    `${JSON.stringify({
      type: "user",
      cwd,
      timestamp: "2026-06-12T00:00:00.000Z",
      message: { role: "user", content: prompt },
    })}\n`,
  )
}

async function runCli(tmp: string, args: string[]) {
  return new Promise<{ code: number | null; stdout: string; stderr: string }>((resolve) => {
    const proc = spawn(process.execPath, [path.join(import.meta.dir, "..", "..", "src", "index.ts"), ...args], {
      cwd: path.join(import.meta.dir, "..", ".."),
      env: {
        ...process.env,
        HOME: path.join(tmp, "home"),
        USERPROFILE: path.join(tmp, "home"),
        XDG_DATA_HOME: path.join(tmp, "data"),
        XDG_CONFIG_HOME: path.join(tmp, "config"),
        XDG_STATE_HOME: path.join(tmp, "state"),
        XDG_CACHE_HOME: path.join(tmp, "cache"),
        MIMOCODE_DB: path.join(tmp, "data", "mimocode.db"),
        MIMOCODE_DISABLE_DEFAULT_PLUGINS: "true",
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

describe("Stats excludes imported sessions by default", () => {
  test("mimo stats without --all excludes Claude Code imported sessions", async () => {
    await using tmp = await tmpdir()
    await writeClaudeSession(path.join(tmp.path, "home"), path.join(import.meta.dir, "..", ".."), "imported session prompt")

    // First import the Claude session explicitly
    const imported = await runCli(tmp.path, ["session", "import-claude"])
    expect(imported.code).toBe(0)
    expect(imported.stdout + imported.stderr).toContain("imported 1")

    // Now run stats without --all — should NOT count the imported session
    const statsDefault = await runCli(tmp.path, ["stats"])
    expect(statsDefault.code).toBe(0)
    // The imported session's prompt should not appear in any context
    expect(statsDefault.stdout).not.toContain("imported session prompt")
    // Sessions count should be 0 (only imported session exists, but excluded)
    expect(statsDefault.stdout).toMatch(/Sessions\s+0/)

    // Run stats with --all — SHOULD count the imported session
    const statsAll = await runCli(tmp.path, ["stats", "--all"])
    expect(statsAll.code).toBe(0)
    expect(statsAll.stdout).toMatch(/Sessions\s+1/)
  })
})
