import { describe, expect, test } from "bun:test"
import { mkdtemp, readdir, readFile, rm, stat } from "node:fs/promises"
import { tmpdir } from "node:os"
import path from "node:path"
import { systemSecretStore, type RunResult } from "../src/keychain"

type Call = { command: string[]; stdin?: string }

/** A scripted command runner that records every call. */
function runner(answer: (call: Call) => RunResult) {
  const calls: Call[] = []
  return {
    calls,
    run: async (command: string[], stdin?: string) => {
      const call = { command, stdin }
      calls.push(call)
      return answer(call)
    },
  }
}

const SECRET = '{"kty":"EC","d":"private"}'
const encoded = Buffer.from(SECRET).toString("base64url")

describe("macOS keychain", () => {
  test("writes through stdin and never puts the secret on a command line", async () => {
    const r = runner(() => ({ code: 0, stdout: "", stderr: "" }))
    const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "darwin", run: r.run })
    await store.set("device-key", SECRET)
    expect(r.calls[0].command).toEqual(["security", "-i"])
    expect(r.calls[0].stdin).toBe(`add-generic-password -U -s mimocode-phone -a device-key -w ${encoded}\n`)
    for (const call of r.calls) expect(call.command.join(" ")).not.toContain(encoded)
  })

  test("reads back the stored value and reports a missing item as absent", async () => {
    const r = runner(({ command }) =>
      command.includes("missing")
        ? { code: 44, stdout: "", stderr: "not found" }
        : { code: 0, stdout: `${encoded}\n`, stderr: "" },
    )
    const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "darwin", run: r.run })
    expect(await store.get("device-key")).toBe(SECRET)
    expect(await store.get("missing")).toBeUndefined()
  })

  test("a locked or failing keychain is an error, not an absent secret", async () => {
    const r = runner(() => ({ code: 51, stdout: "", stderr: "User interaction is not allowed." }))
    const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "darwin", run: r.run })
    await expect(store.get("device-key")).rejects.toThrow()
    await expect(store.set("device-key", SECRET)).rejects.toThrow()
  })
})

describe("Linux Secret Service", () => {
  test("stores through stdin and looks the value up by service and account", async () => {
    const r = runner(({ command }) => ({ code: 0, stdout: command[1] === "lookup" ? encoded : "", stderr: "" }))
    const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "linux", run: r.run })
    await store.set("state-key", SECRET)
    expect(r.calls[0]).toEqual({
      command: [
        "secret-tool",
        "store",
        "--label=mimocode-phone state-key",
        "service",
        "mimocode-phone",
        "account",
        "state-key",
      ],
      stdin: encoded,
    })
    expect(await store.get("state-key")).toBe(SECRET)
  })

  test("a missing item is absent while an unreachable service is unavailable", async () => {
    const absent = runner(() => ({ code: 1, stdout: "", stderr: "" }))
    const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "linux", run: absent.run })
    expect(await store.available()).toBe(true)
    expect(await store.get("state-key")).toBeUndefined()
    const down = runner(() => ({ code: 1, stdout: "", stderr: "Cannot autolaunch D-Bus without X11 $DISPLAY" }))
    const offline = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "linux", run: down.run })
    expect(await offline.available()).toBe(false)
    await expect(offline.get("state-key")).rejects.toThrow()
  })

  test("a missing secret-tool binary makes the store unavailable", async () => {
    const store = systemSecretStore({
      service: "mimocode-phone",
      directory: "",
      platform: "linux",
      run: async () => {
        throw new Error("ENOENT")
      },
    })
    expect(await store.available()).toBe(false)
  })
})

describe("Windows DPAPI", () => {
  test("keeps only the protected blob on disk and unprotects it on read", async () => {
    const dir = await mkdtemp(path.join(tmpdir(), "dpapi-"))
    try {
      const r = runner(({ command, stdin }) => {
        const script = command.at(-1)!
        if (script.includes("::Protect(")) return { code: 0, stdout: `BLOB:${stdin}`, stderr: "" }
        if (script.includes("::Unprotect(")) return { code: 0, stdout: stdin!.replace(/^BLOB:/, ""), stderr: "" }
        return { code: 0, stdout: "", stderr: "" }
      })
      const store = systemSecretStore({ service: "mimocode-phone", directory: dir, platform: "win32", run: r.run })
      await store.set("device-key", SECRET)
      expect(await readdir(dir)).toEqual(["device-key.dpapi"])
      const onDisk = await readFile(path.join(dir, "device-key.dpapi"), "utf8")
      expect(onDisk).not.toContain(SECRET)
      expect((await stat(path.join(dir, "device-key.dpapi"))).mode & 0o777).toBe(0o600)
      expect(await store.get("device-key")).toBe(SECRET)
      for (const call of r.calls) expect(call.command.join(" ")).not.toContain(encoded)
      await store.delete("device-key")
      expect(await store.get("device-key")).toBeUndefined()
    } finally {
      await rm(dir, { recursive: true, force: true })
    }
  })
})

test("an unsupported platform never stores anything", async () => {
  const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "aix" })
  expect(await store.available()).toBe(false)
  await expect(store.set("device-key", SECRET)).rejects.toThrow()
})

test("names outside the safe set are refused", async () => {
  const r = runner(() => ({ code: 0, stdout: "", stderr: "" }))
  const store = systemSecretStore({ service: "mimocode-phone", directory: "", platform: "darwin", run: r.run })
  await expect(store.set("a -w injected", SECRET)).rejects.toThrow()
  expect(r.calls).toEqual([])
})
