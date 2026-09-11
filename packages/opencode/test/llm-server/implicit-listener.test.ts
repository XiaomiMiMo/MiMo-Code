import { afterAll, describe, expect, test } from "bun:test"
import os from "node:os"
import { Flag, clearGeneratedServerPassword, generateServerPassword } from "../../src/flag/flag"
import { Server } from "../../src/server/server"
import { LLMServerTokens } from "../../src/llm-server/tokens"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"

/**
 * The credential that makes an unasked-for listener safe.
 *
 * A TUI binds a loopback port on startup so the `/v1` capability API exists at all — it
 * is only reachable over a socket, and a consumer spawned mid-session cannot ask for one
 * retroactively. That door leads to `/file`, `/pty` and `/bash-interactive`, so opening
 * it without closing everything else would hand any process running as this user the
 * ability to read the project and run commands in it.
 *
 * These tests go through the REAL app (`Server.Default().app`), not a hand-assembled
 * router: the whole claim is about the middleware chain, so testing anything less would
 * test the assembly instead. No socket is bound because none is needed to prove it.
 *
 * ORDER IS LOAD-BEARING. The generated password is process-global with no reset — which
 * is the point, a listener must not be able to un-secure itself — so the "before" case
 * has to be asserted before `generateServerPassword()` is ever called.
 */

const app = () => Server.Default().app

// The password is process state, and `bun test` shares a process across files — leaving it
// armed makes every later file's unauthenticated request a 401. Production clears it in the
// same place it stops the listener, which is the mechanism used here rather than a
// test-only escape hatch.
afterAll(() => {
  clearGeneratedServerPassword()
})

function get(path: string, headers: Record<string, string> = {}) {
  return app().fetch(new Request(`http://127.0.0.1${path}`, { headers }))
}

describe("before a password is generated", () => {
  test("an instance route answers with no credential at all", async () => {
    await using tmp = await tmpdir({ git: true })
    // This is today's default and the reason the listener has to be secured: `/config`
    // hands over the project's configuration to whoever asks.
    expect((await get(`/config?directory=${encodeURIComponent(tmp.path)}`)).status).toBe(200)
    await Instance.disposeAll()
  })

  test("the capability routes refuse a request that carries no token", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await get(`/v1/models?directory=${encodeURIComponent(tmp.path)}`)
    expect(response.status).toBe(401)
    expect(((await response.json()) as { error: { code: string } }).error.code).toBe("invalid_api_key")
    await Instance.disposeAll()
  })
})

describe("after a password is generated", () => {
  test("it does not claim the operator supplied one, and generating twice keeps the first", () => {
    generateServerPassword()
    const first = Flag.MIMOCODE_SERVER_PASSWORD
    expect(first).toBeTruthy()
    // The distinction the containment rule keys on: we secured this, the user did not
    // ask for a reachable server.
    expect(Flag.MIMOCODE_SERVER_PASSWORD_SUPPLIED).toBe(false)

    generateServerPassword()
    // A second listener in the same process must not invalidate the credential the
    // first one is already authenticating against.
    expect(Flag.MIMOCODE_SERVER_PASSWORD).toBe(first)
  })

  test("an instance route now demands basic auth", async () => {
    await using tmp = await tmpdir({ git: true })
    const response = await get(`/config?directory=${encodeURIComponent(tmp.path)}`)
    expect(response.status).toBe(401)
    expect(response.headers.get("www-authenticate")).toContain("Basic")
    await Instance.disposeAll()
  })

  test("and reopens for a caller holding that password", async () => {
    await using tmp = await tmpdir({ git: true })
    const username = Flag.MIMOCODE_SERVER_USERNAME ?? "mimocode"
    const response = await get(`/config?directory=${encodeURIComponent(tmp.path)}`, {
      authorization: `Basic ${btoa(`${username}:${Flag.MIMOCODE_SERVER_PASSWORD}`)}`,
    })
    // The TUI's own worker transport builds exactly this header from the same Flag, which
    // is why the generated value has to live there rather than inside the server module.
    expect(response.status).toBe(200)
    await Instance.disposeAll()
  })

  test("the capability routes stay reachable with a minted token", async () => {
    await using tmp = await tmpdir({ git: true })
    const issued = await LLMServerTokens.issue({ directory: tmp.path, expiry: {} })
    const response = await get(`/v1/models?directory=${encodeURIComponent(tmp.path)}`, {
      authorization: `Bearer ${issued.token}`,
    })
    // The carve-out is the whole point: closing the instance API must not close the one
    // surface the listener was opened for.
    expect(response.status).toBe(200)
    expect((await response.json()) as { object: string }).toMatchObject({ object: "list" })
    await Instance.disposeAll()
  })

  test("the cwd containment rule survives the password", async () => {
    // The regression this guards: containment used to be conditional on "no password",
    // so generating one would have traded a wall for a wall. `/v1` bypasses basic auth
    // by design, so a token holder could then have aimed `?directory=` at any project on
    // the machine.
    const outside = os.tmpdir()
    const response = await get(`/v1/models?directory=${encodeURIComponent(outside)}`, {
      authorization: "Bearer irrelevant-because-the-directory-is-refused-first",
    })
    expect(response.status).toBe(403)
    await Instance.disposeAll()
  })
})
