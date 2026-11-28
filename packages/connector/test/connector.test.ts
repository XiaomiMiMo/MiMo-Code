import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { Connector, type ConnectorStatus } from "../src/connector"
import { StateFile } from "../src/state"
import { FakeBackend, MemorySecrets } from "./doubles"
import { FakeConnect } from "./fake-connect"

async function setup(
  options: {
    answer?: { canSend: boolean } | undefined
    confirm?: () => Promise<{ canSend: boolean } | undefined>
    secrets?: MemorySecrets
  } = {},
) {
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
          return options.confirm ? options.confirm() : answer
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
    async until(predicate: () => boolean | Promise<boolean>, ms = 3000) {
      const end = Date.now() + ms
      while (!(await predicate())) {
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

  // [TP-R61-04] An absent endpoint is not an empty profile list.
  for (const [discovery, reason] of [
    ["empty", "service_without_cli"],
    ["missing", "discovery_failed"],
    [["future-connector"], "protocol_incompatible"],
  ] as const) {
    test(`discovery ${discovery} reports ${reason} without registering a device`, async () => {
      await using s = await setup()
      s.service.discovery = discovery
      await s.connector.start()
      expect(s.connector.status).toEqual({ state: "unavailable", reason })
      expect(s.service.requests.map((r) => r.path)).toEqual(["/api/connect/connector-capabilities"])
    })
  }

  test("[TP-R61-04] device registration refusal 426 reports incompatible, not reconnecting", async () => {
    await using s = await setup()
    s.service.failNext.set("/api/connect/devices", [426, "protocol_incompatible"])
    await s.connector.start()
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "protocol_incompatible" })
    expect(s.service.devices.size).toBe(0)
  })

  test("[TP-R61-04] pairing refusal 426 does not produce a code or switch profiles", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const path = "/api/connect/pairing/challenges"
    s.service.failNext.set(path, [426, "protocol_incompatible"])
    expect(await s.connector.pair()).toBe("protocol_incompatible")
    expect(s.service.challenges.size).toBe(0)
    expect(s.service.requests.filter((r) => r.path === path).map((r) => r.headers.get("Mimo-Connect-Profile")))
      .toEqual(["cli-connector"])
  })

  test("[TP-R61-04] bus registration refusal 426 preserves the binding and stops serving it", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const paired = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    expect(await paired).toBe("approved")
    const bindingId = s.service.decisions.get(requestId)!.bindingId!
    await s.until(() => s.service.registrations.has(bindingId))
    await s.connector.stop()
    const path = `/api/connect/bindings/${bindingId}/bus-registration`
    const calls = () => s.service.requests.filter((r) => r.path === path).length
    const before = calls()
    s.service.failNext.set(path, [426, "protocol_incompatible"])
    await s.connector.start()
    await s.until(() => s.connector.status.state === "unavailable")
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "protocol_incompatible" })
    expect(s.service.bindings.get(bindingId)!.state).toBe("active")
    expect((await s.state()).consents[bindingId]).toBeDefined()
    await s.until(() => !s.service.subscriptions.has(`cmd:${bindingId}`))
    expect(calls()).toBe(before + 1)
  })

  test("an account outside the admission list is reported as such, not as a rejected sign-in", async () => {
    await using s = await setup()
    s.service.admitted = false
    await s.connector.start()
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "not_admitted" })
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
    // The group registered on the bus for this epoch and grant, after subscribing its command channel.
    const registration = s.service.registrations.get(bindingId)!
    expect(registration).toMatchObject({ connectionEpoch: 1, grantVersion: 1 })
    expect(s.service.subscriptions.has(`cmd:${bindingId}`)).toBe(true)

    // A phone request pushed on cmd is answered on that request's reply channel.
    const listRequestId = crypto.randomUUID()
    const dispatchId = s.service.phoneCommand(bindingId, {
      protocolVersion: 1,
      type: "sessions-list",
      requestId: listRequestId,
      grantVersion: registration.grantVersion,
      cursor: null,
      limit: 50,
    })
    await s.until(() => s.service.published.length > 0)
    const page = s.service.published[0]!
    expect(page.channel).toBe(`rep:${bindingId}:${listRequestId}`)
    expect(page.data).toMatchObject({
      lane: "command",
      frame: { type: "sessions-page", requestId: listRequestId, dispatchId, deviceGroupId: registration.deviceGroupId },
    })
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

  test("a confirmation from a retired control epoch cannot approve the pairing", async () => {
    const confirmation = Promise.withResolvers<{ canSend: boolean }>()
    await using s = await setup({ confirm: () => confirmation.promise })
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    await s.until(() => s.confirmations.length === 1)
    const epoch = s.service.epoch
    s.service.control!.close(1013, "lease_lost")
    await s.until(() => s.service.epoch > epoch && online(s.connector.status), 8000)
    confirmation.resolve({ canSend: true })
    expect(await outcome).toBe("cancelled")
    expect(s.service.requests.some(({ path }) => path.endsWith(`/${requestId}/approve`))).toBe(false)
    expect((await s.state()).pending).toEqual({})
  }, 20_000)

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

  test("unpairing revokes the binding, stops serving it and drops the consent", async () => {
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
    expect(s.service.bindings.get(bindingId)!.state).toBe("revoked")
    await s.until(() => (s.connector.status as { phones?: unknown[] }).phones?.length === 0)
    await s.until(() => !s.service.subscriptions.has(`cmd:${bindingId}`))
    expect((await s.state()).consents).toEqual({})
  })

  test("a binding revoked while offline is dropped on the next start and never served", async () => {
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
    s.service.bindings.get(bindingId)!.state = "revoked"
    const grants = s.service.requests.filter((r) => r.path.endsWith("/content-grant")).length
    const again = s.make()
    await again.start()
    await s.until(() => online(again.status) && (again.status as { phones: unknown[] }).phones.length === 0)
    expect((await s.state()).consents).toEqual({})
    expect(s.service.requests.filter((r) => r.path.endsWith("/content-grant")).length).toBe(grants)
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

  test("a lost grant answer is reconciled by reading the exact attempted grant", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    s.service.tamper.set(`/api/connect/pairing/requests/${requestId}/approve`, (response) => {
      const bindingId = [...s.service.bindings.keys()][0]
      s.service.tamper.set(`/api/connect/bindings/${bindingId}/content-grant`, () => new Response("", { status: 502 }))
      return response
    })
    expect(await outcome).toBe("approved")
    await s.until(() => s.connector.status.state === "online" && s.connector.status.phones[0]?.connected === true)
    const requests = s.service.requests.filter((request) => request.path.endsWith("/content-grant"))
    expect(requests.map(({ method }) => method)).toEqual(["PUT", "GET"])
    expect([...s.service.registrations.values()][0]).toMatchObject({ grantVersion: 1 })
  }, 20_000)

  test("expired proof retries only the original grant version", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    const requestId = s.claim()
    s.service.tamper.set(`/api/connect/pairing/requests/${requestId}/approve`, (response) => {
      const bindingId = [...s.service.bindings.keys()][0]
      s.service.failNext.set(`/api/connect/bindings/${bindingId}/content-grant`, [401, "proof_expired"])
      return response
    })
    expect(await outcome).toBe("approved")
    await s.until(() => s.connector.status.state === "online" && s.connector.status.phones[0]?.connected === true)
    const writes = s.service.requests.filter(({ method, path }) => method === "PUT" && path.endsWith("/content-grant"))
    expect(writes).toHaveLength(2)
    expect(writes[0].body).toMatchObject({ expectedVersion: 0, grantVersion: 1 })
    expect(writes[1].body).toEqual(writes[0].body)
  }, 20_000)

  test("an account that is gone on reconnect turns the connector unavailable instead of retrying", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    s.signOut()
    s.service.control!.close(1013, "lease_lost")
    await s.until(() => s.connector.status.state === "unavailable", 5000)
    expect(s.connector.status).toEqual({ state: "unavailable", reason: "not_signed_in" })
  })

  test("a binding the phone revokes while served is withdrawn on the bus and dropped locally", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    const bindingId = [...s.service.bindings.keys()][0]
    s.service.phoneRevokes(bindingId)
    await s.until(async () => Object.keys((await s.state()).consents).length === 0, 8000)
    await s.until(() => (s.connector.status as { phones?: unknown[] }).phones?.length === 0)
  }, 20_000)

  test("a refused reply ends the group and the binding is served again by a new group", async () => {
    await using s = await setup()
    await s.connector.start()
    await s.until(() => online(s.connector.status))
    const outcome = s.connector.pair()
    await s.until(() => [...s.service.challenges.values()].some((c) => c.status === "open"))
    s.claim()
    await outcome
    await s.until(() => (s.connector.status as { phones?: { connected: boolean }[] }).phones?.[0]?.connected === true)
    const bindingId = [...s.service.bindings.keys()][0]
    const first = s.service.registrations.get(bindingId)!
    s.service.refusePublish = 106
    s.service.phoneCommand(bindingId, {
      protocolVersion: 1,
      type: "sessions-list",
      requestId: crypto.randomUUID(),
      grantVersion: s.service.registrations.get(bindingId)!.grantVersion,
      cursor: null,
      limit: 50,
    })
    await s.until(() => s.service.registrations.get(bindingId)!.deviceGroupId !== first.deviceGroupId, 8000)
    await s.until(() => s.service.subscriptions.has(`cmd:${bindingId}`), 8000)
    expect(s.service.registrations.get(bindingId)).toMatchObject({
      connectionEpoch: first.connectionEpoch,
      grantVersion: first.grantVersion,
    })
    expect(
      s.service.requests.filter(({ method, path }) => method === "PUT" && path.endsWith("/content-grant")),
    ).toHaveLength(1)
  }, 20_000)
})
