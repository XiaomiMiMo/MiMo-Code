import { describe, expect, test } from "bun:test"
import os from "os"
import { getEnvInfo } from "../../src/util/env-info"

describe("util.env-info", () => {
  test("returns host, user, runtime, and mimocode metadata", async () => {
    const info = await getEnvInfo()

    expect(info.os.platform).toBe(os.platform())
    expect(info.os.arch).toBe(os.arch())
    expect(info.os.hostname).toBe(os.hostname())
    expect(info.cpu.count).toBe(os.cpus().length)
    expect(info.cpu.model).toBe(os.cpus()[0]?.model ?? "unknown")
    expect(info.memory.total_bytes).toBe(os.totalmem())
    expect(info.user.homedir).toBe(os.homedir())
    expect(info.runtime.bun_version).toBe(Bun.version)
    expect(info.runtime.node_version).toBe(process.versions.node)
    expect(info.runtime.pid).toBe(process.pid)
    expect(info.paths.cwd).toBe(process.cwd())
    expect(info.mimocode.version).toBeTruthy()
    expect(info.mimocode.channel).toBeTruthy()
    expect(info.mimocode.installation_id).toMatch(
      /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i,
    )
  })
})
