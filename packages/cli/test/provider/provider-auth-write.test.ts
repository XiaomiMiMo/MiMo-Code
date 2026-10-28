import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { tmpdir } from "../fixture/fixture"
import { encryptToPk as encrypt } from "../fixture/mimo-encrypt"
import { Instance } from "../../src/project/instance"
import { Auth } from "../../src/auth"
import { ProviderAuth } from "../../src/provider"
import { ProviderID } from "../../src/provider/schema"

const XIAOMI = ProviderID.make("xiaomi")
const TOKEN_PLAN_CN = ProviderID.make("xiaomi-token-plan-cn")
const FAMILY = ["xiaomi", "xiaomi-token-plan-cn", "xiaomi-token-plan-ams", "xiaomi-token-plan-sgp"].map((id) => ProviderID.make(id))

async function clearFamily(directory: string) {
  await Instance.provide({
    directory,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          for (const id of FAMILY) yield* auth.remove(id)
        }).pipe(Effect.provide(Auth.defaultLayer)),
      ),
  })
}

async function seedXiaomi(directory: string, info: Auth.Info) {
  await Instance.provide({
    directory,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          yield* auth.set(XIAOMI, info)
        }).pipe(Effect.provide(Auth.defaultLayer)),
      ),
  })
}

async function platformLogin(directory: string, payload: Record<string, unknown>) {
  await Instance.provide({
    directory,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const svc = yield* ProviderAuth.Service
          const authorized = yield* svc.authorize({ providerID: XIAOMI, method: 0 })
          const pk = new URL(authorized!.url).searchParams.get("pk")!
          yield* svc.callback({ providerID: XIAOMI, method: 0, code: encrypt(pk, JSON.stringify(payload)) })
        }).pipe(Effect.provide(ProviderAuth.defaultLayer)),
      ),
  })
  return Instance.provide({
    directory,
    fn: () =>
      Effect.runPromise(
        Effect.gen(function* () {
          const auth = yield* Auth.Service
          return {
            xiaomi: yield* auth.get(XIAOMI),
            tokenPlanCn: yield* auth.get(TOKEN_PLAN_CN),
          }
        }).pipe(Effect.provide(Auth.defaultLayer)),
      ),
  })
}

describe("ProviderAuth.callback xiaomi-family writes", () => {
  test("stores a token-plan credential under its cluster provider", async () => {
    await using tmp = await tmpdir({})
    await clearFamily(tmp.path)
    const stored = await platformLogin(tmp.path, {
      sk: "sk-token-plan-1",
      uid: "user-tp-1",
      url: "https://token-plan-cn.xiaomimimo.com/v1",
    })
    expect(stored.tokenPlanCn).toMatchObject({
      type: "api",
      key: "sk-token-plan-1",
      metadata: { uid: "user-tp-1", base_url: "https://token-plan-cn.xiaomimimo.com/v1" },
    })
    expect(stored.xiaomi).toBeUndefined()
  }, 30000)

  test("stores an API credential under xiaomi", async () => {
    await using tmp = await tmpdir({})
    await clearFamily(tmp.path)
    const stored = await platformLogin(tmp.path, {
      sk: "sk-api-1",
      uid: "user-api-1",
      url: "https://api.xiaomimimo.com/v1",
    })
    expect(stored.xiaomi).toMatchObject({
      type: "api",
      key: "sk-api-1",
      metadata: { uid: "user-api-1", base_url: "https://api.xiaomimimo.com/v1" },
    })
    expect(stored.tokenPlanCn).toBeUndefined()
  }, 30000)

  test("drops the legacy xiaomi alias when the same cluster is written split", async () => {
    await using tmp = await tmpdir({})
    await clearFamily(tmp.path)
    await seedXiaomi(tmp.path, {
      type: "api",
      key: "sk-legacy",
      metadata: { uid: "user-legacy", base_url: "https://token-plan-cn.xiaomimimo.com/v1" },
    })
    const stored = await platformLogin(tmp.path, {
      sk: "sk-token-plan-2",
      uid: "user-tp-2",
      url: "https://token-plan-cn.xiaomimimo.com/v1",
    })
    expect(stored.xiaomi).toBeUndefined()
    expect(stored.tokenPlanCn).toMatchObject({ type: "api", key: "sk-token-plan-2" })
  }, 30000)

  test("keeps an unrelated xiaomi entry when another cluster is written", async () => {
    await using tmp = await tmpdir({})
    await clearFamily(tmp.path)
    await seedXiaomi(tmp.path, {
      type: "api",
      key: "sk-api-keep",
      metadata: { uid: "user-api-keep", base_url: "https://api.xiaomimimo.com/v1" },
    })
    const stored = await platformLogin(tmp.path, {
      sk: "sk-token-plan-3",
      uid: "user-tp-3",
      url: "https://token-plan-cn.xiaomimimo.com/v1",
    })
    expect(stored.xiaomi).toMatchObject({ type: "api", key: "sk-api-keep" })
    expect(stored.tokenPlanCn).toMatchObject({ type: "api", key: "sk-token-plan-3" })
  }, 30000)
})
