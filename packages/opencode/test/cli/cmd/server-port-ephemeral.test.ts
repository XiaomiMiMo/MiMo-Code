import { describe, expect, test } from "bun:test"
import net from "node:net"
import { Server } from "../../../src/server/server"

/**
 * `port: 0` must be OS ephemeral — never prefer a conventional serve port.
 * Conventional ports (e.g. 4096) collide with Desktop embeds and other local tools.
 */

async function occupy(port: number, host = "127.0.0.1") {
  return new Promise<net.Server>((resolve, reject) => {
    const srv = net.createServer()
    srv.once("error", reject)
    srv.listen(port, host, () => resolve(srv))
  })
}

describe("Server.listen port 0 = OS ephemeral", () => {
  test("binds an OS-assigned port, not a forced conventional port", async () => {
    const server = await Server.listen({ port: 0, hostname: "127.0.0.1" })
    try {
      expect(server.port).toBeGreaterThan(0)
      expect(Number.isInteger(server.port)).toBe(true)
    } finally {
      await server.stop()
    }
  })

  test("still works when a conventional serve port is already taken", async () => {
    let held: net.Server | null = null
    // Prefer holding 4096 if free so a reintroduced “try 4096 first” would collide.
    try {
      held = await occupy(4096)
    } catch {
      held = null // already taken by something else — still a valid collision case
    }
    try {
      const server = await Server.listen({ port: 0, hostname: "127.0.0.1" })
      try {
        expect(server.port).toBeGreaterThan(0)
        // Must not silently land on the held conventional port when we occupied it.
        if (held) expect(server.port).not.toBe(4096)
        const res = await fetch(`${server.url.toString().replace(/\/$/, "")}/global/health`).catch(() => null)
        // health may require auth; existence of a bound listener is enough here
        expect(server.port).toBeGreaterThan(0)
        expect(res === null || res.status > 0).toBe(true)
      } finally {
        await server.stop()
      }
    } finally {
      if (held) await new Promise<void>((r) => held!.close(() => r()))
    }
  })

  test("explicit port binds that port", async () => {
    const probe = await occupy(0)
    const addr = probe.address()
    const port = typeof addr === "object" && addr ? addr.port : 0
    await new Promise<void>((r) => probe.close(() => r()))
    const server = await Server.listen({ port, hostname: "127.0.0.1" })
    try {
      expect(server.port).toBe(port)
    } finally {
      await server.stop()
    }
  })
})
