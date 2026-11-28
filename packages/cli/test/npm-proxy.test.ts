import { describe, expect, test } from "bun:test"
import http from "node:http"
import type { AddressInfo } from "node:net"
import { createRequire } from "node:module"

// Arborist (used by Npm.add) fetches through pacote → npm-registry-fetch →
// make-fetch-happen → @npmcli/agent. None of these are direct dependencies, so
// resolve them along that chain to exercise the exact copies shipped.
const arborist = createRequire(import.meta.resolve("@npmcli/arborist"))
const pacote = createRequire(arborist.resolve("pacote"))
const fetchRegistry = pacote("npm-registry-fetch") as {
  json(path: string, opts: Record<string, unknown>): Promise<Record<string, unknown>>
}
const registryFetch = createRequire(pacote.resolve("npm-registry-fetch"))
const makeFetch = createRequire(registryFetch.resolve("make-fetch-happen"))
const { Agent } = makeFetch("@npmcli/agent") as {
  Agent: new (options: { proxy: string }) => { proxy: { url?: unknown } }
}

async function serve(handler: http.RequestListener) {
  const server = http.createServer(handler)
  await new Promise<void>((resolve) => server.listen(0, "127.0.0.1", resolve))
  return {
    url: `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
    async [Symbol.asyncDispose]() {
      server.closeAllConnections()
      await new Promise((resolve) => server.close(resolve))
    },
  }
}

// @npmcli/agent stores the proxy as a URL and exposes it as `agent.proxy.url`.
// Bun's node:http forwards that value to fetch(); Bun 1.3 rejects a non-string with
// "proxy.url must be a non-empty string", so every plugin install failed for users
// with http(s)_proxy set. patches/@npmcli%2Fagent@*.patch turns it into a string.
describe("npm registry requests through a proxy", () => {
  // Runtime-independent guard: fails whenever the patch is not applied (for
  // example after an @npmcli/agent bump that leaves patchedDependencies behind),
  // even on Bun versions that would accept the URL.
  test("the agent exposes its proxy as a string", () => {
    expect(typeof new Agent({ proxy: "http://127.0.0.1:1" }).proxy.url).toBe("string")
  })

  // End-to-end through Bun's node:http; it only reproduces the failure on Bun 1.3.
  test("reach the registry via the configured proxy", async () => {
    const seen: string[] = []
    await using proxy = await serve((req, res) => {
      seen.push(req.url ?? "")
      res.setHeader("content-type", "application/json")
      res.end(JSON.stringify({ name: "example-pkg", "dist-tags": { latest: "1.0.0" } }))
    })

    const packument = await fetchRegistry.json("/example-pkg", {
      // Unresolvable on purpose: only the proxy can answer. (A no_proxy entry in the
      // environment matching this host would bypass the proxy and fail the test.)
      registry: "http://registry.example.invalid/",
      proxy: proxy.url,
      retry: { retries: 0 },
    })

    expect(packument["dist-tags"]).toEqual({ latest: "1.0.0" })
    expect(seen).toEqual(["http://registry.example.invalid/example-pkg"])
  })
})
