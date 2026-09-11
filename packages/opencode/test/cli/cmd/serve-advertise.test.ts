import { describe, expect, test } from "bun:test"
import { Server } from "../../../src/server/server"
import { LLMServerTokens } from "../../../src/llm-server/tokens"
import { tmpdir } from "../../fixture/fixture"

/**
 * `Server.listen` must register itself in the llm-server address registry.
 *
 * `llm-server issue` only mints credentials; it reads the live endpoint from
 * `LLMServerTokens.address(process.cwd())`. A host that listens but never
 * publishes yields `base_url: null` even though `/v1` would accept the token.
 */

describe("Server.listen llm-server advertisement", () => {
  test("publishes cwd so issue can resolve base_url, and unpublishes on stop", async () => {
    const cwd = process.cwd()
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

    const after = await LLMServerTokens.addresses(cwd)
    expect(after.find((a) => a.port === server.port)).toBeUndefined()
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

  test("bind 0.0.0.0 advertises a loopback client URL, not the bind address", async () => {
    const cwd = process.cwd()
    const server = await Server.listen({ port: 0, hostname: "0.0.0.0", noAuth: true })
    try {
      const address = await LLMServerTokens.address(cwd)
      expect(address?.hostname).toBe("127.0.0.1")
      expect(address?.url).toContain("127.0.0.1")
      expect(address?.url).not.toContain("0.0.0.0")
    } finally {
      await server.stop()
    }
  })

  test("two listeners in one process keep independent advertisements", async () => {
    const cwd = process.cwd()
    const a = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    const b = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      const live = await LLMServerTokens.addresses(cwd)
      expect(live.find((x) => x.port === a.port)).toBeTruthy()
      expect(live.find((x) => x.port === b.port)).toBeTruthy()
    } finally {
      await a.stop()
      const afterA = await LLMServerTokens.addresses(cwd)
      expect(afterA.find((x) => x.port === a.port)).toBeUndefined()
      expect(afterA.find((x) => x.port === b.port)).toBeTruthy()
      await b.stop()
    }
  })

  test("address stays project-scoped — no cross-host fallback", async () => {
    await using project = await tmpdir()
    await using host = await tmpdir()

    await LLMServerTokens.publish(host.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 9001,
      url: "http://127.0.0.1:9001/",
      started: Date.now(),
    })

    // A listener in another directory must not satisfy this project's `issue`.
    expect(await LLMServerTokens.address(project.path)).toBeUndefined()

    await LLMServerTokens.publish(project.path, {
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 9002,
      url: "http://127.0.0.1:9002/",
      started: Date.now(),
    })
    expect(await LLMServerTokens.address(project.path)).toMatchObject({ port: 9002 })

    await LLMServerTokens.unpublish(project.path)
    expect(await LLMServerTokens.address(project.path)).toBeUndefined()
    // Host bucket is still live, but must stay invisible to the project lookup.
    expect(await LLMServerTokens.address(host.path)).toMatchObject({ port: 9001 })
    await LLMServerTokens.unpublish(host.path)
  })
})
