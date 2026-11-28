// Connect HTTP transport for the CLI connector role.
//
// One request = one device-challenge + one proof (Connect consumes the nonce).
// Responses are checked strictly: envelope shape, selected version, request-id
// echo and profile echo. Service rejections keep their code; rate limits record a
// cooldown from Retry-After so callers back off instead of hammering the service.
// Nothing here retries on its own: whether a failed write may be re-sent is the
// caller's decision.

import { canonical, decodeWireUtf8, parseObject, WireJsonTooDeep, type Json } from "./json"
import { deviceProof, keyThumbprint, type DeviceKey } from "./proof"

export const PROFILE = "cli-connector"
const PROFILE_HEADER = "Mimo-Connect-Profile"
/** Connect public HTTP envelope nesting ceiling (connect-protocol R63). */
export const HTTP_MAX_DEPTH = 16

const PROOF_EXPIRED = "proof_expired"

/** Registered Connect HTTP error codes and statuses (connect-protocol R63). */
const HTTP_ERROR_STATUS = new Map([
  ["invalid_request", 400],
  ["feedback_content_rejected", 400],
  ["unauthenticated", 401],
  ["proof_rejected", 401],
  [PROOF_EXPIRED, 401],
  ["credential_rejected", 401],
  ["forbidden", 403],
  ["scope_forbidden", 403],
  ["grant_unavailable", 403],
  ["allowlist_denied", 403],
  ["binding_revoked", 403],
  ["not_found", 404],
  ["method_not_allowed", 405],
  ["conflict", 409],
  ["grant_changed", 409],
  ["fence_pending", 409],
  ["relay_busy", 409],
  ["desktop_offline", 409],
  ["unsupported", 409],
  ["expired", 410],
  ["message_too_large", 413],
  ["protocol_incompatible", 426],
  ["rate_limited", 429],
  ["internal_error", 500],
  ["route_unavailable", 503],
  ["dependency_unavailable", 503],
  ["outcome_unknown", 504],
  // These are registered by Connect's service for the existing route/control endpoints.
  ["credential_expired", 401],
  ["route_cross_node", 503],
  ["control_target_forbidden", 403],
  ["control_context_changed", 409],
  ["control_target_unavailable", 503],
])

/** Registered error codes that represent a terminal account / device auth rejection. */
export const ACCOUNT_REJECTION_CODES = new Set([
  "unauthenticated",
  "forbidden",
  "proof_rejected",
  "scope_forbidden",
])

/**
 * The account the CLI is signed in as: a Xiaomi Passport credential (`serviceToken`
 * and plain `userId`, xiaomi-account §3.2) or an isolated debug identity, which is a
 * bare bearer issued by a non-production Connect service.
 */
export type AccountSession = {
  /** Connect public origin, e.g. `https://connect.example`; also the proof audience. */
  origin: string
  environment: string
  /** `Authorization: Bearer` value: the Passport serviceToken or the debug access token. */
  serviceToken: string
  /** `Mimo-Passport-User`; absent only for a debug identity. */
  userId?: string
}

export const PASSPORT_USER_HEADER = "Mimo-Passport-User"

export type ClientInfo = {
  /** Version of the running CLI; sent as X-Client-Version only when it is a release semver. */
  version: string
  platform: "macos" | "windows" | "linux"
}

export class ConnectError extends Error {
  constructor(
    /** Service error code, or a client-side kind: `protocol`, `network`, `cooldown`, `handshake`. */
    readonly code: string,
    readonly status?: number,
    /** Milliseconds the service asked us to wait (429/503 and cooldown). */
    readonly retryAfterMs?: number,
    readonly requestId?: string,
  ) {
    super(code)
    this.name = "ConnectError"
  }

  /** Whether the service answered with an unregistered HTTP error code (connect-protocol R63). */
  get unregistered(): boolean {
    return this.status !== undefined && !HTTP_ERROR_STATUS.has(this.code) && this.code !== "protocol" && this.code !== "unavailable" && this.code !== "too_deep"
  }

  /** Rejections that a later identical attempt may succeed on without a new user decision. */
  get transient(): boolean {
    return (
      this.code === "network" ||
      this.code === "cooldown" ||
      this.code === "unavailable" ||
      this.code === "too_deep" ||
      this.code === PROOF_EXPIRED ||
      this.status === 429 ||
      this.status === 503 ||
      this.code === "desktop_offline" ||
      this.unregistered
    )
  }
}

export type HttpRequest = {
  method: "GET" | "POST" | "PUT"
  path: string
  body?: Json
  /** Only the bindings list takes a query; it is not part of the signed path. */
  query?: Record<string, string>
  /** Send `Mimo-Connect-Profile: cli-connector` and require its echo. */
  profile: boolean
  /** Attach a device proof (and X-Device-Id when the device is registered). */
  proof: boolean
}

export type HttpOptions = {
  account: () => AccountSession
  /** Device key for proofs; account calls without a proof need none. */
  key?: DeviceKey
  deviceId: () => string | undefined
  client: ClientInfo
  fetch?: typeof fetch
  /** Milliseconds clock for cooldowns. */
  clock?: () => number
}

export const CONTRACT_VERSION = "1.0"
const SEMVER = /^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)(-[0-9A-Za-z.-]+)?(\+[0-9A-Za-z.-]+)?$/
const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
const LOGIN_INSTANCE = /^[0-9a-f]{32}$/
const ISO = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(\.\d+)?Z$/
/** A challenge never lives longer than this (plus the service's small overshoot). */
const MAX_CHALLENGE_MS = 61_000
/** Connect envelopes are bounded; a larger body is not a Connect response. */
const MAX_RESPONSE_BYTES = 65536
const JSON_CONTENT_TYPE = /^application\/json(?:[ \t]*;[ \t]*charset=(?:utf-8|"utf-8"))?$/i
const OUTER_GATEWAY_STATUSES = new Set([502, 503, 504])
const REQUEST_TIMEOUT_MS = 10_000

export class ConnectHttp {
  private cooldownUntil = 0
  private readonly fetch: typeof fetch
  private readonly clock: () => number

  constructor(private readonly options: HttpOptions) {
    this.fetch = options.fetch ?? fetch
    this.clock = options.clock ?? Date.now
  }

  /** Remaining cooldown requested by the service, 0 when requests may be sent. */
  cooldownRemainingMs(): number {
    return Math.max(0, this.cooldownUntil - this.clock())
  }

  async request(input: HttpRequest): Promise<Record<string, unknown>> {
    const wait = this.cooldownRemainingMs()
    if (wait > 0) throw new ConnectError("cooldown", undefined, wait)
    const account = this.options.account()
    const headers = await this.headers(account, input)
    headers.set("Mimo-Connect-Version", CONTRACT_VERSION)
    if (input.body !== undefined) headers.set("Content-Type", "application/json")
    const query = input.query ? `?${new URLSearchParams(input.query).toString()}` : ""
    const response = await this.send(`${account.origin}${input.path}${query}`, {
      method: input.method,
      headers,
      body: input.body === undefined ? undefined : canonical(input.body),
      redirect: "manual",
      signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
    })
    return this.unwrap(response, input, headers.get("Mimo-Request-Id")!)
  }

  /**
   * Headers for a WSS handshake: credential, proof, device id and request id, plus
   * the mechanisms to negotiate; never version or profile. The 101 must echo the
   * request id and every mechanism (see `DialInput.echo`).
   */
  async handshakeHeaders(path: string, mechanisms: Record<string, string>): Promise<Headers> {
    const wait = this.cooldownRemainingMs()
    if (wait > 0) throw new ConnectError("cooldown", undefined, wait)
    const headers = await this.headers(this.options.account(), { method: "GET", path, profile: false, proof: true })
    for (const [name, value] of Object.entries(mechanisms)) headers.set(name, value)
    return headers
  }

  /** Record a Retry-After the service sent on a rate-limit, unavailable or unregistered-code refusal. */
  noteRetryAfter(status: number, retryAfter: string | null, honorAlways = false): void {
    const seconds = Number(retryAfter)
    const validSeconds = Number.isInteger(seconds) && seconds > 0 && seconds <= 600
    if (status === 429 || status === 503) {
      const delay = validSeconds ? seconds * 1000 : 60_000
      this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + delay)
    } else if (honorAlways && validSeconds) {
      this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + seconds * 1000)
    }
  }

  private async headers(account: AccountSession, input: HttpRequest): Promise<Headers> {
    const headers = new Headers({
      Authorization: `Bearer ${account.serviceToken}`,
      "Mimo-Request-Id": crypto.randomUUID(),
      "X-Client-Platform": this.options.client.platform,
    })
    if (account.userId !== undefined) headers.set(PASSPORT_USER_HEADER, account.userId)
    // Optional and diagnostic; a development build without a release version leaves it out.
    if (SEMVER.test(this.options.client.version)) headers.set("X-Client-Version", this.options.client.version)
    if (input.profile) headers.set(PROFILE_HEADER, PROFILE)
    if (!input.proof) return headers
    const key = this.options.key
    if (!key) throw new Error("a device proof needs the device key")
    const challenge = await this.challenge(account, key, input.method, input.path)
    headers.set(
      "X-Device-Proof",
      await deviceProof({
        key,
        origin: account.origin,
        loginInstanceId: challenge.loginInstanceId,
        environment: account.environment,
        method: input.method,
        path: input.path,
        body: input.body,
        nonce: challenge.nonce,
        issuedAt: challenge.issuedAt,
        notAfter: challenge.notAfter,
      }),
    )
    const deviceId = this.options.deviceId()
    if (deviceId) headers.set("X-Device-Id", deviceId)
    return headers
  }

  /**
   * One device challenge, bound to this login, key, method and path. The proof is
   * issued at the service time the challenge carries: the local clock never stands
   * in for the service clock, which accepts a proof at most 1 s ahead of its own.
   */
  private async challenge(account: AccountSession, key: DeviceKey, method: string, path: string) {
    const data = await this.request({
      method: "POST",
      path: "/api/connect/device-challenges",
      body: { method, path, keyThumbprint: await keyThumbprint(key.jwk) },
      profile: false,
      proof: false,
    })
    const serverTime = typeof data.serverTime === "string" && ISO.test(data.serverTime) ? Date.parse(data.serverTime) : NaN
    const expiresAt = typeof data.expiresAt === "string" && ISO.test(data.expiresAt) ? Date.parse(data.expiresAt) : NaN
    if (
      typeof data.nonce !== "string" ||
      !UUID.test(data.nonce) ||
      typeof data.loginInstanceId !== "string" ||
      !LOGIN_INSTANCE.test(data.loginInstanceId) ||
      data.environment !== account.environment ||
      !(expiresAt - serverTime > 0 && expiresAt - serverTime <= MAX_CHALLENGE_MS)
    ) {
      throw new ConnectError("protocol")
    }
    const issuedAt = Math.floor(serverTime / 1000)
    const notAfter = Math.floor(expiresAt / 1000)
    if (notAfter <= issuedAt) throw new ConnectError("protocol")
    return { nonce: data.nonce, loginInstanceId: data.loginInstanceId, issuedAt, notAfter }
  }

  private async send(url: string, init: RequestInit): Promise<Response> {
    try {
      return await this.fetch(url, init)
    } catch {
      throw new ConnectError("network")
    }
  }

  private async unwrap(response: Response, input: HttpRequest, sentId: string): Promise<Record<string, unknown>> {
    if (response.status >= 300 && response.status < 400) throw new ConnectError("protocol", response.status)
    this.noteRetryAfter(response.status, response.headers.get("Retry-After"))
    const headerId = response.headers.get("Mimo-Request-Id")
    const outerGateway = OUTER_GATEWAY_STATUSES.has(response.status) && headerId === null
    const noAnswer = () => new ConnectError("unavailable", response.status, this.cooldownRemainingMs())
    const protocolError = () => new ConnectError("protocol", response.status)
    if (!JSON_CONTENT_TYPE.test(response.headers.get("Content-Type") ?? "")) {
      void response.body?.cancel().catch(() => {})
      throw outerGateway ? noAnswer() : protocolError()
    }
    const bytes = await readBoundedBody(response)
    let envelope: Record<string, unknown>
    try {
      envelope = parseObject(decodeWireUtf8(bytes), HTTP_MAX_DEPTH)
    } catch (error) {
      if (error instanceof WireJsonTooDeep) throw new ConnectError("too_deep", response.status)
      throw outerGateway ? noAnswer() : protocolError()
    }
    if (outerGateway && !Object.hasOwn(envelope, "requestId") && !Object.hasOwn(envelope, "contractVersion")) throw noAnswer()
    if (envelope.requestId !== sentId || headerId !== sentId) throw protocolError()
    if (!response.ok) {
      const error = envelope.error
      if (typeof error !== "object" || error === null || Array.isArray(error)) throw protocolError()
      const code = (error as Record<string, unknown>).code
      if (typeof code !== "string") throw protocolError()
      const expected = HTTP_ERROR_STATUS.get(code)
      if (expected !== undefined && expected !== response.status) throw protocolError()
      // Only a versioned Connect admission refusal is evidence that the grant write did not execute.
      if (code === PROOF_EXPIRED && !selectedVersion(response, envelope)) throw protocolError()
      if (code === "protocol_incompatible" && !incompatibleVersion(response, envelope)) throw protocolError()
      const unregistered = expected === undefined
      if (unregistered) this.noteRetryAfter(response.status, response.headers.get("Retry-After"), true)
      const retry =
        response.status === 429 || response.status === 503 || (unregistered && this.cooldownRemainingMs() > 0)
          ? this.cooldownRemainingMs()
          : undefined
      throw new ConnectError(code, response.status, retry, sentId)
    }
    if (!selectedVersion(response, envelope)) throw protocolError()
    // A profile request is answered in the same profile; a plain request never is.
    const echoed = response.headers.get(PROFILE_HEADER)
    if ((input.profile ? PROFILE : null) !== echoed) throw new ConnectError("protocol", response.status)
    const data = envelope.data
    if (typeof data !== "object" || data === null || Array.isArray(data)) {
      throw new ConnectError("protocol", response.status)
    }
    return data as Record<string, unknown>
  }
}

function selectedVersion(response: Response, envelope: Record<string, unknown>): boolean {
  return envelope.contractVersion === CONTRACT_VERSION && response.headers.get("Mimo-Connect-Version") === CONTRACT_VERSION
}

function incompatibleVersion(response: Response, envelope: Record<string, unknown>): boolean {
  const versions: unknown = envelope.supportedVersions
  return envelope.contractVersion === null &&
    response.headers.get("Mimo-Connect-Version") === null &&
    Array.isArray(versions) && versions.length > 0 && new Set(versions).size === versions.length &&
    versions.every((version) => typeof version === "string" && /^(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(version))
}

async function readBoundedBody(response: Response): Promise<Uint8Array> {
  const reader = response.body?.getReader()
  if (!reader) return new Uint8Array()
  const chunks: Uint8Array[] = []
  let total = 0
  try {
    for (;;) {
      const chunk = await reader.read().catch(() => { throw new ConnectError("network") })
      if (chunk.done) return Buffer.concat(chunks, total)
      total += chunk.value.byteLength
      if (total > MAX_RESPONSE_BYTES) {
        void reader.cancel().catch(() => {})
        throw new ConnectError("protocol", response.status)
      }
      chunks.push(chunk.value)
    }
  } finally {
    reader.releaseLock()
  }
}
