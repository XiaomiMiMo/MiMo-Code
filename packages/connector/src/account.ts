// The Xiaomi account the connector signs in with (xiaomi-account §4.2).
//
// Connect accepts the Passport login credential of the MiMo service directly:
// `Authorization: Bearer <serviceToken>` plus the plain user id in
// `Mimo-Passport-User`, the same pair a signed-in Desktop holds. The connector
// signs in itself (passport-login.ts) and keeps the passToken of that login, so a
// serviceToken close to its end is replaced without a browser, all within one
// login instance. Everything is kept only in the secret store and only ever leaves
// it in request headers.

import z from "zod"
import type { ConnectorAccount } from "./connector"
import { ConnectError, ConnectHttp, type ClientInfo } from "./http"
import { hex, sha256 } from "./json"
import { PassportClient, newDeviceId, type LoginAttempt, type PassportTokens } from "./passport-login"
import type { SecretStore } from "./ports"

const SECRET = "passport-credential"
const DEVICE = "passport-device"
/** The MiMo service keeps a serviceToken valid for two days from issue. */
export const SERVICE_TOKEN_LIFETIME_MS = 48 * 60 * 60 * 1000
/** Replace a serviceToken this long before its end. */
const RENEW_BEFORE_END_MS = 6 * 60 * 60 * 1000
/** After a failed renewal, wait this long before trying again on the next read. */
const RENEW_RETRY_MS = 60 * 1000

/** Header-safe, bounded opaque values: the client never interprets them. */
const HeaderValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[!-~]+$/)

export const PassportCredential = z.strictObject({
  version: z.literal(2),
  /** Connect public origin the credential is used with; also the proof audience. */
  connectOrigin: z.string().url(),
  /** Connect account environment, e.g. `china-production`. */
  environment: z.string().regex(/^(china|global)-(test|production)$/),
  userId: HeaderValue,
  cUserId: HeaderValue.optional(),
  passToken: HeaderValue,
  serviceToken: HeaderValue,
  /** Cookie name the MiMo service used for the serviceToken. */
  tokenCookie: z.string().regex(/^[A-Za-z0-9_]{1,64}$/),
  /** Epoch milliseconds the serviceToken was obtained (its issue time, give or take the round trip). */
  obtainedAt: z.number().int().positive(),
})
export type PassportCredential = z.infer<typeof PassportCredential>

export type SignOutResult = {
  /** Connect confirmed the login instance is signed out. */
  connect: boolean
  /** The account service ended the passToken. */
  account: boolean
}

export type Eligibility = { kind: "allowed" | "not_admitted" | "rejected" } | { kind: "unknown" }

export type PassportAccountOptions = {
  client: PassportClient
  info: ClientInfo
  fetch?: typeof fetch
  now?: () => number
}

export class PassportAccount {
  private readonly now: () => number
  private renewing: Promise<"renewed" | "signed_out" | "failed"> | undefined
  private renewFailedAt = 0
  /** Set when the account service stopped accepting the kept login. */
  private ended = false

  constructor(
    private readonly secrets: SecretStore,
    private readonly options: PassportAccountOptions,
  ) {
    this.now = options.now ?? Date.now
  }

  /** Start a sign-in; the returned attempt keeps the result once the user confirmed. */
  async signIn(): Promise<LoginAttempt> {
    const deviceId = await this.deviceId()
    const attempt = await this.options.client.start(deviceId)
    return {
      ...attempt,
      wait: async (signal) => {
        const tokens = await attempt.wait(signal)
        await this.keep(tokens)
        return tokens
      },
    }
  }

  /** The kept credential, without renewing it. */
  async credential(): Promise<PassportCredential | undefined> {
    const raw = await this.secrets.get(SECRET)
    if (!raw) return undefined
    try {
      const parsed = PassportCredential.safeParse(JSON.parse(raw))
      return parsed.success ? parsed.data : undefined
    } catch {
      return undefined
    }
  }

  /** True once the account service stopped accepting the kept login (it was then removed). */
  signInEnded(): boolean {
    return this.ended
  }

  /** The signed-in account, renewing the serviceToken first when it is close to its end. */
  async account(): Promise<ConnectorAccount | undefined> {
    let credential = await this.credential()
    if (!credential) return undefined
    const due = this.now() >= credential.obtainedAt + SERVICE_TOKEN_LIFETIME_MS - RENEW_BEFORE_END_MS
    if (due && this.now() - this.renewFailedAt >= RENEW_RETRY_MS) {
      const outcome = await this.renew()
      if (outcome === "signed_out") return undefined
      credential = (await this.credential()) ?? credential
    }
    return toAccount(credential)
  }

  /**
   * Replace the serviceToken from the passToken now. Concurrent callers share one
   * renewal. `signed_out` removes the kept login: it can no longer be renewed.
   */
  renew(): Promise<"renewed" | "signed_out" | "failed"> {
    this.renewing ??= this.renewOnce().finally(() => (this.renewing = undefined))
    return this.renewing
  }

  /**
   * Sign out: Connect first (while the serviceToken still verifies), then the
   * account service; the local login is removed whatever the services answered.
   */
  async signOut(): Promise<SignOutResult> {
    const credential = await this.credential()
    const result: SignOutResult = { connect: false, account: false }
    if (credential) {
      result.connect = await this.connect(credential)
        .request({ method: "POST", path: "/api/connect/account/signout", body: {}, profile: false, proof: false })
        .then((data) => data.signedOut === true)
        .catch(() => false)
      result.account = await this.options.client
        .signOut(credential, await this.deviceId())
        .catch(() => false)
    }
    await this.secrets.delete(SECRET)
    this.ended = false
    return result
  }

  /** Whether Connect accepts the kept credential, and whether the account may use the phone connection. */
  async eligibility(): Promise<Eligibility> {
    const account = await this.account()
    const credential = await this.credential()
    if (!account || !credential) return { kind: "rejected" }
    try {
      const data = await this.connect(credential).request({
        method: "GET",
        path: "/api/connect/mobile-allowlist/check",
        profile: false,
        proof: false,
      })
      if (typeof data.allowed !== "boolean") return { kind: "unknown" }
      return { kind: data.allowed ? "allowed" : "not_admitted" }
    } catch (error) {
      if (error instanceof ConnectError && error.status === 401) return { kind: "rejected" }
      return { kind: "unknown" }
    }
  }

  /** The account's display name at the MiMo service, when it answers. */
  async nickname(): Promise<string | undefined> {
    const credential = await this.credential()
    if (!credential) return undefined
    const service = this.options.client.service
    try {
      const response = await (this.options.fetch ?? fetch)(`${service.serviceOrigin}/api/user/xiaomi/me/basic`, {
        headers: { Cookie: `${credential.tokenCookie}=${credential.serviceToken}; userId=${credential.userId}` },
        redirect: "manual",
        signal: AbortSignal.timeout(10_000),
      })
      if (!response.ok) return undefined
      const body = (await response.json()) as { data?: { nickname?: unknown } }
      const name = body.data?.nickname
      return typeof name === "string" && name.trim() ? name.trim().slice(0, 64) : undefined
    } catch {
      return undefined
    }
  }

  /** This install's device id; created once and kept across sign-ins. */
  async deviceId(): Promise<string> {
    const kept = await this.secrets.get(DEVICE)
    if (kept && /^[A-Za-z0-9_]{8,64}$/.test(kept)) return kept
    const created = newDeviceId()
    await this.secrets.set(DEVICE, created)
    return created
  }

  private async renewOnce(): Promise<"renewed" | "signed_out" | "failed"> {
    const credential = await this.credential()
    if (!credential) return "signed_out"
    let tokens: PassportTokens | "signed_out"
    try {
      tokens = await this.options.client.renew(credential, await this.deviceId())
    } catch {
      // Network or service trouble: the current serviceToken stays until a later attempt.
      this.renewFailedAt = this.now()
      return "failed"
    }
    if (tokens === "signed_out") {
      // Only the login that was asked about ends; a newer sign-in meanwhile stays.
      if ((await this.credential())?.passToken === credential.passToken) {
        await this.secrets.delete(SECRET)
        this.ended = true
      }
      return "signed_out"
    }
    await this.keep(tokens)
    return "renewed"
  }

  private async keep(tokens: PassportTokens): Promise<void> {
    const service = this.options.client.service
    const credential = PassportCredential.parse({
      version: 2,
      connectOrigin: new URL(service.connectOrigin).origin,
      environment: service.environment,
      userId: tokens.userId,
      cUserId: tokens.cUserId,
      passToken: tokens.passToken,
      serviceToken: tokens.serviceToken,
      tokenCookie: tokens.tokenCookie,
      obtainedAt: this.now(),
    })
    await this.secrets.set(SECRET, JSON.stringify(credential))
    this.ended = false
    this.renewFailedAt = 0
  }

  private connect(credential: PassportCredential): ConnectHttp {
    return new ConnectHttp({
      account: () => toAccountSession(credential),
      deviceId: () => undefined,
      client: this.options.info,
      fetch: this.options.fetch,
    })
  }
}

function toAccountSession(credential: PassportCredential) {
  return {
    origin: new URL(credential.connectOrigin).origin,
    environment: credential.environment,
    userId: credential.userId,
    serviceToken: credential.serviceToken,
  }
}

async function toAccount(credential: PassportCredential): Promise<ConnectorAccount> {
  return {
    ...toAccountSession(credential),
    subject: await localSubject(credential.environment, credential.userId),
  }
}

/**
 * The local identity of one Xiaomi account in one environment. It partitions this
 * installation's materials and consents; Connect derives its own subject.
 */
export async function localSubject(environment: string, userId: string): Promise<string> {
  return hex(await sha256(`${environment}\n${userId}`))
}
