// Device identity and per-request device proofs (ES256 / P-256).
//
// The installation key is a non-extractable-in-spirit P-256 key: callers persist
// it only through a protected store (see store.ts). Every proof-bearing request
// and every WSS handshake needs a fresh challenge nonce, so a proof is built for
// exactly one method + path + body.

import type { webcrypto } from "node:crypto"
import { base64url, canonical, hex, sha256, type Json } from "./json"

export type PublicJwk = { kty: "EC"; crv: "P-256"; x: string; y: string }
/** Private P-256 key as a JWK; only ever stored in protected storage. */
export type PrivateJwk = webcrypto.JsonWebKey

export interface DeviceKey {
  readonly jwk: PublicJwk
  /** ES256 signature over `data` as raw R||S (64 bytes). */
  sign(data: Uint8Array): Promise<Uint8Array>
}

const ALGORITHM = { name: "ECDSA", namedCurve: "P-256" } as const

/** A key pair plus the private JWK the caller stores in protected storage. */
export async function generateDeviceKey(): Promise<{ key: DeviceKey; privateJwk: PrivateJwk }> {
  const pair = await crypto.subtle.generateKey(ALGORITHM, true, ["sign", "verify"])
  const privateJwk = await crypto.subtle.exportKey("jwk", pair.privateKey)
  return { key: await importDeviceKey(privateJwk), privateJwk }
}

export async function importDeviceKey(privateJwk: PrivateJwk): Promise<DeviceKey> {
  if (privateJwk.kty !== "EC" || privateJwk.crv !== "P-256" || !privateJwk.d || !privateJwk.x || !privateJwk.y) {
    throw new Error("device key must be a private P-256 JWK")
  }
  const privateKey = await crypto.subtle.importKey("jwk", privateJwk, ALGORITHM, false, ["sign"])
  const jwk: PublicJwk = { kty: "EC", crv: "P-256", x: privateJwk.x, y: privateJwk.y }
  return {
    jwk,
    // WebCrypto ECDSA already returns IEEE P1363 (R||S), which is what Connect verifies.
    sign: async (data) =>
      new Uint8Array(await crypto.subtle.sign({ name: "ECDSA", hash: "SHA-256" }, privateKey, data)),
  }
}

/** RFC 7638 thumbprint: SHA-256 over the JCS form of {crv,kty,x,y}. */
export async function keyThumbprint(jwk: PublicJwk): Promise<string> {
  return base64url(await sha256(canonical({ crv: jwk.crv, kty: jwk.kty, x: jwk.x, y: jwk.y })))
}

/** Lowercase hex SHA-256 of the canonical body; an absent body digests the empty string. */
export async function bodyDigest(body: Json | undefined): Promise<string> {
  return hex(await sha256(body === undefined ? "" : canonical(body)))
}

export type ProofInput = {
  key: DeviceKey
  origin: string
  accountSessionId: string
  environment: string
  method: "GET" | "POST" | "PUT"
  path: string
  body: Json | undefined
  nonce: string
  /** Seconds since epoch. */
  now: number
}

/** Lifetime of a proof. Connect accepts at most 60 s between iat and exp. */
export const PROOF_SECONDS = 60

export async function deviceProof(input: ProofInput): Promise<string> {
  const header = { alg: "ES256", typ: "mimo-device-proof+jwt", jwk: input.key.jwk }
  const claims = {
    aud: input.origin,
    iat: input.now,
    exp: input.now + PROOF_SECONDS,
    nonce: input.nonce,
    accountSessionId: input.accountSessionId,
    environment: input.environment,
    method: input.method,
    path: input.path,
    bodyDigest: await bodyDigest(input.body),
  }
  const signingInput = `${base64url(new TextEncoder().encode(canonical(header)))}.${base64url(
    new TextEncoder().encode(canonical(claims)),
  )}`
  const signature = await input.key.sign(new TextEncoder().encode(signingInput))
  return `${signingInput}.${base64url(signature)}`
}
