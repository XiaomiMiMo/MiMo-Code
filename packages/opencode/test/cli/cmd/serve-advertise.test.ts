import { describe, expect, test } from "bun:test"
import { Server } from "../../../src/server/server"
import { LLMServerTokens } from "../../../src/llm-server/tokens"
import { tmpdir } from "../../fixture/fixture"

/**
 * `Server.listen` must register itself in the llm-server address registry.
 *
 * `llm-server issue` only mints credentials; it reads the live endpoint from
 * `LLMServerTokens.discoverAddress(process.cwd())`. A host that listens but never
 * publishes yields `base_url: null` even though `/v1` would accept the token.
 * Desktop's embedded sidecar and `mimo serve` both go through this path.
 */

describe("Server.listen llm-server advertisement", () => {
  test("publishes cwd so issue can resolve base_url, and unpublishes on stop", async () => {
    const cwd = process.cwd()
    const before = await LLMServerTokens.address(cwd)

    const server = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const address = await LLMServerTokens.address(cwd)
      expect(address).toMatchObject({
        pid: process.pid,
        hostname: "127.0.0.1",
        port: server.port,
        url: server.url.toString(),
      })
      expect(address!.started).toBeGreaterThan(0)

      // The same join `llm-server issue` uses for `base_url`.
      expect(`${address!.url.replace(/\/$/, "")}/v1`).toBe(`${server.url.toString().replace(/\/$/, "")}/v1`)
    } finally {
      await server.stop()
    }

    // Withdrawn. Another pre-existing listener for this pid would remain if it was
    // published separately; normally nothing is left.
    const after = await LLMServerTokens.address(cwd)
    if (before) expect(after).toMatchObject({ port: before.port })
    else expect(after).toBeUndefined()
  })

  test("advertise:false leaves the registry alone", async () => {
    const cwd = process.cwd()
    const server = await Server.listen({ port: 0, hostname: "127.0.0.1", advertise: false })
    try {
      const address = await LLMServerTokens.address(cwd)
      expect(address?.port).not.toBe(server.port)
    } finally {
      await server.stop()
    }
  })

  test("discoverAddress prefers a project listener, then falls back to any live host", async () => {
    await using project = await tmpdir()
    await using host = await tmpdir()

    // Multi-project sidecar shape: published under the host's own cwd.
    await LLMServerTokens.publish(host.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 9001,
      url: "http://127.0.0.1:9001/",
      started: Date.now() - 1000,
    })

    // Project has no dedicated listener yet → fallback finds the host sidecar.
    expect(await LLMServerTokens.discoverAddress(project.path)).toMatchObject({ port: 9001 })

    // A TUI/serve pinned to the project wins over the multi-project host.
    await LLMServerTokens.publish(project.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 9002,
      url: "http://127.0.0.1:9002/",
      started: Date.now(),
    })
    expect(await LLMServerTokens.discoverAddress(project.path)).toMatchObject({ port: 9002 })

    await LLMServerTokens.unpublish(project.path)
    expect(await LLMServerTokens.discoverAddress(project.path)).toMatchObject({ port: 9001 })
    await LLMServerTokens.unpublish(host.path)
    // The host bucket is gone. Other live listeners from the shared state root may
    // remain (this suite does not isolate Global.Path.state); just assert ours is not.
    const gone = await LLMServerTokens.discoverAddress(project.path)
    expect(gone?.port).not.toBe(9001)
    expect(gone?.port).not.toBe(9002)
  })
})
