// The operating system's protected secret storage as a SecretStore:
// macOS Keychain (`security`), Linux Secret Service (`secret-tool`, libsecret)
// and Windows DPAPI (current user, via PowerShell).
//
// Secrets never appear in a command line: they are passed on stdin. Values are
// stored base64url-encoded so no quoting rules apply. A platform without a
// reachable store reports unavailable; `protectedOrFileStore` then falls back to
// files only the current user can read.

import { mkdir, readFile, rename, rm, writeFile } from "node:fs/promises"
import path from "node:path"
import type { SecretStore } from "./ports"

export type RunResult = { code: number; stdout: string; stderr: string }
export type Runner = (command: string[], stdin?: string) => Promise<RunResult>

const NAME = /^[a-z0-9-]{1,64}$/

export type SystemSecretOptions = {
  /** Keychain service / Secret Service attribute grouping this application's items. */
  service: string
  /** Windows only: directory for the DPAPI-protected blobs. */
  directory: string
  platform?: NodeJS.Platform
  run?: Runner
}

export function systemSecretStore(options: SystemSecretOptions): SecretStore {
  checkName(options.service)
  const run = options.run ?? spawnRunner
  switch (options.platform ?? process.platform) {
    case "darwin":
      return new MacKeychain(options.service, run)
    case "linux":
      return new SecretService(options.service, run)
    case "win32":
      return new Dpapi(options.directory, run)
    default:
      return unavailableStore
  }
}

const unavailableStore: SecretStore = {
  available: async () => false,
  get: async () => {
    throw new Error("no protected storage on this platform")
  },
  set: async () => {
    throw new Error("no protected storage on this platform")
  },
  delete: async () => {},
}

function checkName(name: string): string {
  if (!NAME.test(name)) throw new Error(`invalid secret name: ${name}`)
  return name
}

function encode(value: string): string {
  return Buffer.from(value, "utf8").toString("base64url")
}

function decode(value: string): string {
  return Buffer.from(value.trim(), "base64url").toString("utf8")
}

class MacKeychain implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly run: Runner,
  ) {}

  async available(): Promise<boolean> {
    return (await this.run(["security", "default-keychain"]).catch(() => undefined))?.code === 0
  }

  async get(name: string): Promise<string | undefined> {
    const result = await this.run([
      "security",
      "find-generic-password",
      "-s",
      this.service,
      "-a",
      checkName(name),
      "-w",
    ])
    // 44: the item does not exist.
    if (result.code === 44) return undefined
    if (result.code !== 0) throw new Error(`keychain read failed (${result.code})`)
    return decode(result.stdout)
  }

  async set(name: string, value: string): Promise<void> {
    // `security -i` reads the command from stdin, keeping the secret out of the process list.
    const command = `add-generic-password -U -s ${this.service} -a ${checkName(name)} -w ${encode(value)}\n`
    const result = await this.run(["security", "-i"], command)
    if (result.code !== 0 || /error/i.test(result.stderr)) throw new Error(`keychain write failed (${result.code})`)
  }

  async delete(name: string): Promise<void> {
    const result = await this.run(["security", "delete-generic-password", "-s", this.service, "-a", checkName(name)])
    if (result.code !== 0 && result.code !== 44) throw new Error(`keychain delete failed (${result.code})`)
  }
}

class SecretService implements SecretStore {
  constructor(
    private readonly service: string,
    private readonly run: Runner,
  ) {}

  async available(): Promise<boolean> {
    // A lookup of an absent item exits 1 silently; no reachable service also exits 1 but says why.
    const result = await this.run([
      "secret-tool",
      "lookup",
      "service",
      this.service,
      "account",
      "availability-probe",
    ]).catch(() => undefined)
    if (!result) return false
    return result.code === 0 || (result.code === 1 && result.stderr.trim() === "")
  }

  async get(name: string): Promise<string | undefined> {
    const result = await this.run(["secret-tool", "lookup", "service", this.service, "account", checkName(name)])
    if (result.code === 1 && result.stderr.trim() === "") return undefined
    if (result.code !== 0) throw new Error(`secret service read failed (${result.code})`)
    return decode(result.stdout)
  }

  async set(name: string, value: string): Promise<void> {
    const label = `${this.service} ${checkName(name)}`
    const result = await this.run(
      ["secret-tool", "store", `--label=${label}`, "service", this.service, "account", name],
      encode(value),
    )
    if (result.code !== 0) throw new Error(`secret service write failed (${result.code})`)
  }

  async delete(name: string): Promise<void> {
    const result = await this.run(["secret-tool", "clear", "service", this.service, "account", checkName(name)])
    if (result.code !== 0 && !(result.code === 1 && result.stderr.trim() === "")) {
      throw new Error(`secret service delete failed (${result.code})`)
    }
  }
}

const POWERSHELL = ["powershell.exe", "-NoProfile", "-NonInteractive", "-Command"]
const PROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$data = [Text.Encoding]::UTF8.GetBytes([Console]::In.ReadToEnd())",
  "$blob = [Security.Cryptography.ProtectedData]::Protect($data, $null, 'CurrentUser')",
  "[Console]::Out.Write([Convert]::ToBase64String($blob))",
].join("; ")
const UNPROTECT = [
  "Add-Type -AssemblyName System.Security",
  "$blob = [Convert]::FromBase64String([Console]::In.ReadToEnd())",
  "$data = [Security.Cryptography.ProtectedData]::Unprotect($blob, $null, 'CurrentUser')",
  "[Console]::Out.Write([Text.Encoding]::UTF8.GetString($data))",
].join("; ")

class Dpapi implements SecretStore {
  constructor(
    private readonly directory: string,
    private readonly run: Runner,
  ) {}

  async available(): Promise<boolean> {
    const result = await this.run([...POWERSHELL, "Add-Type -AssemblyName System.Security"]).catch(() => undefined)
    return result?.code === 0
  }

  async get(name: string): Promise<string | undefined> {
    let blob: string
    try {
      blob = await readFile(this.file(name), "utf8")
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
      throw error
    }
    const result = await this.run([...POWERSHELL, UNPROTECT], blob)
    if (result.code !== 0) throw new Error(`DPAPI unprotect failed (${result.code})`)
    return decode(result.stdout)
  }

  async set(name: string, value: string): Promise<void> {
    const result = await this.run([...POWERSHELL, PROTECT], encode(value))
    if (result.code !== 0 || !result.stdout.trim()) throw new Error(`DPAPI protect failed (${result.code})`)
    await mkdir(this.directory, { recursive: true, mode: 0o700 })
    const file = this.file(name)
    const temp = `${file}.${process.pid}.tmp`
    await writeFile(temp, result.stdout.trim(), { mode: 0o600, flush: true })
    await rename(temp, file).catch(async (error) => {
      await rm(temp, { force: true })
      throw error
    })
  }

  async delete(name: string): Promise<void> {
    await rm(this.file(name), { force: true })
  }

  private file(name: string): string {
    return path.join(this.directory, `${checkName(name)}.dpapi`)
  }
}

const RUN_TIMEOUT_MS = 15_000

export const spawnRunner: Runner = async (command, stdin) => {
  const child = Bun.spawn(command, {
    stdin: stdin === undefined ? "ignore" : "pipe",
    stdout: "pipe",
    stderr: "pipe",
    timeout: RUN_TIMEOUT_MS,
  })
  if (stdin !== undefined && child.stdin) {
    child.stdin.write(stdin)
    await child.stdin.end()
  }
  const [stdout, stderr, code] = await Promise.all([
    new Response(child.stdout).text(),
    new Response(child.stderr).text(),
    child.exited,
  ])
  return { code, stdout, stderr }
}

/**
 * Files only the current user can read (0600 in a 0700 directory), for a computer
 * without reachable protected storage (cli-connector R9). Weaker than protected
 * storage; whoever uses it tells the user once.
 */
export function fileSecretStore(directory: string): SecretStore {
  const file = (name: string) => path.join(directory, `${checkName(name)}.secret`)
  return {
    available: async () => true,
    async get(name) {
      try {
        return decode(await readFile(file(name), "utf8"))
      } catch (error) {
        if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined
        throw error
      }
    },
    async set(name, value) {
      await mkdir(directory, { recursive: true, mode: 0o700 })
      const target = file(name)
      const temp = `${target}.${process.pid}.tmp`
      await writeFile(temp, encode(value), { mode: 0o600, flush: true })
      await rename(temp, target).catch(async (error) => {
        await rm(temp, { force: true })
        throw error
      })
    },
    async delete(name) {
      await rm(file(name), { force: true })
    },
  }
}

export type SecretStoreKind = "protected" | "file"

/** A secret store that also tells which kind of storage it ended up using. */
export type ResolvedSecretStore = SecretStore & { kind(): Promise<SecretStoreKind> }

/**
 * Protected storage when it is reachable, otherwise the file store. Decided once
 * per process, so one run never splits its secrets across two stores.
 */
export function protectedOrFileStore(primary: SecretStore, fallback: SecretStore): ResolvedSecretStore {
  let decided: Promise<{ store: SecretStore; kind: SecretStoreKind }> | undefined
  const decide = () =>
    (decided ??= primary
      .available()
      .catch(() => false)
      .then((ok) => (ok ? { store: primary, kind: "protected" as const } : { store: fallback, kind: "file" as const })))
  return {
    kind: async () => (await decide()).kind,
    available: async () => (await decide()).store.available(),
    get: async (name) => (await decide()).store.get(name),
    set: async (name, value) => (await decide()).store.set(name, value),
    delete: async (name) => (await decide()).store.delete(name),
  }
}
