import { afterEach, expect, test } from "bun:test"
import path from "node:path"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"
import { Session } from "../../src/session"
import { Config } from "../../src/config"

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
    expect(config).not.toHaveProperty("enterprise")
    expect(calls).toEqual([])
    const removed = await app.request(`/session/${session.id}`, { method: "DELETE", headers })
    expect(removed.status).toBe(200)
  } finally {
    upstream.stop(true)
  }
})

// engine-runtime [TP-R14-02]: the schemas OpenAPI and the SDK are generated from carry no share surface.
// Checked on the schemas directly: Server.openapi() is not safe to call twice in one process.
test("session and config schemas have no cloud share fields", () => {
  expect(Session.Info.shape).not.toHaveProperty("share")
  // The schema is strict, so removed keys are rejected; loading strips them first (see config.test.ts).
  for (const removed of [{ share: "auto" }, { autoshare: true }, { enterprise: { url: "https://example.com" } }])
    expect(Config.Info.safeParse(removed).success).toBe(false)
  expect(Config.Info.safeParse({}).success).toBe(true)
})
