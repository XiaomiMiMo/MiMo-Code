// The account the phone connector signs in with.
//
// MiMo Code has no Connect account sign-in yet, so the connector runs with an
// isolated debug identity issued by a non-production Connect service
// (`identity issue`, file `cli.json`). The file is named explicitly by
// MIMOCODE_PHONE_DEBUG_IDENTITY; nothing is searched for or guessed.

import type { ConnectorAccount } from "@mimo-ai/connector"
import { readFile } from "node:fs/promises"
import z from "zod"

export const DEBUG_IDENTITY_ENV = "MIMOCODE_PHONE_DEBUG_IDENTITY"

const DebugIdentity = z.object({
  version: z.literal(1),
  mode: z.literal("isolated-debug"),
  role: z.literal("cli"),
  origin: z.string().url(),
  environment: z.string().min(1),
  subject: z.string().min(1),
  accountSessionId: z.string().min(1),
  accessToken: z.string().min(1),
  /** Epoch milliseconds. */
  issuedAt: z.number().int().positive(),
  expiresAt: z.number().int().positive(),
})

export type IdentityProblem = "missing" | "unreadable" | "invalid" | "expired"

export async function loadDebugIdentity(
  file: string | undefined,
  now: () => number = Date.now,
): Promise<ConnectorAccount | IdentityProblem> {
  if (!file) return "missing"
  let raw: string
  try {
    raw = await readFile(file, "utf8")
  } catch {
    return "unreadable"
  }
  let parsed: z.infer<typeof DebugIdentity>
  try {
    parsed = DebugIdentity.parse(JSON.parse(raw))
  } catch {
    return "invalid"
  }
  if (parsed.expiresAt <= now()) return "expired"
  const origin = new URL(parsed.origin)
  // The origin is the proof audience: exactly scheme, host and port, nothing else.
  if (origin.origin !== parsed.origin) return "invalid"
  const loopback = origin.hostname === "127.0.0.1" || origin.hostname === "localhost"
  if (origin.protocol !== "https:" && !(origin.protocol === "http:" && loopback)) return "invalid"
  return {
    origin: origin.origin,
    environment: parsed.environment,
    subject: parsed.subject,
    accountSessionId: parsed.accountSessionId,
    accessToken: parsed.accessToken,
  }
}
