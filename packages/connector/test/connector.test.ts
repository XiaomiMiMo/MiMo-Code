import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Connector, type ConnectorStatus } from "../src/connector"
import { StateFile } from "../src/state"
import { FakeBackend, MemorySecrets } from "./doubles"
import { FakeConnect } from "./fake-connect"

async function setup(options: { answer?: { canSend: boolean } | undefined; secrets?: MemorySecrets } = {}) {
  let signedIn = true
  const dir = await mkdtemp(path.join(tmpdir(), "connector-"))
  const service = new FakeConnect().start()
  const secrets = options.secrets ?? new MemorySecrets()
  const backend = new FakeBackend()
  const statuses: ConnectorStatus[] = []
  const confirmations: { phoneName: string; code: string }[] = []
  const answer = "answer" in options ? options.answer : { canSend: true }
  const stateFile = path.join(dir, "state")
  const make = () =>
    new Connector({
      backend,
      secrets,
      stateFile,
      account: async () => (signedIn ? { ...service.account(), subject: "subject-1" } : undefined),
      client: { version: "1.0.0", platform: "linux" },
      name: "dev-box",
      host: {
        confirmPairing: async (request) => {
          confirmations.push(request)
          return answer
        },
        status: (status) => statuses.push(status),
      },
      pairingPollMs: 20,
    })
  const connector = make()
  return {
    dir,
    service,
    secrets,
    backend,
    statuses,
    confirmations,
    connector,
    make,
    state: () => new StateFile(stateFile, secrets).read(),
    signOut: () => (signedIn = false),
    async until(predicate: () => boolean, ms = 3000) {
      const end = Date.now() + ms
      while (!predicate()) {
        if (Date.now() > end) throw new Error("timed out waiting")
        await Bun.sleep(10)
      }
    },
    /** Let a phone claim the code currently shown. */
    claim(phoneName = "Pixel") {
      const challenge = [...service.challenges.values()].find((c) => c.status === "open")!
      challenge.status = "claimed"
      challenge.request = { requestId: crypto.randomUUID(), phoneName }
      return challenge.request.requestId
    },
    async [Symbol.asyncDispose]() {
      await connector.stop()
      service.stop()
      await rm(dir, { recursive: true, force: true })
    },
  }
}

const online = (status: ConnectorStatus) => status.state === "online"

describe("connector", () => {
  test("without a protected store it stays off and touches nothing", async () => {
    const secrets = new MemorySecrets()
    secrets.unavailable = true
    await using s = await setup({ secrets })
    await s.connector.start()
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "secure_storage_unavailable" })
    expect(s.service.requests).toEqual([])
  })

  test("a service without the CLI profile is reported, not retried", async () => {
    await using s = await setup()
    s.service.discovery = "empty"
    await s.connector.start()
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "service_without_cli" })
  })

  test("start registers once, goes online and keeps the key in the protected store", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    expect(s.service.devices.size).toBe(1)
    expect(s.secrets.values.has("device-key")).toBe(true)
    expect((await s.state()).installation?.deviceId).toBe([...s.service.devices.keys()][0])
    await s.connector.stop()
    const again = s.make()
    await again.start()
    await s.until(() => online(again.status))
    expect(s.service.requests.filter((r) => r.path === "/api/connect/devices").length).toBe(1)
    await again.stop()
  })

  test("pairing approves only after local confirmation and then serves the phone", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(
      () => s.connector.status.state === "online" && "pairing" in s.connector.status && !!s.connector.status.pairing,
    )
    const shown = (s.connector.status as { pairing: { code: string } }).pairing.code
    expect(shown).toMatch(/^\d{4}$/)
    const requestId = s.claim("Pixel 9")
    expect(await outcome).toBe("approved")
    expect(s.confirmations).toEqual([{ phoneName: "Pixel 9", code: shown }])
    expect(s.service.decisions.get(requestId)?.status).toBe("approved")

    const bindingId = s.service.decisions.get(requestId)!.bindingId!
    await s.until(() => {
      const status = s.connector.status
      return status.state === "online" && status.phones.some((p) => p.connected)
    })
    expect((s.connector.status as { phones: unknown[] }).phones).toEqual([
      { bindingId, phoneName: "Pixel 9", canSend: true, connected: true },
    ])
    const state = await s.state()
    expect(state.consents[bindingId]).toMatchObject({
      subject: "subject-1",
      scopes: ["sessions:list", "sessions:read", "sessions:send"],
    })
    expect(state.pending).toEqual({})
    expect(Object.keys(state.gates).sort()).toEqual([`${bindingId}:command`, `${bindingId}:state`, `${bindingId}:text`])

    // A forwarded phone request is answered on the command lane.
    const attach = s.service.frames.findLast((f) => f.path.endsWith("/command") && f.frame.type === "attach")!.frame
    const request = {
      protocolVersion: 4,
      type: "request",
      operation: "sessions-list",
      bindingId,
      connectionEpoch: attach.connectionEpoch,
      deviceGroupId: attach.deviceGroupId,
      requestId: crypto.randomUUID(),
      grantVersion: attach.grantVersion,
      dispatchId: crypto.randomUUID(),
      cursor: null,
      limit: 50,
    }
    s.service.sendOnLane("command", request)
    await s.until(() => s.service.frames.some((f) => f.frame.type === "sessions-page"))
    const page = s.service.frames.find((f) => f.frame.type === "sessions-page")!
    expect(page.path).toBe("/api/connect/content-relay/command")
    expect(page.frame).toMatchObject({ requestId: request.requestId, dispatchId: request.dispatchId })
  })

  test("a phone the user declines is rejected and never bound", async () => {
    await using s = await setup({ answer: undefined })
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    expect(await outcome).toBe("rejected")
    expect(s.service.decisions.get(requestId)?.status).toBe("rejected")
    expect(s.service.bindings.size).toBe(0)
    expect((await s.state()).consents).toEqual({})
  })

  test("a read-only consent publishes a grant without the send scope", async () => {
    await using s = await setup({ answer: { canSend: false } })
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    expect(await outcome).toBe("approved")
    await s.until(() => s.service.grants.size === 1)
    expect([...s.service.grants.values()][0].scopes).toEqual(["sessions:list", "sessions:read"])
  })

  test("after a reconnect each bound phone gets a new grant for the new epoch", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    const first = [...s.service.grants.values()][0]
    s.service.control!.close(1013, "lease_lost")
    await s.until(() => {
      const grant = [...s.service.grants.values()][0]
      return (grant.connectionEpoch as number) > (first.connectionEpoch as number)
    }, 6000)
    const second = [...s.service.grants.values()][0]
    expect(second.grantVersion).toBe((first.grantVersion as number) + 1)
    expect(second.scopes).toEqual(first.scopes)
  })

  test("unpairing revokes the binding, confirms it on the lanes and drops the consent", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    const bindingId = [...s.service.bindings.keys()][0]
    await s.connector.unpair(bindingId)
    await s.until(() => s.service.confirmedRevocations.has(bindingId))
    await s.until(() => (s.connector.status as { phones?: unknown[] }).phones?.length === 0)
    let state = await s.state()
    const end = Date.now() + 3000
    while (Object.keys(state.gates).length > 0 && Date.now() < end) {
      await Bun.sleep(10)
      state = await s.state()
    }
    expect(state.consents).toEqual({})
    expect(state.gates).toEqual({})
  })

  test("a binding revoked while offline is confirmed with recovery credentials on the next start", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    await s.connector.stop()
    const bindingId = [...s.service.bindings.keys()][0]
    const view = s.service.bindings.get(bindingId)!
    view.state = "revoked"
    view.relayFence = "pending"
    const again = s.make()
    await again.start()
    await s.until(() => s.service.confirmedRevocations.has(bindingId), 5000)
    await s.until(() => online(again.status) && (again.status as { phones: unknown[] }).phones.length === 0)
    expect((await s.state()).consents).toEqual({})
    await again.stop()
  })

  test("a second connector on the same installation stays off while the first runs", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const second = s.make()
    await second.start()
    expect(second.status).toEqual({ state: "unavailable", reason: "in_use" })
    await s.connector.stop()
    await second.start()
    await s.until(() => online(second.status))
    await second.stop()
  })

  test("stopping while starting leaves nothing connected", async () => {
    await using s = await setup()
    const starting = s.connector.start()
    await s.connector.stop()
    await starting
    await Bun.sleep(200)
    expect(s.connector.status).toEqual({ state: "off" })
    expect(s.service.control).toBeUndefined()
  })

  test("a failed binding read after connecting is retried until the phone is served", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    const deviceId = [...s.service.devices.keys()][0]
    // Like the real service, the rejection says when to come back.
    s.service.failNext.set(`/api/connect/devices/${deviceId}/bindings`, [503, "dependency_unavailable", "1"])
    const grants = s.service.requests.filter((r) => r.path.endsWith("/content-grant")).length
    s.service.control!.close(1013, "lease_lost")
    await s.until(() => s.service.requests.filter((r) => r.path.endsWith("/content-grant")).length > grants, 8000)
    await s.until(
      () => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true,
      8000,
    )
  }, 20_000)

  test("a lost approve answer still ends with the phone paired and served", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    // The service commits the approval, but its answer never arrives.
    s.service.tamper.set(`/api/connect/pairing/requests/${requestId}/approve`, () => new Response("", { status: 502 }))
    expect(await outcome).toBe("approved")
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
  })

  test("an account that is gone on reconnect turns the connector unavailable instead of retrying", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    s.signOut()
    s.service.control!.close(1013, "lease_lost")
    await s.until(() => s.connector.status.state === "unavailable", 5000)
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "not_signed_in" })
  })
})
