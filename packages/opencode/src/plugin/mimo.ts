import type { Hooks, PluginInput } from "@mimo-ai/plugin"
import { Log } from "../util"
import { createServer } from "http"
import crypto from "crypto"
import { exec } from "child_process"
import { Global } from "../global"
import path from "path"
import fs from "fs"

const log = Log.create({ service: "plugin.mimo" })

const PLATFORM_URL = process.env.MIMO_PLATFORM_URL || "https://platform.xiaomimimo.com"

function getKeyName(): string {
  const filePath = path.join(Global.Path.data, "mimo-key-name")
  try {
    const existing = fs.readFileSync(filePath, "utf-8").trim()
    if (existing) return existing
  } catch {}
  const name = `mimo-code-cli-key-${crypto.randomBytes(4).toString("hex")}`
  fs.writeFileSync(filePath, name)
  return name
}

function generateKeyPair() {
  const keyPair = crypto.generateKeyPairSync("x25519", {
    publicKeyEncoding: { type: "spki", format: "der" },
    privateKeyEncoding: { type: "pkcs8", format: "der" },
  })
  const publicKeyBase64 = Buffer.from(keyPair.publicKey).toString("base64url")
  return { publicKey: publicKeyBase64, privateKeyDer: keyPair.privateKey }
}

function decrypt(privateKeyDer: Buffer, encryptedBase64: string): { sk?: string; uid: string; url?: string } {
  const encrypted = Buffer.from(encryptedBase64, "base64url")
  // Format: ephemeralPublicKey(32 bytes) + nonce(12 bytes) + ciphertext + tag(16 bytes)
  const ephemeralPub = encrypted.subarray(0, 32)
  const nonce = encrypted.subarray(32, 44)
  const ciphertextAndTag = encrypted.subarray(44)
  const tag = ciphertextAndTag.subarray(ciphertextAndTag.length - 16)
  const ciphertext = ciphertextAndTag.subarray(0, ciphertextAndTag.length - 16)

  const privateKey = crypto.createPrivateKey({ key: privateKeyDer, format: "der", type: "pkcs8" })
  const ephemeralPublicKey = crypto.createPublicKey({
    key: Buffer.concat([Buffer.from("302a300506032b656e032100", "hex"), ephemeralPub]),
    format: "der",
    type: "spki",
  })

  const sharedSecret = crypto.diffieHellman({ privateKey, publicKey: ephemeralPublicKey })
  const derivedKey = crypto.createHash("sha256").update(sharedSecret).digest()

  const decipher = crypto.createDecipheriv("aes-256-gcm", derivedKey, nonce)
  decipher.setAuthTag(tag)
  const decrypted = Buffer.concat([decipher.update(ciphertext), decipher.final()])

  return JSON.parse(decrypted.toString("utf-8"))
}

function openBrowser(url: string) {
  if (process.env.CI || process.env.NODE_ENV === "test") return
  const command =
    process.platform === "darwin"
      ? `open "${url}"`
      : process.platform === "win32"
        ? `start "" "${url}"`
        : `xdg-open "${url}"`
  exec(command, (error) => {
    if (error) {
      log.warn("could not open browser automatically", { error })
    }
  })
}

function buildAuthorizeUrl(publicKey: string, redirectUri: string): string {
  const params = new URLSearchParams({
    pk: publicKey,
    redirect_uri: redirectUri,
    kn: "mimocode",
    key_name: getKeyName(),
  })
  return `${PLATFORM_URL}/authorize?${params.toString()}`
}

export async function MimoAuthPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    config: async (input) => {
      input.provider ??= {}
      input.provider.xiaomi ??= {}
      const xiaomi = input.provider.xiaomi
      xiaomi.name ??= "MiMo"
      xiaomi.api ??= "https://api.xiaomimimo.com/v1"
      // Disable upstream OpenCode hosted providers so they don't silently
      // auto-load their free/public tier (opencode autoloads zero-cost models
      // with apiKey "public" when no key is configured). Previously set by the
      // free channel; moved here so it applies in every build (the free channel
      // is now an optional private overlay).
      input.disabled_providers ??= []
      for (const id of ["opencode", "opencode-go"]) {
        if (!input.disabled_providers.includes(id)) input.disabled_providers.push(id)
      }
    },
    auth: {
      provider: "xiaomi",
      async loader(getAuth) {
        const auth = (await getAuth()) as { type: string; metadata?: Record<string, string> }
        if (auth?.type !== "api" || !auth.metadata?.base_url) return {}
        return { baseURL: auth.metadata.base_url }
      },
      methods: [
        {
          label: "浏览器登录",
          type: "oauth" as const,
          authorize: async () => {
            const { publicKey, privateKeyDer } = generateKeyPair()

            const server = createServer()
            await new Promise<void>((resolve, reject) => {
              server.listen(0, () => resolve())
              server.on("error", reject)
            })
            const addr = server.address()
            const port = typeof addr === "object" && addr ? addr.port : 0
            log.info("mimo oauth server started", { port })

            const redirectUri = `http://localhost:${port}/`
            const authUrl = buildAuthorizeUrl(publicKey, redirectUri)
            const manualUrl = buildAuthorizeUrl(publicKey, `${PLATFORM_URL}/authorize/code/callback`)

            openBrowser(authUrl)

            const serverCallbackPromise = new Promise<{ sk?: string; uid: string; url?: string }>((resolve, reject) => {
              const timeout = setTimeout(() => {
                server.close()
                reject(new Error("Authorization timeout"))
              }, 5 * 60 * 1000)

              server.on("request", (req, res) => {
                const url = new URL(req.url || "/", `http://localhost`)
                log.info("mimo oauth callback received", { path: url.pathname, query: url.search.substring(0, 100) })

                const u = url.searchParams.get("u")

                if (!u) {
                  log.warn("mimo oauth callback missing u param")
                  res.writeHead(302, { Location: `${PLATFORM_URL}/authorize/callback?status=error&message=missing_data` })
                  res.end()
                  reject(new Error("Missing encrypted data"))
                  return
                }

                try {
                  const result = decrypt(privateKeyDer, u)
                  log.info("mimo oauth decrypt success", { uid: result.uid, url: result.url })
                  res.writeHead(302, { Location: `${PLATFORM_URL}/authorize/callback?status=success` })
                  res.end()
                  clearTimeout(timeout)
                  resolve(result)
                } catch (err) {
                  log.error("mimo oauth decrypt failed", { error: err })
                  res.writeHead(302, { Location: `${PLATFORM_URL}/authorize/callback?status=error&message=decrypt_failed` })
                  res.end()
                  reject(new Error("Decryption failed"))
                }
              })
            })
            serverCallbackPromise.catch(() => {})

            return {
              url: manualUrl,
              method: "auto" as const,
              instructions: "在浏览器中完成授权，或粘贴 Code 完成登录。",
              callback: async (code?: string) => {
                if (code) {
                  try {
                    const result = decrypt(privateKeyDer, code.trim())
                    server.close()
                    const metadata: Record<string, string> = { uid: result.uid }
                    if (result.url) metadata.base_url = result.url
                    return { type: "success" as const, key: result.sk ?? "", metadata }
                  } catch {
                    return { type: "failed" as const }
                  }
                }
                try {
                  const result = await serverCallbackPromise
                  server.close()
                  const metadata: Record<string, string> = { uid: result.uid }
                  if (result.url) metadata.base_url = result.url
                  return { type: "success" as const, key: result.sk ?? "", metadata }
                } catch {
                  server.close()
                  return { type: "failed" as const }
                }
              },
            }
          },
        },
      ],
    },
    "chat.headers": async (input, output) => {
      if (input.model.providerID !== "xiaomi") return
      output.headers["X-Mimo-Source"] = "mimocode-cli"
    },
  }
}

export async function AnthropicProxyPlugin(_input: PluginInput): Promise<Hooks> {
  return {
    auth: {
      provider: "anthropic",
      async loader(_getAuth, provider) {
        if (!provider?.options?.baseURL) return {}
        return {
          async fetch(url: any, init: any) {
            if (init?.headers && typeof init.headers === "object" && !Array.isArray(init.headers)) {
              delete init.headers["anthropic-beta"]
            }
            const res = await fetch(url, init)
            if (!res.body || !res.headers.get("content-type")?.includes("text/event-stream")) return res
            const reader = res.body.getReader()
            const decoder = new TextDecoder()
            let done = false
            let buffer = ""
            const body = new ReadableStream<Uint8Array>({
              async pull(ctrl) {
                if (done) { ctrl.close(); return }
                const chunk = await reader.read()
                if (chunk.done) { ctrl.close(); return }
                ctrl.enqueue(chunk.value)
                buffer += decoder.decode(chunk.value, { stream: true })
                if (buffer.includes("\nevent: message_stop\n") || buffer.includes("\ndata: {\"type\":\"message_stop\"}")) {
                  done = true
                  void reader.cancel()
                  ctrl.close()
                }
                if (buffer.length > 512) buffer = buffer.slice(-256)
              },
              cancel() { reader.cancel() },
            })
            return new Response(body, { headers: res.headers, status: res.status })
          },
        }
      },
      methods: [],
    },
  }
}
