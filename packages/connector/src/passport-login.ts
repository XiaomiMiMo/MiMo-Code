// Xiaomi account sign-in of the connector (xiaomi-account §4.2, cli-connector R5).
//
// The terminal starts the account service's own long-polling login: it shows a
// login URL (any browser, or a Xiaomi phone scanning its QR code) and polls until
// the user confirmed. The account service then hands this terminal a passToken of
// its own, which is exchanged at the MiMo service's existing STS endpoint for the
// serviceToken Connect accepts. Later serviceTokens come from the same passToken
// without a browser, and every request carries the same per-install device id, so
// all of them belong to one login instance; signing out ends that passToken.
//
// Only the account service and the MiMo service's STS endpoint are ever contacted
// with these values, and the passToken is only ever sent to account.xiaomi.com.

import { createHash } from "node:crypto"

export type PassportService = {
  /** Xiaomi account service, e.g. `https://account.xiaomi.com`. */
  accountOrigin: string
  /** MiMo business service id at the account service. */
  sid: string
  /** MiMo service whose STS endpoint turns a login into a serviceToken. */
  serviceOrigin: string
  stsPath: string
  /** Connect public origin and account environment the serviceToken is used with. */
  connectOrigin: string
  environment: string
}

export const CHINA_PRODUCTION: PassportService = {
  accountOrigin: "https://account.xiaomi.com",
  sid: "mimopc",
  serviceOrigin: "https://mimo-server-cn.xiaomimimo.com",
  stsPath: "/api/sts",
  connectOrigin: "https://mimo-connect-cn.xiaomimimo.com",
  environment: "china-production",
}

/** What one sign-in (or one renewal of it) yields. */
export type PassportTokens = {
  userId: string
  cUserId?: string
  passToken: string
  serviceToken: string
  /** Cookie name the STS endpoint used for the serviceToken. */
  tokenCookie: string
}

export class PassportLoginError extends Error {
  constructor(
    /** `expired`: the login URL timed out; `cancelled`; `rejected`: the services refused; `network`. */
    readonly code: "expired" | "cancelled" | "rejected" | "network",
    message?: string,
  ) {
    super(message ?? code)
    this.name = "PassportLoginError"
  }
}

export type LoginAttempt = {
  /** Open in any browser to sign in and confirm. */
  loginUrl: string
  /** Epoch milliseconds after which the URL no longer works. */
  expiresAt: number
  /** Resolves once the user confirmed; rejects with PassportLoginError. */
  wait(signal?: AbortSignal): Promise<PassportTokens>
}

export type PassportClientOptions = {
  service?: PassportService
  /** Sent as User-Agent to the account service. */
  userAgent?: string
  fetch?: typeof fetch
  now?: () => number
  sleep?: (ms: number) => Promise<void>
}

const POLL_REQUEST_MS = 70_000
const REQUEST_MS = 15_000
const DEFAULT_LOGIN_SECONDS = 300

export class PassportClient {
  readonly service: PassportService
  private readonly fetch: typeof fetch
  private readonly now: () => number
  private readonly sleep: (ms: number) => Promise<void>
  private readonly userAgent: string

  constructor(options: PassportClientOptions = {}) {
    this.service = options.service ?? CHINA_PRODUCTION
    this.fetch = options.fetch ?? globalThis.fetch
    this.now = options.now ?? Date.now
    this.sleep = options.sleep ?? ((ms) => new Promise((resolve) => setTimeout(resolve, ms)))
    this.userAgent = options.userAgent ?? "MiMoCode"
  }

  /** Start a login for this install's device id. */
  async start(deviceId: string): Promise<LoginAttempt> {
    const s = this.service
    const url = new URL("/longPolling/loginUrl", s.accountOrigin)
    url.search = new URLSearchParams({
      sid: s.sid,
      callback: `${s.serviceOrigin}${s.stsPath}`,
      qs: `?sid=${s.sid}&_json=true`,
      _qrsize: "240",
      _hasLogo: "false",
      _dc: String(this.now()),
    }).toString()
    const answer = await this.get(url.toString(), { Cookie: deviceCookie(deviceId) }, REQUEST_MS)
    const data = answer.json
    if (
      !data ||
      data.code !== 0 ||
      typeof data.loginUrl !== "string" ||
      typeof data.lp !== "string" ||
      !this.isAccountUrl(data.loginUrl) ||
      !this.isAccountUrl(data.lp)
    ) {
      throw new PassportLoginError("rejected", "the account service did not start a login")
    }
    const seconds = typeof data.timeout === "number" && data.timeout > 0 ? data.timeout : DEFAULT_LOGIN_SECONDS
    const expiresAt = this.now() + seconds * 1000
    const lp = data.lp
    return {
      loginUrl: data.loginUrl,
      expiresAt,
      wait: (signal) => this.complete(lp, deviceId, expiresAt, signal),
    }
  }

  /**
   * A fresh serviceToken from the passToken, without a browser. `signed_out` when
   * the account service no longer accepts the passToken.
   */
  async renew(tokens: Pick<PassportTokens, "passToken" | "userId" | "cUserId">, deviceId: string): Promise<PassportTokens | "signed_out"> {
    const s = this.service
    const url = new URL("/pass/serviceLogin", s.accountOrigin)
    url.search = new URLSearchParams({ _locale: "zh_CN", _snsNone: "true", sid: s.sid, _json: "true" }).toString()
    const answer = await this.get(url.toString(), { Cookie: accountCookies(tokens, deviceId) }, REQUEST_MS)
    const data = answer.json
    if (!data) throw new PassportLoginError("network", `account service answered ${answer.status}`)
    if (data.code !== 0) return "signed_out"
    const nonce = exactInteger(answer.text, "nonce")
    if (typeof data.location !== "string" || typeof data.ssecurity !== "string" || !nonce) {
      throw new PassportLoginError("rejected", "the account service answered without an exchange")
    }
    const exchanged = await this.exchange(data.location, nonce, data.ssecurity)
    return { ...exchanged, passToken: tokens.passToken, cUserId: tokens.cUserId ?? exchanged.cUserId }
  }

  /**
   * End the login at the account service. Best effort: the redirect chain is
   * followed within the account service only, and the cookies only go there.
   */
  async signOut(tokens: Pick<PassportTokens, "passToken" | "userId" | "cUserId">, deviceId: string): Promise<boolean> {
    const s = this.service
    let next = new URL("/pass/logout", s.accountOrigin)
    next.search = new URLSearchParams({ sid: s.sid, callback: `${s.serviceOrigin}/api` }).toString()
    const cookie = accountCookies(tokens, deviceId)
    for (let hop = 0; hop < 5; hop++) {
      if (!this.isAccountUrl(next.toString())) return true
      let response: Response
      try {
        response = await this.fetch(next, {
          redirect: "manual",
          headers: { Cookie: cookie, "User-Agent": this.userAgent },
          signal: AbortSignal.timeout(REQUEST_MS),
        })
        await response.body?.cancel()
      } catch {
        return false
      }
      const location = response.headers.get("location")
      if (response.status < 300 || response.status >= 400 || !location) return response.status < 400
      next = new URL(location, next)
    }
    return true
  }

  private async complete(lp: string, deviceId: string, expiresAt: number, signal?: AbortSignal): Promise<PassportTokens> {
    let confirmed: { json: Record<string, unknown>; text: string; passToken: string } | undefined
    while (!confirmed) {
      if (signal?.aborted) throw new PassportLoginError("cancelled")
      const left = expiresAt - this.now()
      if (left <= 0) throw new PassportLoginError("expired")
      const answer = await this.get(lp, { Cookie: deviceCookie(deviceId) }, Math.min(POLL_REQUEST_MS, left), signal).catch(
        () => {
          if (signal?.aborted) throw new PassportLoginError("cancelled")
          return undefined
        },
      )
      const passToken = answer?.json?.code === 0 ? answer.json.passToken : undefined
      if (answer?.json && typeof passToken === "string" && passToken) {
        confirmed = { json: answer.json, text: answer.text, passToken }
        break
      }
      // Pending, a timed-out long poll or a passing network failure: ask again.
      await this.sleep(1000)
    }
    const data = confirmed.json
    const userId = stringId(data.userId)
    if (!userId) throw new PassportLoginError("rejected", "the login carried no user id")
    const login = { passToken: confirmed.passToken, userId, cUserId: stringId(data.cUserId) }
    const nonce = exactInteger(confirmed.text, "nonce")
    if (typeof data.location === "string" && typeof data.ssecurity === "string" && nonce) {
      const exchanged = await this.exchange(data.location, nonce, data.ssecurity)
      return { ...exchanged, passToken: login.passToken, cUserId: login.cUserId ?? exchanged.cUserId }
    }
    // No exchange in the login answer: take one with the new passToken.
    const renewed = await this.renew(login, deviceId)
    if (renewed === "signed_out") throw new PassportLoginError("rejected", "the new login was not accepted")
    return renewed
  }

  /** Second hop of every login: the STS endpoint verifies the client signature and sets the serviceToken. */
  private async exchange(location: string, nonce: string, ssecurity: string): Promise<Omit<PassportTokens, "passToken">> {
    const s = this.service
    let url: URL
    try {
      url = new URL(location)
    } catch {
      throw new PassportLoginError("rejected", "invalid exchange address")
    }
    if (url.origin !== new URL(s.serviceOrigin).origin || url.pathname !== s.stsPath) {
      throw new PassportLoginError("rejected", "the exchange does not point at the MiMo service")
    }
    const sign = createHash("sha1").update(`nonce=${nonce}&${ssecurity}`).digest("base64")
    url.searchParams.append("clientSign", sign)
    let response: Response
    try {
      response = await this.fetch(url, {
        redirect: "manual",
        headers: { "User-Agent": this.userAgent },
        signal: AbortSignal.timeout(REQUEST_MS),
      })
      await response.body?.cancel()
    } catch {
      throw new PassportLoginError("network", "the MiMo service could not be reached")
    }
    const cookies = setCookies(response.headers)
    const tokenCookie = cookies.has(`${s.sid}_serviceToken`) ? `${s.sid}_serviceToken` : "serviceToken"
    const serviceToken = cookies.get(tokenCookie)
    const userId = cookies.get("userId")
    if (!serviceToken || !userId) throw new PassportLoginError("rejected", `the MiMo service answered ${response.status}`)
    return { serviceToken, userId, tokenCookie, cUserId: cookies.get("cUserId") || undefined }
  }

  private isAccountUrl(value: string): boolean {
    let url: URL
    try {
      url = new URL(value)
    } catch {
      return false
    }
    const account = new URL(this.service.accountOrigin)
    return url.protocol === account.protocol && (url.host === account.host || url.host.endsWith(`.${account.host}`))
  }

  private async get(url: string, headers: Record<string, string>, timeoutMs: number, signal?: AbortSignal) {
    const timeout = AbortSignal.timeout(timeoutMs)
    let response: Response
    let text: string
    try {
      response = await this.fetch(url, {
        redirect: "manual",
        headers: { ...headers, "User-Agent": this.userAgent },
        signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
      })
      text = await response.text()
    } catch {
      throw new PassportLoginError("network", "the account service could not be reached")
    }
    let json: Record<string, unknown> | undefined
    try {
      const parsed: unknown = JSON.parse(text.replace(/^&&&START&&&/, ""))
      if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) json = parsed as Record<string, unknown>
    } catch {
      json = undefined
    }
    return { status: response.status, json, text }
  }
}

/** A device id for this install; the account service ties the login instance to it. */
export function newDeviceId(): string {
  return `mimocode_${crypto.randomUUID().replace(/-/g, "")}`
}

/**
 * Integers such as `nonce` exceed the safe integer range; JSON.parse would round
 * them and the exchange signature would no longer match. Read the digits as sent.
 */
export function exactInteger(text: string, name: string): string | undefined {
  const match = new RegExp(`"${name}"\\s*:\\s*"?(\\d+)"?`).exec(text)
  return match?.[1]
}

function stringId(value: unknown): string | undefined {
  if (typeof value === "number" && Number.isSafeInteger(value) && value > 0) return String(value)
  if (typeof value === "string" && /^[!-~]{1,256}$/.test(value)) return value
  return undefined
}

function deviceCookie(deviceId: string): string {
  return `deviceId=${deviceId}`
}

function accountCookies(tokens: Pick<PassportTokens, "passToken" | "userId" | "cUserId">, deviceId: string): string {
  return [
    `passToken=${tokens.passToken}`,
    `userId=${tokens.userId}`,
    ...(tokens.cUserId ? [`cUserId=${tokens.cUserId}`] : []),
    deviceCookie(deviceId),
  ].join("; ")
}

function setCookies(headers: Headers): Map<string, string> {
  const cookies = new Map<string, string>()
  for (const line of headers.getSetCookie()) {
    const pair = line.split(";")[0]
    const at = pair.indexOf("=")
    if (at <= 0) continue
    const value = pair.slice(at + 1).trim()
    if (value) cookies.set(pair.slice(0, at).trim(), value)
  }
  return cookies
}
