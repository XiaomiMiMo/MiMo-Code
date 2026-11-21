// The account the phone connector signs in with.
//
// MiMo Code has no Xiaomi account sign-in of its own yet. Until it has, the
// connector takes one of two explicitly named files, never searched for:
//  - MIMOCODE_PHONE_PASSPORT_CREDENTIAL: the Passport login credential of the
//    MiMo service (serviceToken and plain userId, the pair a signed-in Desktop
//    holds). It is imported once into protected storage and used from there.
//  - MIMOCODE_PHONE_DEBUG_IDENTITY: an isolated debug identity issued by a
//    non-production Connect service (`IdentityBootstrap issue`, file `cli.json`).

import { PassportCredential, type ConnectorAccount } from "@mimo-ai/connector"
import { readFile } from "node:fs/promises"
import z from "zod"

export const DEBUG_IDENTITY_ENV = "MIMOCODE_PHONE_DEBUG_IDENTITY"
export const PASSPORT_CREDENTIAL_ENV = "MIMOCODE_PHONE_PASSPORT_CREDENTIAL"

const DebugIdentity = z.object({
  version: z.literal(1),
  mode: z.literal("isolated-debug"),
  role: z.literal("cli"),
  origin: z.string().url(),
  /** Debug identities only exist on test services. */
  environment: z.enum(["china-test", "global-test"]),
  subject: z.string().min(1),
  loginInstanceId: z.string().regex(/^[0-9a-f]{32}$/),
  accessToken: z.string().regex(/^[A-Za-z0-9_-]{43}$/),
  /** Epoch milliseconds. */
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})

export type IdentityProblem = "missing" | "unreadable" | "invalid" | "expired"

export async function loadDebugIdentity(
  file: string | undefined,
  now: () => number = Date.now,
): Promise<ConnectorAccount | IdentityProblem> {
  const parsed = await readJson(file, DebugIdentity)
  if (typeof parsed === "string") return parsed
  if (parsed.expiresAt <= now()) return "expired"
  const origin = new URL(parsed.origin)
  // The origin is the proof audience: exactly scheme, host and port, nothing else.
  if (origin.origin !== parsed.origin) return "invalid"
  const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost"
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) return "invalid"
  // A debug identity is a bare bearer: no Passport user header.
  return {
    origin: origin.origin,
    environment: parsed.environment,
    subject: parsed.subject,
    serviceToken: parsed.accessToken,
  }
}

const CredentialFile = z.strictObject({
  connectOrigin: z.string().url(),
  environment: z.string(),
  userId: z.string(),
  serviceToken: z.string(),
})

/** Read a Passport credential file; the origin must be a plain HTTPS origin. */
export async function readPassportCredential(file: string | undefined): Promise<PassportCredential | IdentityProblem> {
  const parsed = await readJson(file, CredentialFile)
  if (typeof parsed === "string") return parsed
  const url = new URL(parsed.connectOrigin)
  if (url.protocol !== "https:" || url.origin !== parsed.connectOrigin.replace(/\/$/, "")) return "invalid"
  // The connector's own schema checks the values (header-safe, known environment).
  const credential = PassportCredential.safeParse({ version: 1, ...parsed, connectOrigin: url.origin })
  return credential.success ? credential.data : "invalid"
}

async function readJson<T>(file: string | undefined, schema: z.ZodType<T>): Promise<T | IdentityProblem> {
  if (!file) return "missing"
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch {
    return "unreadable"
  }
  try {
    return schema.parse(JSON.parse(raw))
  } catch {
    return "invalid"
  }
}
