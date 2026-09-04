import { describe, expect, test } from "bun:test"
import { spawnSync } from "node:child_process"
import { reapMcpChildren, registerMcpChildForTest } from "../../src/mcp/index"
import { Log } from "../../src/util"

void Log.init({ print: false })

function alive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function kill(pid: number) {
  try {
    process.kill(pid, "SIGKILL")
  } catch {}
}

describe("reapMcpChildren", () => {
  test.skipIf(process.platform === "win32")("kills a registered process", () => {
    // `sh -c 'sleep 300 & echo $!'` spawns a child `sleep` whose PID is printed.
    // Register the sleep PID via the test hook; reap must terminate it.
    const out = spawnSync("sh", ["-c", "sleep 300 & echo $!"], { encoding: "utf-8" })
    const pid = parseInt((out.stdout ?? "").trim(), 10)
    expect(Number.isNaN(pid)).toBe(false)
    expect(alive(pid)).toBe(true)
    try {
      registerMcpChildForTest(pid)
      reapMcpChildren()
      expect(alive(pid)).toBe(false)
    } finally {
      // Cleanup on assertion failure so the long-lived sleep never leaks.
      kill(pid)
    }
  })

  test.skipIf(process.platform === "win32")("kills a registered non-leaf process", () => {
    // `sh -c 'sh -c "sleep 300" & echo $!'` spawns an inner shell running a
    // foreground `sleep 300`; the printed PID is the inner shell. Register it so
    // reap has to SIGTERM a process that still owns a child (exercises the tree
    // path rather than a leaf). Only the registered pid is asserted dead — the
    // grandchild may reparent before pgrep runs, so its liveness is not a
    // reliable assertion here.
    const out = spawnSync("sh", ["-c", 'sh -c "sleep 300" & echo $!'], { encoding: "utf-8" })
    const pid = parseInt((out.stdout ?? "").trim(), 10)
    expect(Number.isNaN(pid)).toBe(false)
    expect(alive(pid)).toBe(true)
    try {
      registerMcpChildForTest(pid)
      reapMcpChildren()
      expect(alive(pid)).toBe(false)
    } finally {
      kill(pid)
    }
  })

  test("does not throw on empty registry", () => {
    expect(() => reapMcpChildren()).not.toThrow()
  })
})
