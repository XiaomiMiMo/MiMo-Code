import { describe, expect, test } from "bun:test"
import { advertiseListeningServer, unadvertiseListeningServer } from "../../../src/cli/cmd/serve"
import { LLMServerTokens } from "../../../src/llm-server/tokens"
import { tmpdir } from "../../fixture/fixture"

/**
 * `mimo serve` must publish the same address contract the TUI worker publishes.
 *
 * `llm-server issue` only mints credentials; it reads the live endpoint from
 * `LLMServerTokens.address(process.cwd())`. A serve process that listens but never
 * publishes yields `base_url: null` even though `/v1` would accept the token.
 */

describe("mimo serve address advertisement", () => {
  test("publishes pid/hostname/port/url/started so issue can resolve base_url", async () => {
    await using tmp = await tmpdir()
    const url = new URL("http://127.0.0.1:4242")

    expect(await LLMServerTokens.address(tmp.path)).toBeUndefined()

    await advertiseListeningServer(tmp.path, {
      hostname: "127.0.0.1",
      port: 4242,
      url,
    })

    const address = await LLMServerTokens.address(tmp.path)
    expect(address).toMatchObject({
      pid: process.pid,
      hostname: "127.0.0.1",
      port: 4242,
      url: url.toString(),
    })
    expect(address!.started).toBeGreaterThan(0)

    // The same join `llm-server issue` uses for `base_url`.
    const baseUrl = `${address!.url.replace(/\/$/, "")}/v1`
    expect(baseUrl).toBe("http://127.0.0.1:4242/v1")
  })

  test("unpublishes on shutdown so list no longer shows this process", async () => {
    await using tmp = await tmpdir()
    await advertiseListeningServer(tmp.path, {
      hostname: "127.0.0.1",
      port: 4243,
      url: new URL("http://127.0.0.1:4243"),
    })
    expect(await LLMServerTokens.address(tmp.path)).toMatchObject({ port: 4243 })

    await unadvertiseListeningServer(tmp.path)
    expect(await LLMServerTokens.address(tmp.path)).toBeUndefined()
    expect(await LLMServerTokens.addresses(tmp.path)).toEqual([])
  })

  test("does not clobber another live listener's advertisement", async () => {
    await using tmp = await tmpdir()
    const now = Date.now()
    await LLMServerTokens.publish(tmp.path, {
      pid: process.ppid,
      hostname: "127.0.0.1",
      port: 1111,
      url: "http://127.0.0.1:1111/",
      started: now - 1000,
    })

    await advertiseListeningServer(tmp.path, {
      hostname: "127.0.0.1",
      port: 2222,
      url: new URL("http://127.0.0.1:2222"),
    })

    // Newest first: the serve process is what a human just started.
    expect(await LLMServerTokens.addresses(tmp.path)).toMatchObject([{ port: 2222 }, { port: 1111 }])

    await unadvertiseListeningServer(tmp.path)
    expect(await LLMServerTokens.addresses(tmp.path)).toMatchObject([{ port: 1111 }])
  })
})
