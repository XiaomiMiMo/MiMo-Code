import { afterEach, describe, expect, mock, test } from "bun:test"
import {
  CodexAuthPlugin,
  parseJwtClaims,
  extractAccountIdFromClaims,
  extractAccountId,
  type IdTokenClaims,
} from "../../src/plugin/codex"
import type { PluginInput } from "@mimo-ai/plugin"

const originalFetch = globalThis.fetch

afterEach(() => {
  globalThis.fetch = originalFetch
})

const fakeInput = {
  client: {},
  project: {},
  worktree: "",
  directory: "",
  experimental_workspace: { register() {} },
  serverUrl: new URL("http://localhost:4096"),
  $: undefined,
} as unknown as PluginInput

function createTestJwt(payload: object): string {
  const header = Buffer.from(JSON.stringify({ alg: "none" })).toString("base64url")
  const body = Buffer.from(JSON.stringify(payload)).toString("base64url")
  return `${header}.${body}.sig`
}

describe("plugin.codex", () => {
  describe("loader", () => {
    test("zeroes costs for Codex without modifying model limits", async () => {
      const hooks = await CodexAuthPlugin(fakeInput)
      const model = (modelID: string, limit: { context: number; input?: number }) =>
        [modelID, { api: { id: modelID }, cost: {}, limit }] as const
      const provider = {
        models: Object.fromEntries([
          model("gpt-5.6-sol", { context: 1_050_000, input: 922_000 }),
          model("gpt-5.3-codex", { context: 400_000, input: 272_000 }),
          model("gpt-4o", { context: 128_000 }),
          model("gpt-image-1", { context: 0, input: 0 }),
          model("o3", { context: 200_000 }),
        ]),
      }

      await hooks.auth!.loader!(
        async () => ({ type: "oauth", access: "access", refresh: "refresh", expires: Date.now() + 60_000 }),
        provider as never,
      )

      expect(Object.keys(provider.models)).toEqual(["gpt-5.6-sol", "gpt-5.3-codex", "gpt-4o", "gpt-image-1", "o3"])
      // Limits are no longer clamped — catalog values pass through unchanged.
      expect(provider.models["gpt-5.6-sol"].limit).toEqual({ context: 1_050_000, input: 922_000 })
      expect(provider.models["gpt-5.3-codex"].limit).toEqual({ context: 400_000, input: 272_000 })
      expect(provider.models["gpt-4o"].limit).toEqual({ context: 128_000 })
      expect(provider.models["gpt-image-1"].limit).toEqual({ context: 0, input: 0 })
      expect(provider.models.o3.limit).toEqual({ context: 200_000 })
      // Costs are zeroed for all models.
      for (const model of Object.values(provider.models)) {
        expect(model.cost).toEqual({ input: 0, output: 0, cache: { read: 0, write: 0 } })
      }
    })

    test("forwards request cancellation while refreshing an expired token", async () => {
      const signal = AbortSignal.timeout(25)
      const signals: Array<AbortSignal | null | undefined> = []
      globalThis.fetch = mock((_input, init) => {
        signals.push(init?.signal)
        return new Promise<Response>((_resolve, reject) => {
          const requestSignal = init?.signal
          if (requestSignal?.aborted) return reject(requestSignal.reason)
          requestSignal?.addEventListener("abort", () => reject(requestSignal.reason), { once: true })
        })
      }) as unknown as typeof fetch
      const hooks = await CodexAuthPlugin({
        ...fakeInput,
        client: { auth: { set: async () => undefined } },
      } as unknown as PluginInput)
      const options = await hooks.auth!.loader!(
        async () => ({ type: "oauth", access: "", refresh: "refresh", expires: 0 }),
        { models: {} } as never,
      )

      await expect(
        options.fetch!("https://api.openai.com/v1/responses", {
          signal,
          headers: { authorization: "Bearer placeholder" },
        }),
      ).rejects.toThrow()
      expect(signals).toContain(signal)
    })
  })

  describe("parseJwtClaims", () => {
    test("parses valid JWT with claims", () => {
      const payload = { email: "test@example.com", chatgpt_account_id: "acc-123" }
      const jwt = createTestJwt(payload)
      const claims = parseJwtClaims(jwt)
      expect(claims).toEqual(payload)
    })

    test("returns undefined for JWT with less than 3 parts", () => {
      expect(parseJwtClaims("invalid")).toBeUndefined()
      expect(parseJwtClaims("only.two")).toBeUndefined()
    })

    test("returns undefined for invalid base64", () => {
      expect(parseJwtClaims("a.!!!invalid!!!.b")).toBeUndefined()
    })

    test("returns undefined for invalid JSON payload", () => {
      const header = Buffer.from("{}").toString("base64url")
      const invalidJson = Buffer.from("not json").toString("base64url")
      expect(parseJwtClaims(`${header}.${invalidJson}.sig`)).toBeUndefined()
    })
  })

  describe("extractAccountIdFromClaims", () => {
    test("extracts chatgpt_account_id from root", () => {
      const claims: IdTokenClaims = { chatgpt_account_id: "acc-root" }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts chatgpt_account_id from nested https://api.openai.com/auth", () => {
      const claims: IdTokenClaims = {
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-nested")
    })

    test("prefers root over nested", () => {
      const claims: IdTokenClaims = {
        chatgpt_account_id: "acc-root",
        "https://api.openai.com/auth": { chatgpt_account_id: "acc-nested" },
      }
      expect(extractAccountIdFromClaims(claims)).toBe("acc-root")
    })

    test("extracts from organizations array as fallback", () => {
      const claims: IdTokenClaims = {
        organizations: [{ id: "org-123" }, { id: "org-456" }],
      }
      expect(extractAccountIdFromClaims(claims)).toBe("org-123")
    })

    test("returns undefined when no accountId found", () => {
      const claims: IdTokenClaims = { email: "test@example.com" }
      expect(extractAccountIdFromClaims(claims)).toBeUndefined()
    })
  })

  describe("extractAccountId", () => {
    test("extracts from id_token first", () => {
      const idToken = createTestJwt({ chatgpt_account_id: "from-id-token" })
      const accessToken = createTestJwt({ chatgpt_account_id: "from-access-token" })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-id-token")
    })

    test("falls back to access_token when id_token has no accountId", () => {
      const idToken = createTestJwt({ email: "test@example.com" })
      const accessToken = createTestJwt({
        "https://api.openai.com/auth": { chatgpt_account_id: "from-access" },
      })
      expect(
        extractAccountId({
          id_token: idToken,
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("from-access")
    })

    test("returns undefined when no tokens have accountId", () => {
      const token = createTestJwt({ email: "test@example.com" })
      expect(
        extractAccountId({
          id_token: token,
          access_token: token,
          refresh_token: "rt",
        }),
      ).toBeUndefined()
    })

    test("handles missing id_token", () => {
      const accessToken = createTestJwt({ chatgpt_account_id: "acc-123" })
      expect(
        extractAccountId({
          id_token: "",
          access_token: accessToken,
          refresh_token: "rt",
        }),
      ).toBe("acc-123")
    })
  })
})
