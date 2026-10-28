import crypto from "crypto"

/** Encrypt a JSON payload to a platform callback recipient (X25519 + AES-256-GCM, SPKI DER pk). */
export function encryptToPk(recipientPkBase64: string, payload: string): string {
  const recipientPublicKey = crypto.createPublicKey({
    key: Buffer.from(recipientPkBase64, "base64url"),
    format: "der",
    type: "spki",
  })

  const ephemeral = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  })
  const ephemeralPub = ephemeral.publicKey.subarray(ephemeral.publicKey.length - 32)

  const ephemeralPrivateKey = crypto.createPrivateKey({ key: ephemeral.privateKey, format: "der", type: "pkcs8" })
  const sharedSecret = crypto.diffieHellman({ privateKey: ephemeralPrivateKey, publicKey: recipientPublicKey })
  const derivedKey = crypto.createHash("sha256").update(sharedSecret).digest()

  const nonce = crypto.randomBytes(12)
  const cipher = crypto.createCipheriv("aes-256-gcm", derivedKey, nonce)
  const ciphertext = Buffer.concat([cipher.update(payload, "utf-8"), cipher.final()])
  const tag = cipher.getAuthTag()

  const encrypted = Buffer.concat([ephemeralPub, nonce, ciphertext, tag])
  return encrypted.toString("base64url")
}
