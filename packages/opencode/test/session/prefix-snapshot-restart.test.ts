import { describe, expect, test } from "bun:test"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir as osTmpdir } from "node:os"
import path from "node:path"

// `Database.Path` and `Flag.MIMOCODE_DB` are both resolved at import time, and the
// suite's preload pins MIMOCODE_DB=":memory:" — so a genuine "does the pinned tool set
// outlive the process" check cannot be written in-process. Each phase below runs in its
// own `bun -e` against the SAME on-disk db file: phase 1 writes and exits, phase 2 is a
// cold process that has only sqlite to read from.
function phase(script: string, env: Record<string, string>) {
  const result = Bun.spawnSync({
    cmd: [process.execPath, "-e", script],
    cwd: process.cwd(),
    env: { ...process.env, ...env },
  })
  const stdout = result.stdout.toString()
  const stderr = result.stderr.toString()
  if (result.exitCode !== 0) throw new Error(`phase failed (${result.exitCode}):\n${stdout}\n${stderr}`)
  return stdout.trim()
}

const WRITE = `
import { Instance } from "./src/project/instance"
import { Session } from "./src/session"
import { SessionPrefixSnapshot } from "./src/session/prefix-snapshot"
import { MessageID } from "./src/session/schema"
import { AppRuntime } from "./src/effect/app-runtime"
import { Database } from "./src/storage"
import { jsonSchema, tool } from "ai"
import { Log } from "./src/util"
import { initProjectors } from "./src/server/projectors"
void Log.init({ print: false })
initProjectors()

const sessionID = await Instance.provide({
  directory: process.env.WORKDIR,
  fn: async () => {
    const session = await AppRuntime.runPromise(Session.Service.use((s) => s.create({})))
    const tools = {
      read: tool({ description: "read files", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
      mcp_keep: tool({
        description: "keep v1",
        inputSchema: jsonSchema({ type: "object", properties: { id: { type: "string" } } }),
      }),
    }
    const snapshot = await SessionPrefixSnapshot.snapshotTools(tools, ["read", "mcp_keep"], ["read"])
    await AppRuntime.runPromise(
      SessionPrefixSnapshot.pin({
        sessionID: session.id,
        profileKey: process.env.PROFILE_KEY,
        system: ["pinned system"],
        toolsHash: SessionPrefixSnapshot.advertisedHash(snapshot),
        tools: snapshot,
        watermarkMessageID: MessageID.ascending(),
      }),
    )
    return session.id
  },
})
await Instance.disposeAll()
Database.close()
process.stdout.write(sessionID)
process.exit(0)
`

// Cold process, and every MCP server is "down" (an empty live tools map). If the
// advertised prefix can still be rebuilt here, it came from sqlite and nothing else.
const READ = `
import { Instance } from "./src/project/instance"
import { SessionPrefixSnapshot } from "./src/session/prefix-snapshot"
import { AppRuntime } from "./src/effect/app-runtime"
import { Database } from "./src/storage"
import { jsonSchema, tool } from "ai"
import { Log } from "./src/util"
import { initProjectors } from "./src/server/projectors"
void Log.init({ print: false })
initProjectors()

const out = await Instance.provide({
  directory: process.env.WORKDIR,
  fn: async () => {
    const frozen = await AppRuntime.runPromise(
      SessionPrefixSnapshot.get(process.env.SESSION_ID, process.env.PROFILE_KEY),
    )
    if (!frozen) return { found: false }
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: tool({ description: "read files", inputSchema: jsonSchema({ type: "object", properties: {} }) }) },
      activeTools: ["read"],
      frozen: frozen.tools,
      localToolNames: ["read"],
    })
    const rehashed = SessionPrefixSnapshot.advertisedHash(
      await SessionPrefixSnapshot.snapshotTools(overlaid.tools, overlaid.activeTools, ["read"]),
    )
    // Re-pinning must be a no-op: the cold turn joins revision 1, never forks it.
    const repinned = await AppRuntime.runPromise(
      SessionPrefixSnapshot.pin({
        sessionID: process.env.SESSION_ID,
        profileKey: process.env.PROFILE_KEY,
        system: ["ignored after restart"],
        toolsHash: "ignored",
        tools: [],
        watermarkMessageID: frozen.watermark_message_id,
      }),
    )
    return {
      found: true,
      revision: frozen.revision,
      system: frozen.system,
      tools: frozen.tools,
      advertised: overlaid.activeTools,
      keepDescription: overlaid.tools.mcp_keep?.description,
      hashMatches: rehashed === frozen.tools_hash,
      repinnedRevision: repinned.revision,
      repinnedSystem: repinned.system,
    }
  },
})
await Instance.disposeAll()
Database.close()
process.stdout.write(JSON.stringify(out))
process.exit(0)
`

describe("session prefix snapshot durability across a real process restart", () => {
  test("a cold process rebuilds the pinned MCP prefix from sqlite alone", async () => {
    const workdir = await mkdtemp(path.join(osTmpdir(), "prefix-restart-"))
    const db = path.join(workdir, "mimocode.db")
    const profileKey = "restart-profile-key"
    try {
      const env = { MIMOCODE_DB: db, WORKDIR: workdir, PROFILE_KEY: profileKey }
      const sessionID = phase(WRITE, env)
      expect(sessionID).toMatch(/^ses_/)

      const out = JSON.parse(phase(READ, { ...env, SESSION_ID: sessionID }))
      expect(out.found).toBe(true)
      expect(out.revision).toBe(1)
      expect(out.system).toEqual(["pinned system"])
      // Order, schema and source all survived the process boundary.
      expect(out.tools).toEqual([
        { name: "read", description: "read files", input_schema: { type: "object", properties: {} }, source: "local" },
        {
          name: "mcp_keep",
          description: "keep v1",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
          source: "mcp",
        },
      ])
      // With no MCP server up, mcp_keep is still advertised with its pinned schema...
      expect(out.advertised).toEqual(["read", "mcp_keep"])
      expect(out.keepDescription).toBe("keep v1")
      // ...and the rebuilt bytes hash to the pinned value, so the provider prefix cache
      // is still warm after the restart instead of being busted by it.
      expect(out.hashMatches).toBe(true)
      // The cold turn joined the existing revision rather than forking a new prefix.
      expect(out.repinnedRevision).toBe(1)
      expect(out.repinnedSystem).toEqual(["pinned system"])
    } finally {
      await rm(workdir, { recursive: true, force: true }).catch(() => undefined)
    }
  }, 120_000)
})
