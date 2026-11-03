import { describe, expect, test } from "bun:test"
import { canonical } from "../src/json"
import { bodyDigest, generateDeviceKey, importDeviceKey, keyThumbprint } from "../src/proof"
import { harness } from "./helpers"

describe("canonical JSON", () => {
  test("orders object members and keeps integers only", () => {
    expect(canonical({ b: 1, a: [true, null, "x"], c: { z: 0, y: "é" } })).toBe('{"a":[true,null,"x"],"b":1,"c":{"y":"é","z":0}}')
    expect(() => canonical({ n: 1.5 })).toThrow()
  })
})

describe("device proof", () => {
  test("digests match the values the service hard-codes", async () => {
    expect(await bodyDigest(undefined)).toBe("e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855")
    expect(await bodyDigest({})).toBe("44136fa355b3678a1146ad16f7e8649e94fb4fc21fe77e8310c060f61caaff8a")
  })

  test("a stored private JWK restores the same key and thumbprint", async () => {
    const { key, privateJwk } = await generateDeviceKey()
    const restored = await importDeviceKey(privateJwk)
    expect(restored.jwk).toEqual(key.jwk)
    expect(await keyThumbprint(restored.jwk)).toBe(await keyThumbprint(key.jwk))
    await expect(importDeviceKey({ ...privateJwk, d: undefined })).rejects.toThrow()
  })

  test("the service accepts the proof: signature, claims, body digest and single-use nonce", async () => {
    using h = await harness()
    const deviceId = await h.register()
    expect(h.service.devices.get(deviceId)?.name).toBe("dev-box")
    // A second registration with the same key is idempotent on the service side.
    expect(await h.register()).toBe(deviceId)
    const register = h.service.requests.filter((r) => r.path === "/api/connect/devices")
    expect(register.every((r) => r.headers.get("X-Device-Proof"))).toBe(true)
    expect(register.every((r) => r.headers.get("X-Device-Id") === null || r.headers.get("X-Device-Id") === deviceId)).toBe(true)
  })

  test("a proof from another key is rejected by the service", async () => {
    using h = await harness()
    await h.register()
    const other = (await generateDeviceKey()).key
    const { ConnectHttp } = await import("../src/http")
    const { ConnectApi } = await import("../src/api")
    const impostor = new ConnectApi(
      new ConnectHttp({
        account: () => h.service.account(),
        key: other,
        deviceId: () => h.state.deviceId,
        client: { version: "1.2.3", platform: "linux" },
      }),
    )
    await expect(impostor.binding(crypto.randomUUID())).rejects.toMatchObject({ code: "forbidden", status: 403 })
  })
})
