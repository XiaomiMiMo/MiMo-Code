import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

// engine-runtime [TP-R14-01]: hit the actual routes with a controlled share server.
test("cloud share routes are absent even with auto-share configuration", async () => {
  const calls: string[] = []
  const upstream = Bun.serve({
    port: 0,
    fetch(req) {
      calls.push(req.url)
      return Response.json({ id: "example", secret: "example", url: "https://example.com/share/example" })
    },
  })
  try {
    await using tmp = await tmpdir({
      git: true,
      init: (dir) => Bun.write(path.join(dir, "mimocode.json"), JSON.stringify({
        share: "auto", autoshare: true, enterprise: { url: upstream.url.origin },
      })),
    })
    const app = Server.Default().app
    const headers = { "x-mimocode-directory": tmp.path, "Content-Type": "application/json" }
    const created = await app.request("/session", { method: "POST", headers, body: "{}" })
    expect(created.status).toBe(200)
    const session = await created.json()
    expect(session).not.toHaveProperty("share")
    for (const method of ["POST", "DELETE"]) {
      const res = await app.request(`/session/${session.id}/share`, { method, headers })
      expect(res.status).toBe(404)
    }
    const conf = await app.request("/config", { headers })
    const config = await conf.json()
    expect(config).not.toHaveProperty("share")
    expect(config).not.toHaveProperty("autoshare")
    expect(calls).toEqual([])
    const removed = await app.request(`/session/${session.id}`, { method: "DELETE", headers })
    expect(removed.status).toBe(200)
  } finally {
    upstream.stop(true)
  }
})

// engine-runtime [TP-R14-02]: SDK discovery must not advertise removed operations.
test("OpenAPI has no cloud share operations or settings", async () => {
  const doc = await Server.openapi()
  expect(doc.paths).not.toHaveProperty("/session/{sessionID}/share")
  expect(doc.components?.schemas?.Config?.properties).not.toHaveProperty("share")
  expect(doc.components?.schemas?.Config?.properties).not.toHaveProperty("autoshare")
  expect(doc.components?.schemas?.Session?.properties).not.toHaveProperty("share")
})
