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

/** The account the CLI is signed in as (formal login or an isolated debug identity). */
export type AccountSession = {
  /** Connect public origin, e.g. `https://connect.example`; also the proof audience. */
  origin: string
  environment: string
  accountSessionId: string
  accessToken: string
}

export type ClientInfo = {
  /** Semver of the running CLI; sent as X-Client-Version. */
  version: string
  platform: "macos" | "windows" | "linux"
}

export class ConnectError extends Error {
  constructor(
    /** Service error code, or a client-side kind: `protocol`, `network`, `cooldown`. */
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
  version: "1.0" | "4.0"
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
  key: DeviceKey
  deviceId: () => string | undefined
  client: ClientInfo
  fetch?: typeof fetch
  /** Seconds since epoch for proof iat; injectable for tests. */
  now?: () => number
  /** Milliseconds clock for cooldowns. */
  clock?: () => number
}

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/
/** Connect envelopes are bounded; a larger body is not a Connect response. */
const MAX_RESPONSE_BYTES = 65536

export class ConnectHttp {
  private cooldownUntil = 0
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly clock: () => number

  constructor(private readonly options: HttpOptions) {
    this.fetch = options.fetch ?? fetch
    this.now = options.now ?? (() => Math.floor(Date.now() / 1000))
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
    headers.set("Mimo-Connect-Version", input.version)
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

  /** Headers for a WSS handshake: bearer, proof and device id; never version or profile. */
  async handshakeHeaders(path: string): Promise<Headers> {
    const wait = this.cooldownRemainingMs()
    if (wait > 0) throw new ConnectError("cooldown", undefined, wait)
    return this.headers(this.options.account(), { method: "GET", path, version: "1.0", profile: false, proof: true })
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
      Authorization: `Bearer ${account.accessToken}`,
      "Mimo-Request-Id": crypto.randomUUID(),
      "X-Client-Version": this.options.client.version,
      "X-Client-Platform": this.options.client.platform,
    })
    if (input.profile) headers.set(PROFILE_HEADER, PROFILE)
    if (!input.proof) return headers
    const nonce = await this.challenge(account, input.method, input.path)
    headers.set(
      "X-Device-Proof",
      await deviceProof({
        key: this.options.key,
        origin: account.origin,
        accountSessionId: account.accountSessionId,
        environment: account.environment,
        method: input.method,
        path: input.path,
        body: input.body,
        nonce,
        now: this.now(),
      }),
    )
    const deviceId = this.options.deviceId()
    if (deviceId) headers.set("X-Device-Id", deviceId)
    return headers
  }

  private async challenge(account: AccountSession, method: string, path: string): Promise<string> {
    const data = await this.request({
      method: "POST",
      path: "/api/connect/device-challenges",
      version: "1.0",
      body: { method, path, keyThumbprint: await keyThumbprint(this.options.key.jwk) },
      profile: false,
      proof: false,
    })
    if (
      typeof data.nonce !== "string" ||
      !UUID.test(data.nonce) ||
      data.accountSessionId !== account.accountSessionId ||
      data.environment !== account.environment
    ) {
      throw new ConnectError("protocol")
    }
    return data.nonce
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
    if (envelope.contractVersion !== input.version || response.headers.get("Mimo-Connect-Version") !== input.version) {
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
