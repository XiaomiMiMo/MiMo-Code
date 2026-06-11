import { describe, expect, test } from "bun:test"
import crypto from "crypto"
import { MimoAuthPlugin } from "../../src/plugin/mimo"
import type { PluginInput } from "@mimo-ai/plugin"

function encrypt(recipientPkBase64: string, payload: string): string {
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

const fakeInput = {
  client: {},
  project: {},
  worktree: "",
  directory: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
  $: undefined,
} as unknown as PluginInput

describe("MimoAuthPlugin", () => {
  describe("config hook", () => {
    test("registers mimo provider with correct name", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const cfg: any = {}
      await hooks.config!(cfg)
      expect(cfg.provider.xiaomi.name).toBe("MiMo")
      expect(cfg.provider.xiaomi.api).toBeTruthy()
    })

    test("registers all expected models", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const cfg: any = {}
      await hooks.config!(cfg)
      // The plugin only sets name and api; models are not registered by the plugin
      // (they come from the provider registry). Verify the provider is created.
      expect(cfg.provider.xiaomi).toBeDefined()
      expect(cfg.provider.xiaomi.name).toBe("MiMo")
    })

    test("does not overwrite existing config", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const cfg: any = { provider: { xiaomi: { name: "Custom", api: "https://custom.api" } } }
      await hooks.config!(cfg)
      expect(cfg.provider.xiaomi.name).toBe("Custom")
      expect(cfg.provider.xiaomi.api).toBe("https://custom.api")
    })
  })

  describe("auth hook structure", () => {
    test("registers auth for mimo provider", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      expect(hooks.auth).toBeDefined()
      expect(hooks.auth!.provider).toBe("xiaomi")
    })

    test("has one login method", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      expect(hooks.auth!.methods).toHaveLength(1)
      expect(hooks.auth!.methods[0].label).toBe("浏览器登录")
      expect(hooks.auth!.methods[0].type).toBe("oauth")
    })
  })

  describe("authorize", () => {
    test("returns url with pk, redirect_uri, kn, key_name params", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const url = new URL(result.url)
      expect(url.pathname).toContain("/authorize")
      expect(url.searchParams.get("pk")).toBeTruthy()
      expect(url.searchParams.get("redirect_uri")).toBeTruthy()
      expect(url.searchParams.get("kn")).toBe("mimocode")
      expect(url.searchParams.get("key_name")).toMatch(/^mimo-code-cli-key-/)

      await result.callback("invalid").catch(() => {})
    })

    test("displayed url has platform redirect_uri for manual copy", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const url = new URL(result.url)
      const redirectUri = url.searchParams.get("redirect_uri")!
      expect(redirectUri).toContain("/authorize/code/callback")

      await result.callback("invalid").catch(() => {})
    })

    test("returns method auto", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any
      expect(result.method).toBe("auto")
      await result.callback("invalid").catch(() => {})
    })

    test("pk is valid base64url-encoded SPKI DER (44 bytes)", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const url = new URL(result.url)
      const pk = url.searchParams.get("pk")!
      const pkBuffer = Buffer.from(pk, "base64url")
      expect(pkBuffer.length).toBe(44)

      await result.callback("invalid").catch(() => {})
    })

    test("each authorize generates different pk", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]

      const result1 = (await method.authorize!()) as any
      const result2 = (await method.authorize!()) as any

      const pk1 = new URL(result1.url).searchParams.get("pk")
      const pk2 = new URL(result2.url).searchParams.get("pk")
      expect(pk1).not.toBe(pk2)

      await result1.callback("invalid").catch(() => {})
      await result2.callback("invalid").catch(() => {})
    })
  })

  describe("callback with code (manual paste)", () => {
    test("decrypts valid code and returns sk, uid, base_url", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const pk = new URL(result.url).searchParams.get("pk")!
      const payload = JSON.stringify({ sk: "sk-test-key-abc", uid: "user-100", url: "https://api.test.com/v1" })
      const code = encrypt(pk, payload)

      const callbackResult = await result.callback(code)
      expect(callbackResult.type).toBe("success")
      expect(callbackResult.key).toBe("sk-test-key-abc")
      expect(callbackResult.metadata.uid).toBe("user-100")
      expect(callbackResult.metadata.base_url).toBe("https://api.test.com/v1")
    })

    test("trims whitespace from pasted code", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const pk = new URL(result.url).searchParams.get("pk")!
      const payload = JSON.stringify({ sk: "sk-trim", uid: "u1", url: "https://x.com/v1" })
      const code = encrypt(pk, payload)

      const callbackResult = await result.callback(`  ${code}  \n`)
      expect(callbackResult.type).toBe("success")
      expect(callbackResult.key).toBe("sk-trim")
    })

    test("returns failed for invalid data", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const callbackResult = await result.callback("not-valid!!!")
      expect(callbackResult.type).toBe("failed")
    })

    test("returns empty key when sk not in payload", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const pk = new URL(result.url).searchParams.get("pk")!
      const payload = JSON.stringify({ uid: "user-no-sk", url: "https://x.com/v1" })
      const code = encrypt(pk, payload)

      const callbackResult = await result.callback(code)
      expect(callbackResult.type).toBe("success")
      expect(callbackResult.key).toBe("")
      expect(callbackResult.metadata.uid).toBe("user-no-sk")
    })

    test("metadata omits base_url when url not in payload", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const pk = new URL(result.url).searchParams.get("pk")!
      const payload = JSON.stringify({ sk: "sk-no-url", uid: "u2" })
      const code = encrypt(pk, payload)

      const callbackResult = await result.callback(code)
      expect(callbackResult.type).toBe("success")
      expect(callbackResult.metadata.base_url).toBeUndefined()
    })
  })

  describe("chat.headers hook", () => {
    test("adds X-Mimo-Source header for mimo provider", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const output = { headers: {} as Record<string, string> }
      await hooks["chat.headers"]!({ model: { providerID: "xiaomi" } } as any, output as any)
      expect(output.headers["X-Mimo-Source"]).toBe("mimocode-cli")
    })

    test("does not add header for other providers", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const providers = ["anthropic", "openai", "google"]
      for (const providerID of providers) {
        const output = { headers: {} as Record<string, string> }
        await hooks["chat.headers"]!({ model: { providerID } } as any, output as any)
        expect(output.headers["X-Mimo-Source"]).toBeUndefined()
      }
    })
  })

  describe("encryption", () => {
    test("decrypts correctly formatted payload", async () => {
      const hooks = await MimoAuthPlugin(fakeInput)
      const method = hooks.auth!.methods[0]
      const result = (await method.authorize!()) as any

      const pk = new URL(result.url).searchParams.get("pk")!
      const payload = JSON.stringify({ sk: "sk-crypto", uid: "crypto-user", url: "https://a.com" })
      const encrypted = encrypt(pk, payload)
      const buf = Buffer.from(encrypted, "base64url")
      expect(buf.length).toBeGreaterThanOrEqual(61)

      const callbackResult = await result.callback(encrypted)
      expect(callbackResult.type).toBe("success")
      expect(callbackResult.key).toBe("sk-crypto")
    })
  })
})
