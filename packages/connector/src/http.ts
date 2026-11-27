// Connect HTTP transport for the CLI connector role.
//
// One request = one device-challenge + one proof (Connect consumes the nonce).
// Responses are checked strictly: envelope shape, selected version, request-id
// echo and profile echo. Service rejections keep their code; rate limits record a
// cooldown from Retry-After so callers back off instead of hammering the service.
// Nothing here retries on its own: whether a failed write may be re-sent is the
// caller's decision.

import { canonical, parseObject, type Json } from "./json"
import { deviceProof, keyThumbprint, type DeviceKey } from "./proof"

export const PROFILE = "cli-connector-v1"
const PROFILE_HEADER = "Mimo-Connect-Profile"

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

  /** Rejections that a later identical attempt may succeed on without a new user decision. */
  get transient(): boolean {
    return (
      this.code === "network" ||
      this.code === "cooldown" ||
      this.status === 429 ||
      this.status === 503 ||
      this.code === "desktop_offline"
    )
  }
}

export type HttpRequest = {
  method: "GET" | "POST" | "PUT"
  path: string
  body?: Json
  /** Only the bindings list takes a query; it is not part of the signed path. */
  query?: Record<string, string>
  /** Send `Mimo-Connect-Profile: cli-connector-v1` and require its echo. */
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

  /** Record a Retry-After the service sent on a rejected WSS upgrade. */
  noteRetryAfter(status: number, retryAfter: string | null): void {
    if (status !== 429 && status !== 503) return
    const seconds = Number(retryAfter)
    const delay = Number.isInteger(seconds) && seconds > 0 && seconds <= 600 ? seconds * 1000 : 60_000
    this.cooldownUntil = Math.max(this.cooldownUntil, this.clock() + delay)
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
    const keys = Object.keys(data).sort().join(",")
    const serverTime = typeof data.serverTime === "string" && ISO.test(data.serverTime) ? Date.parse(data.serverTime) : NaN
    const expiresAt = typeof data.expiresAt === "string" && ISO.test(data.expiresAt) ? Date.parse(data.expiresAt) : NaN
    if (
      keys !== "environment,expiresAt,loginInstanceId,nonce,serverTime" ||
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
    const text = await response.text()
    if (new TextEncoder().encode(text).length > MAX_RESPONSE_BYTES) throw new ConnectError("protocol", response.status)
    let envelope: Record<string, unknown>
    try {
      envelope = parseObject(text)
    } catch {
      throw new ConnectError(response.ok ? "protocol" : "unavailable", response.status, this.cooldownRemainingMs())
    }
    if (envelope.requestId !== sentId || response.headers.get("Mimo-Request-Id") !== sentId) {
      throw new ConnectError("protocol", response.status)
    }
    if (!response.ok) {
      const error = envelope.error as { code?: unknown } | undefined
      const code = typeof error?.code === "string" ? error.code : "protocol"
      const retry = response.status === 429 || response.status === 503 ? this.cooldownRemainingMs() : undefined
      throw new ConnectError(code, response.status, retry, sentId)
    }
    if (envelope.contractVersion !== CONTRACT_VERSION || response.headers.get("Mimo-Connect-Version") !== CONTRACT_VERSION) {
      throw new ConnectError("protocol", response.status)
    }
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
