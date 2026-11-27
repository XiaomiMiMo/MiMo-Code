// Identities of the phone connector besides its own Xiaomi account sign-in
// (runtime.ts): an isolated debug identity for non-production Connect services,
// taken only from an explicitly named file (MIMOCODE_PHONE_DEBUG_IDENTITY,
// `IdentityBootstrap issue`, file `cli.json`), and the account of the MiMo
// platform sign-in, read only to tell the user when the two differ.

import type { ConnectorAccount } from "@mimo-ai/connector"
import { readFile } from "node:fs/promises"
import path from "node:path"
import z from "zod"
import { Global } from "@/global"
import { XIAOMI_API_PROVIDER_ID, XIAOMI_CREDENTIAL_PROVIDER_IDS } from "@/provider/xiaomi-family"

export const DEBUG_IDENTITY_ENV = "MIMOCODE_PHONE_DEBUG_IDENTITY"

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

/**
 * Xiaomi user ids of the MiMo platform sign-ins (model credentials), when any.
 * Read only to warn when the phone connection signs in with another account.
 */
export async function platformUserIds(file = path.join(Global.Path.data, "auth.json")): Promise<string[]> {
  let data: unknown
  try {
    data = JSON.parse(await readFile(file, "utf8"))
  } catch {
    return []
  }
  if (!data || typeof data !== "object") return []
  const ids = new Set<string>()
  for (const key of [XIAOMI_API_PROVIDER_ID, ...XIAOMI_CREDENTIAL_PROVIDER_IDS]) {
    const uid = (data as Record<string, { metadata?: { uid?: unknown } }>)[key]?.metadata?.uid
    if (typeof uid === "string" && uid) ids.add(uid)
  }
  return [...ids]
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
