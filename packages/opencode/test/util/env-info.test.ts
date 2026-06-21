import { describe, expect, test } from "bun:test"
import os from "os"
import { getEnvInfo, getEnvTelemetry } from "../../src/util/env-info"

describe("util.env-info", () => {
  test("getEnvTelemetry returns only telemetry-safe fields", () => {
    const telemetry = getEnvTelemetry()

    expect(telemetry.os.platform).toBe(os.platform())
    expect(telemetry.os.arch).toBe(os.arch())
    expect(telemetry.os.release).toBe(os.release())
    expect(telemetry.cpu.count).toBe(os.cpus().length)
    expect(telemetry.cpu.model).toBe(os.cpus()[0]?.model ?? "unknown")
    expect(telemetry.memory.total_bytes).toBe(os.totalmem())
    expect(telemetry.runtime.bun_version).toBe(Bun.version)
    expect(telemetry.runtime.node_version).toBe(process.versions.node)
    expect(telemetry.mimocode.version).toBeTruthy()
    expect(telemetry.mimocode.channel).toBeTruthy()

    expect(telemetry).not.toHaveProperty("user")
    expect(telemetry).not.toHaveProperty("paths")
    expect(telemetry.os).not.toHaveProperty("hostname")
    expect(telemetry.memory).not.toHaveProperty("free_bytes")
    expect(telemetry.runtime).not.toHaveProperty("pid")
    expect(telemetry.mimocode).not.toHaveProperty("installation_id")
    expect(telemetry.mimocode).not.toHaveProperty("run_id")
    expect(telemetry.mimocode).not.toHaveProperty("process_role")
  })

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
