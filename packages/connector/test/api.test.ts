import { describe, expect, test } from "bun:test"
import { harness } from "./helpers"

describe("Connect endpoints for the CLI role", () => {
  test("pairing: create a code, see the claim, approve with the current epoch", async () => {
    using h = await harness()
    await h.register()
    const code = await h.api.createPairingCode(7)
    expect(code.code).toMatch(/^\d{4}$/)
    expect(h.service.requests.at(-1)!.body).toEqual({ connectionEpoch: 7 })
    expect((await h.api.pairingStatus(code.challengeId)).status).toBe("open")
    const requestId = crypto.randomUUID()
    h.service.challenges.get(code.challengeId)!.status = "claimed"
    h.service.challenges.get(code.challengeId)!.request = { requestId, phoneName: "Pixel 9" }
    const claimed = await h.api.pairingStatus(code.challengeId)
    expect(claimed.request).toEqual({ requestId, phoneName: "Pixel 9" })
    const approved = await h.api.decide(requestId, "approve", 7)
    expect(approved.status).toBe("approved")
    expect(approved.bindingId).toMatch(/^[0-9a-f-]{36}$/)
  })

  test("bindings are read across pages", async () => {
    using h = await harness()
    const deviceId = await h.register()
    for (let i = 0; i < 3; i++) {
      const id = crypto.randomUUID()
      h.service.bindings.set(id, h.service.bindingView(id))
    }
    const all = await h.api.bindings(deviceId)
    expect(all).toHaveLength(3)
    // The cursor travels as a query string the proof does not sign.
    const pages = h.service.requests.filter((r) => r.path.endsWith("/bindings"))
    expect(pages).toHaveLength(3)
  })

  test("grant publish is a CAS on expectedVersion and tokens are bound to group, lane and epoch", async () => {
    using h = await harness()
    await h.register()
    const bindingId = crypto.randomUUID()
    h.service.bindings.set(bindingId, h.service.bindingView(bindingId))
    const meta = await h.api.upgradeMetadata(bindingId, 2)
    expect(meta.grantVersion).toBe(0)
    const grant = await h.api.publishGrant(bindingId, {
      connectionEpoch: 2,
      expectedVersion: 0,
      state: "active",
      scopes: ["sessions:list", "sessions:read", "sessions:send"],
    })
    expect(grant.grantVersion).toBe(1)
    expect(h.service.requests.at(-1)!.body).toMatchObject({ expectedVersion: 0, grantVersion: 1, targetKind: "cli" })
    const deviceGroupId = crypto.randomUUID()
    const token = await h.api.channelToken(bindingId, { deviceGroupId, lane: "state", grantVersion: 1, connectionEpoch: 2 })
    expect(token.lane).toBe("state")
    expect(token.deviceGroupId).toBe(deviceGroupId)
  })

  test("unknown or missing fields in a response are rejected", async () => {
    using h = await harness()
    await h.register()
    const bindingId = crypto.randomUUID()
    h.service.bindings.set(bindingId, { ...h.service.bindingView(bindingId), desktopId: crypto.randomUUID() })
    await expect(h.api.binding(bindingId)).rejects.toMatchObject({ code: "protocol" })
    const { connectorKind: _, ...missing } = h.service.bindingView(bindingId)
    h.service.bindings.set(bindingId, missing)
    await expect(h.api.binding(bindingId)).rejects.toMatchObject({ code: "protocol" })
  })
})
