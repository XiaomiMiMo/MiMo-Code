import path from "path"
import os from "os"
import { Filesystem } from "@/util"
import { Path as GlobalPath } from "@/global"
import { Flock } from "@mimo-ai/shared/util/flock"

export type TrustLevel = "trusted" | "untrusted" | "dangerous"

const STORE_FILE = path.join(GlobalPath.data, "trusted-workspaces.json")
const LOCK_NAME = `workspace-trust:${STORE_FILE}`

async function readStore(): Promise<string[]> {
  const text = await Filesystem.readText(STORE_FILE).catch(() => "")
  if (!text) return []
  const parsed = JSON.parse(text)
  return Array.isArray(parsed.trustedPaths) ? parsed.trustedPaths : []
}

async function writeStore(trustedPaths: string[]) {
  await Filesystem.write(STORE_FILE, JSON.stringify({ version: 1, trustedPaths }, null, 2))
}

export async function checkTrust(directory: string): Promise<TrustLevel> {
  const normalized = path.resolve(directory)

  // Detect home directory: Unix ($HOME), Windows (%USERPROFILE%, %HOMEDRIVE%%HOMEPATH%)
  const homeCandidates = [
    process.env.HOME,
    process.env.USERPROFILE,
    process.env.HOMEDRIVE && process.env.HOMEPATH
      ? path.join(process.env.HOMEDRIVE, process.env.HOMEPATH)
      : undefined,
    os.homedir(),
  ].filter(Boolean) as string[]

  const isHome = homeCandidates.some((h) => path.resolve(h) === normalized)
  const isRoot = path.parse(normalized).root === normalized
  if (isHome || isRoot) return "dangerous"

  const trustedPaths = await readStore()
  const isTrusted = trustedPaths.some(
    (trusted) => normalized === trusted || normalized.startsWith(trusted + path.sep),
  )
  return isTrusted ? "trusted" : "untrusted"
}

export async function markTrusted(directory: string) {
  const normalized = path.resolve(directory)
  await Flock.withLock(LOCK_NAME, async () => {
    const trustedPaths = await readStore()
    if (trustedPaths.includes(normalized)) return
    trustedPaths.push(normalized)
    await writeStore(trustedPaths)
  })
}

export async function listTrusted(): Promise<string[]> {
  return readStore()
}

export async function revokeTrust(directory: string) {
  const normalized = path.resolve(directory)
  await Flock.withLock(LOCK_NAME, async () => {
    const trustedPaths = await readStore()
    await writeStore(trustedPaths.filter((p) => p !== normalized))
  })
}
