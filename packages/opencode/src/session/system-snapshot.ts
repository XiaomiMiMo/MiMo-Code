import { createHash, randomUUID } from "crypto"
import fs from "fs/promises"
import path from "path"
import { Flock } from "@mimo-ai/shared/util/flock"
import { Global } from "@/global"
import type { SessionID } from "./schema"

export const SESSION_SYSTEM_SNAPSHOT_PROTOCOL = 1

export type SessionSystemSnapshotIdentity = {
  protocol: number
  sessionID: SessionID
  providerID: string
  modelID: string
  agent: string
  agentID: string
  edition: string
  checkpoint: boolean
}

type Snapshot = {
  version: 1
  identity: SessionSystemSnapshotIdentity
  system: string
}

function digest(value: string) {
  return createHash("sha256").update(value).digest("hex")
}

function canonical(identity: SessionSystemSnapshotIdentity) {
  return JSON.stringify({
    protocol: identity.protocol,
    sessionID: identity.sessionID,
    providerID: identity.providerID,
    modelID: identity.modelID,
    agent: identity.agent,
    agentID: identity.agentID,
    edition: identity.edition,
    checkpoint: identity.checkpoint,
  })
}

function sessionDir(sessionID: SessionID, root = path.join(Global.Path.data, "session-system")) {
  return path.join(root, digest(sessionID))
}

export function snapshotPath(
  identity: SessionSystemSnapshotIdentity,
  root = path.join(Global.Path.data, "session-system"),
) {
  return path.join(sessionDir(identity.sessionID, root), `${digest(canonical(identity))}.json`)
}

function valid(value: unknown, identity: SessionSystemSnapshotIdentity): value is Snapshot {
  if (!value || typeof value !== "object") return false
  const raw = value as Record<string, unknown>
  if (raw["version"] !== 1 || typeof raw["system"] !== "string") return false
  return canonical(raw["identity"] as SessionSystemSnapshotIdentity) === canonical(identity)
}

export async function read(
  identity: SessionSystemSnapshotIdentity,
  root = path.join(Global.Path.data, "session-system"),
) {
  return fs
    .readFile(snapshotPath(identity, root), "utf8")
    .then((text) => JSON.parse(text) as unknown)
    .then((value) => (valid(value, identity) ? value.system : undefined))
    .catch(() => undefined)
}

async function write(identity: SessionSystemSnapshotIdentity, system: string, root: string) {
  const file = snapshotPath(identity, root)
  await fs.mkdir(path.dirname(file), { recursive: true, mode: 0o700 })
  await fs.chmod(path.dirname(file), 0o700).catch(() => undefined)
  const tmp = `${file}.${process.pid}.${randomUUID()}.tmp`
  const snapshot: Snapshot = { version: 1, identity, system }
  await fs.writeFile(tmp, JSON.stringify(snapshot), { mode: 0o600 })
  await fs.rename(tmp, file).finally(() => fs.rm(tmp, { force: true }))
  await fs.chmod(file, 0o600).catch(() => undefined)
}

/**
 * Publish the first complete stable system for one compatibility domain.
 * The lock spans the second read and atomic write, so concurrent creators all
 * receive the same winning bytes and no caller can observe a partial file.
 */
export function publish(
  identity: SessionSystemSnapshotIdentity,
  system: string,
  root = path.join(Global.Path.data, "session-system"),
) {
  return Flock
    .withLock(`session-system:${canonical(identity)}`, async () => {
      const existing = await read(identity, root)
      if (existing !== undefined) return existing
      await write(identity, system, root)
      return system
    })
    // A local cache must never become a model-availability dependency. The
    // current request can safely use the fully assembled candidate even when
    // the disk is read-only or the lock service is unavailable; a later request
    // will retry persistence because read() still reports a miss.
    .catch(() => system)
}

export function remove(sessionID: SessionID, root = path.join(Global.Path.data, "session-system")) {
  return fs.rm(sessionDir(sessionID, root), { recursive: true, force: true })
}
