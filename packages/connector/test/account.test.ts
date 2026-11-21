import { describe, expect, test } from "bun:test"
import { PassportAccount, credentialDigest, localSubject, type PassportCredential } from "../src/account"
import { MemorySecrets } from "./doubles"

const credential: PassportCredential = {
  version: 1,
  connectOrigin: "https://connect.example.test",
  environment: "china-production",
  userId: "2469486853",
  serviceToken: "V1:token/with+opaque=chars",
}

describe("Passport account", () => {
  test("a kept credential becomes the connector account with the plain user id", async () => {
    const secrets = new MemorySecrets()
    const account = new PassportAccount(secrets)
    expect(await account.account()).toBeUndefined()
    await account.save(credential)
    expect(await account.account()).toEqual({
      origin: "https://connect.example.test",
      environment: "china-production",
      subject: await localSubject("china-production", "2469486853"),
      userId: "2469486853",
      serviceToken: credential.serviceToken,
    })
    expect(await account.digest()).toBe(await credentialDigest(credential))
  })

  test("the local subject separates environments and accounts", async () => {
    const a = await localSubject("china-production", "1")
    expect(a).toMatch(/^[0-9a-f]{64}$/)
    expect(await localSubject("global-production", "1")).not.toBe(a)
    expect(await localSubject("china-production", "2")).not.toBe(a)
  })

  test("values that cannot travel in a header, or an unknown environment, are never kept", async () => {
    const account = new PassportAccount(new MemorySecrets())
    await expect(account.save({ ...credential, serviceToken: "has space" })).rejects.toThrow()
    await expect(account.save({ ...credential, userId: "" })).rejects.toThrow()
    await expect(account.save({ ...credential, environment: "debug-test" })).rejects.toThrow()
    expect(await account.account()).toBeUndefined()
  })

  test("an unreadable stored copy is no account", async () => {
    const secrets = new MemorySecrets()
    await secrets.set("passport-credential", JSON.stringify({ ...credential, version: 2 }))
    expect(await new PassportAccount(secrets).account()).toBeUndefined()
  })
})
