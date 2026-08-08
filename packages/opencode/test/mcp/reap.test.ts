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

describe("reapMcpChildren", () => {
  test.skipIf(process.platform === "win32")("kills a registered process tree", () => {
    // `sh -c 'sleep 300 & echo $!'` spawns a child `sleep` whose PID is printed.
    // Register the sleep PID via the test hook; reap must terminate it.
    const out = spawnSync("sh", ["-c", "sleep 300 & echo $!"], { encoding: "utf-8" })
    const pid = parseInt((out.stdout ?? "").trim(), 10)
    expect(Number.isNaN(pid)).toBe(false)
    expect(alive(pid)).toBe(true)
    registerMcpChildForTest(pid)
    reapMcpChildren()
    expect(alive(pid)).toBe(false)
  })

  test("does not throw on empty registry", () => {
    expect(() => reapMcpChildren()).not.toThrow()
  })
})
