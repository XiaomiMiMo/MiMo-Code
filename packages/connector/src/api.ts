// Typed Connect endpoints used by a CLI connector (role=cli, cli-connector-v1).
// Every response is parsed with a closed schema: unknown or missing fields are a
// protocol error, never silently tolerated.

import z from "zod"
import { ConnectError, type ConnectHttp } from "./http"

const ROOT = "/api/connect"
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const Count = z.number().int().nonnegative()
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

export const Scopes = z.union([
  z.tuple([z.literal("sessions:list"), z.literal("sessions:read")]),
  z.tuple([z.literal("sessions:list"), z.literal("sessions:read"), z.literal("sessions:send")]),
  z.tuple([]),
])
export type Scopes = z.infer<typeof Scopes>

export const BindingView = z.strictObject({
  bindingId: Uuid,
  phoneId: Uuid,
  connectorId: Uuid,
  connectorKind: z.literal("cli"),
  connectorName: z.string().min(1),
  state: z.enum(["active", "revoked"]),
  relayFence: z.enum(["pending", "complete"]),
  revocationVersion: Count,
})
export type BindingView = z.infer<typeof BindingView>

const Discovery = z.strictObject({ contract: z.literal("connector-discovery-v1"), profiles: z.array(z.string()) })
const Registered = z.strictObject({ deviceId: Uuid, role: z.literal("cli"), name: z.string().min(1) })
const Challenge = z.strictObject({ challengeId: Uuid, code: z.string().regex(/^\d{4}$/), expiresAt: Iso })
export const ChallengeStatus = z.strictObject({
  challengeId: Uuid,
  status: z.enum(["open", "claimed", "approved", "rejected", "cancelled", "expired"]),
  request: z.strictObject({ requestId: Uuid, phoneName: z.string() }).nullable(),
})
export type ChallengeStatus = z.infer<typeof ChallengeStatus>
const Decision = z.strictObject({
  requestId: Uuid,
  status: z.enum(["open", "claimed", "approved", "rejected", "cancelled", "expired"]),
  bindingId: Uuid.nullable(),
})
export type Decision = z.infer<typeof Decision>
const BindingsPage = z.strictObject({
  contract: z.literal("connector-bindings-v1"),
  deviceId: Uuid,
  bindings: z.array(z.strictObject({ binding: BindingView, phoneName: z.string() })),
  nextCursor: z.string().nullable(),
})
const UpgradeMetadata = z.strictObject({
  bindingId: Uuid,
  connectorId: Uuid,
  targetKind: z.literal("cli").nullable(),
  protocolVersion: z.literal(1).nullable(),
  grantVersion: Count,
})
export const GrantView = z.strictObject({
  protocolVersion: z.literal(1),
  targetKind: z.literal("cli"),
  bindingId: Uuid,
  connectorId: Uuid,
  grantVersion: z.number().int().positive(),
  revocationVersion: Count,
  connectionEpoch: z.number().int().positive(),
  state: z.enum(["active", "revoked"]),
  scopes: Scopes,
  relayFence: z.enum(["pending", "complete"]),
})
export type GrantView = z.infer<typeof GrantView>
export const Lane = z.enum(["command", "state", "text"])
export type Lane = z.infer<typeof Lane>
export const ChannelCredential = z.strictObject({
  protocolVersion: z.literal(1),
  targetKind: z.literal("cli"),
  bindingId: Uuid,
  connectorId: Uuid,
  role: z.literal("cli"),
  lane: Lane,
  deviceGroupId: Uuid,
  grantVersion: z.number().int().positive(),
  connectionEpoch: z.number().int().positive(),
  revocationVersion: Count,
  scopes: Scopes,
  token: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  audience: z.string(),
  expiresAt: z.number().int().positive(),
})
export type ChannelCredential = z.infer<typeof ChannelCredential>

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new ConnectError("protocol")
  return result.data
}

export class ConnectApi {
  constructor(private readonly http: ConnectHttp) {}

  /**
   * Whether the service offers the CLI profile. A legal not_found from a service
   * without the endpoint means "not offered"; every other failure is reported.
   */
  async offersCliProfile(): Promise<boolean> {
    try {
      const data = await this.http.request({
        method: "GET",
        path: `${ROOT}/connector-capabilities`,
          profile: false,
        proof: false,
      })
      return parse(Discovery, data).profiles.includes("cli-connector-v1")
    } catch (error) {
      if (error instanceof ConnectError && error.code === "not_found") return false
      throw error
    }
  }

  async register(name: string) {
    const data = await this.http.request({
      method: "POST",
      path: `${ROOT}/devices`,
      body: { role: "cli", name },
      profile: true,
      proof: true,
    })
    const registered = parse(Registered, data)
    if (registered.name !== name) throw new ConnectError("protocol")
    return registered
  }

  async createPairingCode(connectionEpoch: number) {
    return parse(Challenge, await this.post1(`${ROOT}/pairing/challenges`, { connectionEpoch }))
  }

  async pairingStatus(challengeId: string) {
    const status = parse(ChallengeStatus, await this.get1(`${ROOT}/pairing/challenges/${challengeId}`))
    if (status.challengeId !== challengeId) throw new ConnectError("protocol")
    return status
  }

  async cancelPairingCode(challengeId: string, connectionEpoch: number) {
    return this.post1(`${ROOT}/pairing/challenges/${challengeId}/cancel`, { connectionEpoch })
  }

  async decide(requestId: string, decision: "approve" | "reject" | "cancel", connectionEpoch: number) {
    const result = parse(
      Decision,
      await this.post1(`${ROOT}/pairing/requests/${requestId}/${decision}`, { connectionEpoch }),
    )
    if (result.requestId !== requestId) throw new ConnectError("protocol")
    return result
  }

  async pairingRequest(requestId: string) {
    const result = parse(Decision, await this.get1(`${ROOT}/pairing/requests/${requestId}`))
    if (result.requestId !== requestId) throw new ConnectError("protocol")
    return result
  }

  /** Every binding of this installation, active and revoked, across all pages. */
  async bindings(deviceId: string) {
    const all: { binding: BindingView; phoneName: string }[] = []
    let cursor: string | undefined
    for (let page = 0; page < 100; page++) {
      const data = await this.http.request({
        method: "GET",
        path: `${ROOT}/devices/${deviceId}/bindings`,
          query: cursor ? { cursor } : undefined,
        profile: true,
        proof: true,
      })
      const result = parse(BindingsPage, data)
      if (result.deviceId !== deviceId) throw new ConnectError("protocol")
      all.push(...result.bindings)
      if (result.nextCursor === null) return all
      cursor = result.nextCursor
    }
    throw new ConnectError("protocol")
  }

  async binding(bindingId: string) {
    const view = parse(BindingView, await this.get1(`${ROOT}/bindings/${bindingId}`))
    if (view.bindingId !== bindingId) throw new ConnectError("protocol")
    return view
  }

  async revoke(bindingId: string) {
    const view = parse(BindingView, await this.post1(`${ROOT}/bindings/${bindingId}/revoke`, {}))
    if (view.bindingId !== bindingId || view.state !== "revoked") throw new ConnectError("protocol")
    return view
  }

  async upgradeMetadata(bindingId: string, connectionEpoch: number) {
    const data = await this.http.request({
      method: "POST",
      path: `${ROOT}/bindings/${bindingId}/content-upgrade-metadata`,
      body: { connectionEpoch },
      profile: true,
      proof: true,
    })
    const meta = parse(UpgradeMetadata, data)
    if (meta.bindingId !== bindingId) throw new ConnectError("protocol")
    return meta
  }

  async publishGrant(
    bindingId: string,
    input: {
      connectionEpoch: number
      expectedVersion: number
      state: "active" | "revoked"
      scopes: Scopes
    },
  ) {
    const grantVersion = input.expectedVersion + 1
    const data = await this.http.request({
      method: "PUT",
      path: `${ROOT}/bindings/${bindingId}/content-grant`,
      body: {
        protocolVersion: 1,
        targetKind: "cli",
        connectionEpoch: input.connectionEpoch,
        expectedVersion: input.expectedVersion,
        grantVersion,
        state: input.state,
        scopes: [...input.scopes],
      },
      profile: true,
      proof: true,
    })
    const grant = parse(GrantView, data)
    if (grant.bindingId !== bindingId || grant.grantVersion !== grantVersion) throw new ConnectError("protocol")
    return grant
  }

  async grant(bindingId: string) {
    const grant = parse(GrantView, await this.get1(`${ROOT}/bindings/${bindingId}/content-grant`))
    if (grant.bindingId !== bindingId) throw new ConnectError("protocol")
    return grant
  }

  async channelToken(
    bindingId: string,
    input: { deviceGroupId: string; lane: Lane; grantVersion: number; connectionEpoch: number },
  ) {
    const data = await this.http.request({
      method: "POST",
      path: `${ROOT}/bindings/${bindingId}/content-channel-tokens/cli`,
      body: { protocolVersion: 1, ...input },
      profile: true,
      proof: true,
    })
    const credential = parse(ChannelCredential, data)
    if (
      credential.bindingId !== bindingId ||
      credential.lane !== input.lane ||
      credential.deviceGroupId !== input.deviceGroupId ||
      credential.grantVersion !== input.grantVersion ||
      credential.connectionEpoch !== input.connectionEpoch
    ) {
      throw new ConnectError("protocol")
    }
    return credential
  }

  private get1(path: string) {
    return this.http.request({ method: "GET", path, profile: true, proof: true })
  }

  private post1(path: string, body: Record<string, number>) {
    return this.http.request({ method: "POST", path, body, profile: true, proof: true })
  }
}
