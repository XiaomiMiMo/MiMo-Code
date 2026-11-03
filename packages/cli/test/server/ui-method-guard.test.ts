import { afterEach, expect, test } from "bun:test"
import { Instance } from "../../src/project/instance"
import { Server } from "../../src/server/server"
import { tmpdir } from "../fixture/fixture"

afterEach(() => Instance.disposeAll())

// The SPA fallback must not answer API mutations with index.html and a 200.
test("SPA fallback rejects mutations but CORS preflight still succeeds", async () => {
  await using tmp = await tmpdir({ git: true })
  const app = Server.Default().app
  const headers = { "x-mimocode-directory": tmp.path }
  for (const method of ["POST", "PUT", "PATCH", "DELETE"]) {
    const res = await app.request("/example/unknown", { method, headers })
    expect(res.status).toBe(404)
    expect(await res.json()).toEqual({ error: "Not Found" })
  }
  const preflight = await app.request("/session", {
    method: "OPTIONS",
    headers: { ...headers, Origin: "http://localhost:3000", "Access-Control-Request-Method": "POST" },
  })
  expect(preflight.status).toBe(204)
  expect(preflight.headers.get("access-control-allow-origin")).toBe("http://localhost:3000")
})
