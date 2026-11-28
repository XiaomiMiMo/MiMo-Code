// Typed Connect endpoints used by a CLI connector (role=cli, profile cli-connector).
// Forward compatibility (connect-protocol R63): inbound objects validate their
// required and optional fields and ignore unregistered fields, while still
// rejecting forbidden cross-view identity fields and failing closed on
// unregistered authorization/binding/pairing enum values.

import z from "zod"
import { ConnectError, type ConnectHttp } from "./http"

const ROOT = "/api/connect"
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const Count = z.number().int().nonnegative()
const Iso = z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/)

const KNOWN_CLI_SCOPES = new Set(["sessions:list", "sessions:read", "sessions:send"])

export type Scopes =
  | []
  | ["sessions:list", "sessions:read"]
  | ["sessions:list", "sessions:read", "sessions:send"]

/**
 * Unregistered scopes are ignored (treated as ungranted) without rejecting the
 * known scopes of the grant (connect-protocol R63).
 */
export const Scopes = z.array(z.string()).transform((raw, ctx): Scopes => {
  const known = raw.filter((scope) => KNOWN_CLI_SCOPES.has(scope))
  if (new Set(known).size !== known.length) {
    ctx.addIssue({ code: "custom", message: "duplicate scope" })
    return z.NEVER
  }
  if (known.length === 0) return []
  if (known.length === 2 && known.includes("sessions:list") && known.includes("sessions:read")) {
    return ["sessions:list", "sessions:read"]
  }
  if (
    known.length === 3 &&
    known.includes("sessions:list") &&
    known.includes("sessions:read") &&
    known.includes("sessions:send")
  ) {
    return ["sessions:list", "sessions:read", "sessions:send"]
  }
  ctx.addIssue({ code: "custom", message: "invalid cli scopes" })
  return z.NEVER
})

/** Reject mutually-exclusive Desktop view identity fields mixed into a CLI view (R63). */
const FORBIDDEN_DESKTOP_FIELDS = ["desktopId", "desktopName"] as const

function withoutDesktopFields<T extends z.ZodRawShape>(shape: T) {
  return z.preprocess((raw) => {
    if (typeof raw === "object" && raw !== null && FORBIDDEN_DESKTOP_FIELDS.some((key) => key in raw)) {
      return null
    }
    return raw
  }, z.object(shape))
}

export const BindingView = withoutDesktopFields({
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

const Discovery = z.object({ contract: z.literal("connector-discovery"), profiles: z.array(z.string()) })
const Registered = z.object({ deviceId: Uuid, role: z.literal("cli"), name: z.string().min(1) })
const Challenge = z.object({ challengeId: Uuid, code: z.string().regex(/^\d{4}$/), expiresAt: Iso })
export const ChallengeStatus = z.object({
  challengeId: Uuid,
  status: z.enum(["open", "claimed", "approved", "rejected", "cancelled", "expired"]),
  request: z.object({ requestId: Uuid, phoneName: z.string() }).nullable(),
})
export type ChallengeStatus = z.infer<typeof ChallengeStatus>
const Decision = z.object({
  requestId: Uuid,
  status: z.enum(["open", "claimed", "approved", "rejected", "cancelled", "expired"]),
  bindingId: Uuid.nullable(),
})
export type Decision = z.infer<typeof Decision>
const BindingsPage = z.object({
  contract: z.literal("connector-bindings"),
  deviceId: Uuid,
  bindings: z.array(z.object({ binding: BindingView, phoneName: z.string() })),
  nextCursor: z.string().nullable(),
})
const UpgradeMetadata = withoutDesktopFields({
  bindingId: Uuid,
  connectorId: Uuid,
  targetKind: z.literal("cli").nullable(),
  protocolVersion: z.literal(1).nullable(),
  grantVersion: Count,
})
export const GrantView = withoutDesktopFields({
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
export const BusRegistration = z.object({
  protocolVersion: z.literal(1),
  bindingId: Uuid,
  deviceGroupId: Uuid,
  connectionEpoch: z.number().int().positive(),
  grantVersion: z.number().int().positive(),
  expiresInMs: z.number().int().positive(),
})
export type BusRegistration = z.infer<typeof BusRegistration>

function parse<T>(schema: z.ZodType<T>, data: unknown): T {
  const result = schema.safeParse(data)
  if (!result.success) throw new ConnectError("protocol")
  return result.data
}

export class ConnectApi {
  constructor(private readonly http: ConnectHttp) {}

  /** Only a valid empty discovery response means the service has not enabled CLI. */
  async offersCliProfile(): Promise<boolean> {
    const data = await this.http.request({
      method: "GET",
      path: `${ROOT}/connector-capabilities`,
      profile: false,
      proof: false,
    }).catch((error: unknown) => {
      if (error instanceof ConnectError && error.code === "not_found") {
        throw new ConnectError("discovery_failed", error.status, error.retryAfterMs, error.requestId)
      }
      throw error
    })
    const { profiles } = parse(Discovery, data)
    if (new Set(profiles).size !== profiles.length) throw new ConnectError("protocol")
    if (profiles.length === 0) return false
    if (!profiles.includes("cli-connector")) throw new ConnectError("protocol_incompatible")
    return true
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

  /**
   * Register (or renew) this connector's bus group for the current epoch and
   * grant (bus-channel §4.3). A CLI connector declares nothing beyond the group.
   */
  async busRegistration(
    bindingId: string,
    input: { deviceGroupId: string; grantVersion: number; connectionEpoch: number },
  ) {
    const data = await this.http.request({
      method: "POST",
      path: `${ROOT}/bindings/${bindingId}/bus-registration`,
      body: {
        protocolVersion: 1,
        connectionEpoch: input.connectionEpoch,
        grantVersion: input.grantVersion,
        deviceGroupId: input.deviceGroupId,
      },
      profile: true,
      proof: true,
    })
    const registration = parse(BusRegistration, data)
    if (
      registration.bindingId !== bindingId ||
      registration.deviceGroupId !== input.deviceGroupId ||
      registration.grantVersion !== input.grantVersion ||
      registration.connectionEpoch !== input.connectionEpoch
    ) {
      throw new ConnectError("protocol")
    }
    return registration
  }

  private get1(path: string) {
    return this.http.request({ method: "GET", path, profile: true, proof: true })
  }

  private post1(path: string, body: Record<string, number>) {
    return this.http.request({ method: "POST", path, body, profile: true, proof: true })
  }
}
