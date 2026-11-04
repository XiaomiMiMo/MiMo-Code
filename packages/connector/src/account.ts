// A signed-in account session for the connector, kept current by renewal.
//
// The session comes from the account service's login (the access token lives
// minutes, the refresh token days). It is stored only in protected storage;
// renewal rotates both tokens, so the new pair is made durable before it is
// used. A session the account service no longer renews is signed out, never
// retried with stale tokens.

import z from "zod"
import type { ConnectorAccount } from "./connector"
import type { SecretStore } from "./ports"

const SECRET = "account-session"
const ACCOUNT_VERSION = "1.0"
const Token = z.string().regex(/^[A-Za-z0-9_-]{43}$/)
const Uuid = z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/)
const Instant = z.string().datetime({ offset: true })
/** Renew this long before the access token expires when the service gave no renewAfter. */
const RENEW_MARGIN_MS = 2 * 60_000

export const StoredSession = z.object({
  version: z.literal(1),
  /** Account service origin (renew / logout). */
  accountOrigin: z.string().url(),
  /** Connect origin the session is used with. */
  connectOrigin: z.string().url(),
  environment: z.string().min(1),
  subject: z.string().min(1),
  accountSessionId: Uuid,
  accessToken: Token,
  accessExpiresAt: Instant,
  renewAfter: Instant.optional(),
  refreshToken: Token,
  refreshExpiresAt: Instant,
  logoutToken: Token.optional(),
  /** Idempotency key of a renewal in flight, reused if its answer was lost. */
  renewKey: Uuid.optional(),
})
export type StoredSession = z.infer<typeof StoredSession>

const RenewData = z.object({
  session: z.object({
    accountSessionId: Uuid,
    subject: z.string(),
    accessExpiresAt: Instant,
    refreshExpiresAt: Instant,
    renewAfter: Instant.optional(),
  }),
  credentials: z.object({ tokenType: z.literal("Bearer"), accessToken: Token, refreshToken: Token }),
})

export type SignedInAccountOptions = {
  secrets: SecretStore
  /** Release semver of the client; the account service requires it. */
  clientVersion: string
  fetch?: typeof fetch
  clock?: () => number
}

export class SignedInAccount {
  private renewing: Promise<StoredSession | undefined> | undefined
  private readonly fetch: typeof fetch
  private readonly clock: () => number

  constructor(private readonly options: SignedInAccountOptions) {
    this.fetch = options.fetch ?? fetch
    this.clock = options.clock ?? Date.now
  }

  /** Keep a session handed over from a sign-in; it replaces any previous one. */
  async save(session: StoredSession): Promise<void> {
    await this.options.secrets.set(SECRET, JSON.stringify(StoredSession.parse(session)))
  }

  /** The current account, renewed first when due; undefined when signed out. */
  async account(): Promise<ConnectorAccount | undefined> {
    let session = await this.load()
    if (!session) return undefined
    const now = this.clock()
    const due = session.renewAfter
      ? Date.parse(session.renewAfter)
      : Date.parse(session.accessExpiresAt) - RENEW_MARGIN_MS
    if (now >= due) session = await this.renew()
    if (!session || this.clock() >= Date.parse(session.accessExpiresAt)) return undefined
    return {
      origin: new URL(session.connectOrigin).origin,
      environment: session.environment,
      subject: session.subject,
      accountSessionId: session.accountSessionId,
      accessToken: session.accessToken,
    }
  }

  /** End the session at the account service and forget it locally. */
  async signOut(): Promise<void> {
    const session = await this.load()
    if (session?.logoutToken) {
      await this.post(session, "/api/account/logout", session.logoutToken, {
        environment: session.environment,
        accountSessionId: session.accountSessionId,
        reason: "sign_out",
      }).catch(() => undefined)
    }
    await this.options.secrets.delete(SECRET)
  }

  private async load(): Promise<StoredSession | undefined> {
    const raw = await this.options.secrets.get(SECRET)
    if (!raw) return undefined
    const parsed = StoredSession.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  }

  private renew(): Promise<StoredSession | undefined> {
    // One renewal at a time: the refresh token rotates, a second use would be rejected.
    this.renewing ??= this.renewNow().finally(() => (this.renewing = undefined))
    return this.renewing
  }

  private async renewNow(): Promise<StoredSession | undefined> {
    const session = await this.load()
    if (!session) return undefined
    if (this.clock() >= Date.parse(session.refreshExpiresAt)) return this.forget()
    // The refresh token rotates: a renewal whose answer was lost is repeated with the same key.
    const renewKey = session.renewKey ?? crypto.randomUUID()
    if (!session.renewKey) await this.save({ ...session, renewKey })
    const response = await this.post(
      session,
      "/api/account/renew",
      session.refreshToken,
      { environment: session.environment, accountSessionId: session.accountSessionId },
      renewKey,
    )
    // The service said this session is over; anything else may be temporary.
    if (response.status === 401 || response.status === 403) return this.forget()
    if (response.status !== 200 || !response.data) throw new Error(`account renew failed: ${response.status}`)
    const renewed = RenewData.parse(response.data)
    if (renewed.session.accountSessionId !== session.accountSessionId || renewed.session.subject !== session.subject) {
      throw new Error("account renew answered for another session")
    }
    const { renewKey: _done, ...rest } = session
    const next: StoredSession = {
      ...rest,
      accessToken: renewed.credentials.accessToken,
      accessExpiresAt: renewed.session.accessExpiresAt,
      renewAfter: renewed.session.renewAfter,
      refreshToken: renewed.credentials.refreshToken,
      refreshExpiresAt: renewed.session.refreshExpiresAt,
    }
    await this.save(next)
    return next
  }

  private async forget(): Promise<undefined> {
    await this.options.secrets.delete(SECRET)
    return undefined
  }

  private async post(
    session: StoredSession,
    path: string,
    token: string,
    body: Record<string, string>,
    idempotencyKey: string = crypto.randomUUID(),
  ): Promise<{ status: number; data?: unknown }> {
    const requestId = crypto.randomUUID()
    const response = await this.fetch(new URL(path, session.accountOrigin), {
      method: "POST",
      redirect: "error",
      headers: {
        "Content-Type": "application/json",
        "Mimo-Account-Version": ACCOUNT_VERSION,
        "Mimo-Request-Id": requestId,
        "X-Request-Id": requestId,
        "X-Client-Version": this.options.clientVersion,
        "Idempotency-Key": idempotencyKey,
        Authorization: `Bearer ${token}`,
      },
      body: JSON.stringify(body),
    })
    const envelope = (await response.json().catch(() => undefined)) as
      | { requestId?: string; data?: unknown }
      | undefined
    if (envelope?.requestId !== undefined && envelope.requestId !== requestId) {
      throw new Error("account response for another request")
    }
    return { status: response.status, data: envelope?.data }
  }
}
