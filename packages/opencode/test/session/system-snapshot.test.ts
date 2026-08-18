import { describe, expect, test } from "bun:test"
import fs from "fs/promises"
import path from "path"
import { tmpdir } from "../fixture/fixture"
import { SessionID } from "../../src/session/schema"
import {
  SESSION_SYSTEM_SNAPSHOT_PROTOCOL,
  publish,
  read,
  remove,
  snapshotPath,
  type SessionSystemSnapshotIdentity,
} from "../../src/session/system-snapshot"

function identity(
  sessionID: SessionID,
  input: Partial<SessionSystemSnapshotIdentity> = {},
): SessionSystemSnapshotIdentity {
  return {
    protocol: SESSION_SYSTEM_SNAPSHOT_PROTOCOL,
    sessionID,
    providerID: "anthropic",
    modelID: "claude-sonnet-4-6",
    agent: "build",
    agentID: "main",
    edition: "overseas",
    checkpoint: true,
    ...input,
  }
}

describe("session system snapshot", () => {
  test("[TP-R16-01] first publish wins and reopened readers reuse the exact bytes", async () => {
    await using tmp = await tmpdir()
    const key = identity(SessionID.descending())

    expect(await publish(key, "first\nbytes", tmp.path)).toBe("first\nbytes")
    expect(await publish(key, "reassembled-but-different", tmp.path)).toBe("first\nbytes")
    expect(await read(key, tmp.path)).toBe("first\nbytes")
  })

  test("[TP-R16-03] compatibility domains remain independent", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.descending()
    const base = identity(sessionID)
    const provider = identity(sessionID, { providerID: "bedrock" })
    const model = identity(sessionID, { modelID: "claude-opus-4-6" })
    const agent = identity(sessionID, { agent: "plan" })
    const actor = identity(sessionID, { agentID: "peer-1" })
    const edition = identity(sessionID, { edition: "domestic" })
    const checkpoint = identity(sessionID, { checkpoint: false })
    const protocol = identity(sessionID, { protocol: SESSION_SYSTEM_SNAPSHOT_PROTOCOL + 1 })

    await Promise.all([
      publish(base, "base", tmp.path),
      publish(provider, "provider", tmp.path),
      publish(model, "model", tmp.path),
      publish(agent, "agent", tmp.path),
      publish(actor, "actor", tmp.path),
      publish(edition, "edition", tmp.path),
      publish(checkpoint, "checkpoint", tmp.path),
      publish(protocol, "protocol", tmp.path),
    ])

    expect(await Promise.all(
      [base, provider, model, agent, actor, edition, checkpoint, protocol].map((key) => read(key, tmp.path)),
    )).toEqual(["base", "provider", "model", "agent", "actor", "edition", "checkpoint", "protocol"])
  })

  test("[TP-R16-04] corrupt files rebuild completely and concurrent creators share one winner", async () => {
    await using tmp = await tmpdir()
    const key = identity(SessionID.descending())
    const file = snapshotPath(key, tmp.path)
    await fs.mkdir(path.dirname(file), { recursive: true })
    await fs.writeFile(file, "{broken")

    expect(await publish(key, "repaired", tmp.path)).toBe("repaired")
    await fs.writeFile(file, JSON.stringify({ version: 1, identity: key, system: 42 }))
    expect(await publish(key, "repaired-type", tmp.path)).toBe("repaired-type")
    await fs.writeFile(file, JSON.stringify({
      version: 1,
      identity: { ...key, modelID: "wrong-model" },
      system: "wrong-domain",
    }))
    expect(await publish(key, "repaired-identity", tmp.path)).toBe("repaired-identity")

    const concurrent = identity(SessionID.descending())
    const winners = await Promise.all([
      publish(concurrent, "one", tmp.path),
      publish(concurrent, "two", tmp.path),
      publish(concurrent, "three", tmp.path),
    ])
    expect(new Set(winners).size).toBe(1)
    expect(await read(concurrent, tmp.path)).toBe(winners[0])

    const blockedRoot = path.join(tmp.path, "not-a-directory")
    await fs.writeFile(blockedRoot, "occupied")
    expect(await publish(identity(SessionID.descending()), "disk-fallback", blockedRoot)).toBe("disk-fallback")
  })

  test("[TP-R16-05] files are private and removing a session clears every domain", async () => {
    await using tmp = await tmpdir()
    const sessionID = SessionID.descending()
    const first = identity(sessionID)
    const second = identity(sessionID, { agent: "plan" })
    await publish(first, "first", tmp.path)
    await publish(second, "second", tmp.path)

    if (process.platform !== "win32") {
      expect((await fs.stat(path.dirname(snapshotPath(first, tmp.path)))).mode & 0o777).toBe(0o700)
      expect((await fs.stat(snapshotPath(first, tmp.path))).mode & 0o777).toBe(0o600)
    }

    await remove(sessionID, tmp.path)
    expect(await read(first, tmp.path)).toBeUndefined()
    expect(await read(second, tmp.path)).toBeUndefined()
  })
})
