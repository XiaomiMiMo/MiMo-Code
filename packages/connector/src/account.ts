// The Xiaomi account the connector signs in with (xiaomi-account §3.2).
//
// Connect accepts the Passport login credential of the MiMo service directly:
// `Authorization: Bearer <serviceToken>` plus the plain user id in
// `Mimo-Passport-User`, the same pair a signed-in Desktop holds. The credential
// is kept only in protected storage and only ever leaves it in request headers.
// Connect verifies it with the account service on every use; the client holds no
// expiry of its own and treats `unauthenticated` as signed out.

import z from "zod"
import type { ConnectorAccount } from "./connector"
import { hex, sha256 } from "./json"
import type { SecretStore } from "./ports"

const SECRET = "passport-credential"
/** Header-safe, bounded opaque values: the client never interprets them. */
const HeaderValue = z
  .string()
  .min(1)
  .max(4096)
  .regex(/^[!-~]+$/)

export const PassportCredential = z.strictObject({
  version: z.literal(1),
  /** Connect public origin the credential is used with; also the proof audience. */
  connectOrigin: z.string().url(),
  /** Connect account environment, e.g. `china-production`. */
  environment: z.string().regex(/^(china|global)-(test|production)$/),
  userId: HeaderValue,
  serviceToken: HeaderValue,
})
export type PassportCredential = z.infer<typeof PassportCredential>

export class PassportAccount {
  constructor(private readonly secrets: SecretStore) {}

  /** Keep a credential from a sign-in; it replaces any previous one. */
  async save(credential: PassportCredential): Promise<void> {
    await this.secrets.set(SECRET, JSON.stringify(PassportCredential.parse(credential)))
  }

  /** Digest of the kept credential, to tell whether a sign-in result is already the kept one. */
  async digest(): Promise<string | undefined> {
    const credential = await this.load()
    return credential ? credentialDigest(credential) : undefined
  }

  /** The signed-in account; undefined when there is none. */
  async account(): Promise<ConnectorAccount | undefined> {
    const credential = await this.load()
    if (!credential) return undefined
    return {
      origin: new URL(credential.connectOrigin).origin,
      environment: credential.environment,
      subject: await localSubject(credential.environment, credential.userId),
      userId: credential.userId,
      serviceToken: credential.serviceToken,
    }
  }

  private async load(): Promise<PassportCredential | undefined> {
    const raw = await this.secrets.get(SECRET)
    if (!raw) return undefined
    const parsed = PassportCredential.safeParse(JSON.parse(raw))
    return parsed.success ? parsed.data : undefined
  }
}

/**
 * The local identity of one Xiaomi account in one environment. It partitions this
 * installation's materials and consents; Connect derives its own subject.
 */
export async function localSubject(environment: string, userId: string): Promise<string> {
  return hex(await sha256(`${environment}\n${userId}`))
}

export async function credentialDigest(credential: PassportCredential): Promise<string> {
  return hex(await sha256(`${credential.connectOrigin}\n${credential.environment}\n${credential.userId}\n${credential.serviceToken}`))
}
