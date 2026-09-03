import { describe, expect, test } from "bun:test"
import { jsonSchema, tool } from "ai"
import { Instance } from "../../src/project/instance"
import { Session as SessionNs } from "../../src/session"
import { SessionPrefixSnapshot } from "../../src/session/prefix-snapshot"
import { MessageID } from "../../src/session/schema"
import { AppRuntime } from "../../src/effect/app-runtime"
import { tmpdir } from "../fixture/fixture"

describe("session prefix snapshot", () => {
  test("pins, rotates, advances, and cascades with its session", async () => {
    await using tmp = await tmpdir({ git: true })
    await Instance.provide({
      directory: tmp.path,
      fn: async () => {
        const session = await AppRuntime.runPromise(SessionNs.Service.use((service) => service.create({})))
        const key = SessionPrefixSnapshot.profileKey({
          providerID: "test",
          modelID: "test-model",
          agent: "build",
          agentID: "main",
          harness: "auto",
          systemMode: "append",
          system: "",
          permission: [],
        })
        const firstWatermark = MessageID.ascending()
        const first = await AppRuntime.runPromise(
          SessionPrefixSnapshot.pin({
            sessionID: session.id,
            profileKey: key,
            system: ["first"],
            toolsHash: "tools-1",
            tools: [],
            watermarkMessageID: firstWatermark,
          }),
        )
        expect(first).toMatchObject({
          revision: 1,
          system: ["first"],
          tools_hash: "tools-1",
          watermark_message_id: firstWatermark,
        })

        const pinned = await AppRuntime.runPromise(
          SessionPrefixSnapshot.pin({
            sessionID: session.id,
            profileKey: key,
            system: ["ignored"],
            toolsHash: "ignored",
            tools: [],
            watermarkMessageID: MessageID.ascending(),
          }),
        )
        expect(pinned).toEqual(first)

        const rotated = await AppRuntime.runPromise(
          SessionPrefixSnapshot.rotate({
            sessionID: session.id,
            profileKey: key,
            system: ["second"],
            toolsHash: "tools-2",
            tools: [],
            watermarkMessageID: firstWatermark,
          }),
        )
        expect(rotated).toMatchObject({ revision: 2, system: ["second"], tools_hash: "tools-2" })

        const finalWatermark = MessageID.ascending()
        await AppRuntime.runPromise(
          SessionPrefixSnapshot.advance({
            sessionID: session.id,
            profileKey: key,
            revision: 1,
            watermarkMessageID: MessageID.ascending(),
          }),
        )
        await AppRuntime.runPromise(
          SessionPrefixSnapshot.advance({
            sessionID: session.id,
            profileKey: key,
            revision: 2,
            watermarkMessageID: finalWatermark,
          }),
        )
        expect(await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, key))).toMatchObject({
          revision: 2,
          watermark_message_id: finalWatermark,
        })

        await AppRuntime.runPromise(SessionNs.Service.use((service) => service.remove(session.id)))
        expect(await AppRuntime.runPromise(SessionPrefixSnapshot.get(session.id, key))).toBeUndefined()
      },
    })
  })

  test("profile key is stable across key order and splits on the request tool mask", () => {
    const permission = [{ permission: "*", pattern: "*", action: "allow" as const }]
    const key = SessionPrefixSnapshot.profileKey({
      providerID: "p",
      modelID: "m",
      agent: "build",
      agentID: "main",
      harness: "auto",
      systemMode: "append",
      system: "",
      permission,
    })
    expect(key).toBe(
      SessionPrefixSnapshot.profileKey({
        permission,
        systemMode: "append",
        system: "",
        harness: "auto",
        agentID: "main",
        agent: "build",
        modelID: "m",
        providerID: "p",
      }),
    )
    expect(key).not.toBe(
      SessionPrefixSnapshot.profileKey({
        providerID: "p",
        modelID: "other",
        agent: "build",
        agentID: "main",
        harness: "auto",
        systemMode: "append",
        system: "",
        permission,
      }),
    )
    const profile = {
      providerID: "p",
      modelID: "m",
      agent: "build",
      agentID: "main",
      harness: "auto",
      systemMode: "append",
      system: "",
      permission,
    }
    // The per-request tool mask reaches the key through `permission`, which
    // SessionPrompt persists via setPermission — so it survives a restart instead of
    // being re-derived in memory on every turn.
    const masked = SessionPrefixSnapshot.profileKey({
      ...profile,
      permission: [...permission, { permission: "mcp_keep", action: "deny" as const, pattern: "*" }],
    })
    expect(masked).not.toBe(key)
  })

  test("advertised hash tracks order and the persisted schema bytes", async () => {
    const tools = {
      read: tool({ description: "r", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
      mcp_keep: tool({ description: "a", inputSchema: jsonSchema({ type: "object", properties: {} }) }),
    }
    const first = await SessionPrefixSnapshot.snapshotTools(tools, ["read", "mcp_keep"], ["read"])
    expect(first).toEqual([
      { name: "read", description: "r", input_schema: { type: "object", properties: {} }, source: "local" },
      { name: "mcp_keep", description: "a", input_schema: { type: "object", properties: {} }, source: "mcp" },
    ])
    // Same set, different order => different prefix bytes => must rotate.
    const reordered = await SessionPrefixSnapshot.snapshotTools(tools, ["mcp_keep", "read"], ["read"])
    expect(SessionPrefixSnapshot.advertisedHash(reordered)).not.toBe(SessionPrefixSnapshot.advertisedHash(first))
    expect(SessionPrefixSnapshot.advertisedHash(first)).toBe(
      SessionPrefixSnapshot.advertisedHash(await SessionPrefixSnapshot.snapshotTools(tools, ["read", "mcp_keep"], ["read"])),
    )
  })

  test("persisted source survives a later local tool shadowing a pinned MCP name", () => {
    const pinned = {
      name: "mcp_keep",
      description: "keep v1",
      input_schema: { type: "object" as const, properties: {} },
      source: "mcp" as const,
    }
    // A plugin registering a local `mcp_keep` this turn must not reclassify the pinned
    // entry — name-based inference would, and would drop it from the advertised set.
    expect(SessionPrefixSnapshot.toolSource(pinned, ["read", "mcp_keep"])).toBe("mcp")
    expect(SessionPrefixSnapshot.toolSource({ ...pinned, source: undefined }, ["read", "mcp_keep"])).toBe("local")
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: tool({ description: "r", inputSchema: jsonSchema({ type: "object", properties: {} }) }) },
      activeTools: ["read"],
      frozen: [
        { name: "read", description: "r", input_schema: { type: "object", properties: {} }, source: "local" },
        pinned,
      ],
      localToolNames: ["read", "mcp_keep"],
    })
    expect(overlaid.activeTools).toEqual(["read", "mcp_keep"])
  })

  test("overlay pins frozen MCP tools and appends search-loaded ones after them", () => {
    const local = tool({ description: "read files", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const keep = tool({ description: "keep v1", inputSchema: jsonSchema({ type: "object", properties: { id: { type: "string" } } }) })
    const next = tool({ description: "appeared later", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: local, mcp_keep: keep, mcp_new: next },
      activeTools: ["read", "mcp_keep", "mcp_new"],
      frozen: [
        { name: "read", description: "read files", input_schema: { type: "object", properties: {} }, source: "local" },
        {
          name: "mcp_keep",
          description: "keep v1",
          input_schema: { type: "object", properties: { id: { type: "string" } } },
          source: "mcp",
        },
        { name: "mcp_gone", description: "gone", input_schema: { type: "object", properties: {} }, source: "mcp" },
      ],
      localToolNames: ["read"],
      searchLoadedToolNames: ["mcp_new"],
    })
    // Pinned block first, in its pinned order, so the cached head still matches.
    // A tool the model deliberately loaded is advertised, but only after that block.
    expect(overlaid.activeTools).toEqual(["read", "mcp_keep", "mcp_gone", "mcp_new"])
    expect(Object.keys(overlaid.tools)).toEqual(["read", "mcp_keep", "mcp_gone", "mcp_new"])
    expect(overlaid.tools.mcp_keep.description).toBe("keep v1")
    // A disconnected tool keeps its schema and answers with a clean unavailable result.
    expect(overlaid.tools.mcp_gone.description).toBe("gone")
  })

  test("overlay does not advertise a tool that merely connected between turns", () => {
    const local = tool({ description: "read files", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const next = tool({ description: "appeared later", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    // Same inputs as above, minus the search hit: a server connecting is involuntary
    // churn, so mcp_new stays registered-but-unadvertised and the prefix is unchanged.
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: local, mcp_new: next },
      activeTools: ["read", "mcp_new"],
      frozen: [
        { name: "read", description: "read files", input_schema: { type: "object", properties: {} }, source: "local" },
        { name: "mcp_gone", description: "gone", input_schema: { type: "object", properties: {} }, source: "mcp" },
      ],
      localToolNames: ["read"],
    })
    expect(overlaid.activeTools).toEqual(["read", "mcp_gone"])
    expect(overlaid.tools.mcp_new).toBe(next)
    expect(Object.keys(overlaid.tools).at(-1)).toBe("mcp_new")
  })

  test("overlay keeps unadvertised tools registered but never last", () => {
    const gateway = tool({ description: "exec", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const unadvertised = tool({ description: "direct only", inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { exec: gateway, mcp_direct: unadvertised },
      activeTools: ["exec"],
      frozen: [{ name: "exec", description: "exec", input_schema: { type: "object", properties: {} }, source: "local" }],
      localToolNames: ["exec"],
    })
    expect(overlaid.activeTools).toEqual(["exec"])
    // Still dispatchable through exec / a direct call...
    expect(overlaid.tools.mcp_direct).toBe(unadvertised)
    // ...but after the advertised block, so it can't take the cache marker.
    expect(Object.keys(overlaid.tools).at(-1)).toBe("mcp_direct")
  })

  test("StructuredOutput is pinned as local and dropped on a plain-text turn", async () => {
    const t = (d: string) => tool({ description: d, inputSchema: jsonSchema({ type: "object", properties: {} }) })
    // The run loop registers StructuredOutput AFTER localToolNames is computed, so a
    // name-based guess would call it MCP and re-advertise it forever.
    const frozen = await SessionPrefixSnapshot.snapshotTools(
      { read: t("r"), StructuredOutput: t("so") },
      // Duplicated on purpose: the run loop pushes onto an activeTools that may already
      // carry it from a previous overlay.
      ["read", "StructuredOutput", "StructuredOutput"],
      ["read"],
    )
    expect(frozen.map((item) => [item.name, item.source])).toEqual([
      ["read", "local"],
      ["StructuredOutput", "local"],
    ])
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: t("r") },
      activeTools: ["read"],
      frozen,
      localToolNames: ["read"],
    })
    // A later plain-text request must not be told to call StructuredOutput.
    expect(overlaid.activeTools).toEqual(["read"])
  })

  test("a pinned MCP tool revoked this turn leaves the advertised set", async () => {
    const t = (d: string) => tool({ description: d, inputSchema: jsonSchema({ type: "object", properties: {} }) })
    const frozen = await SessionPrefixSnapshot.snapshotTools(
      { read: t("r"), mcp_keep: t("k"), mcp_revoked: t("g"), mcp_offline: t("o") },
      ["read", "mcp_keep", "mcp_revoked", "mcp_offline"],
      ["read"],
    )
    const overlaid = SessionPrefixSnapshot.overlayFrozenMcpTools({
      tools: { read: t("r"), mcp_keep: t("k"), mcp_revoked: t("g") },
      activeTools: ["read", "mcp_keep"],
      frozen,
      localToolNames: ["read"],
      // mcp_revoked is still CONNECTED but permission / mask / allowlist denied it this
      // request: llm.ts would strip it off the wire, so pinning it would make the
      // snapshot describe a tool block the provider never saw.
      authorizedMcpToolNames: ["mcp_keep"],
      connectedMcpToolNames: ["mcp_keep", "mcp_revoked"],
    })
    // mcp_offline is absent from BOTH sets — merely disconnected, which is the churn the
    // freeze exists to absorb, so it keeps its pinned slot.
    expect(overlaid.activeTools).toEqual(["read", "mcp_keep", "mcp_offline"])
    // Revoked stays registered (a direct call still resolves) but unadvertised.
    expect(overlaid.tools.mcp_revoked).toBeDefined()
    expect(Object.keys(overlaid.tools).at(-1)).toBe("mcp_revoked")
  })

  test("mcp_tool_search always counts as MCP-advertised", () => {
    const local = ["read", "bash"]
    expect(SessionPrefixSnapshot.isMcpAdvertisedTool("mcp_tool_search", local)).toBe(true)
    expect(SessionPrefixSnapshot.isMcpAdvertisedTool("read", local)).toBe(false)
    expect(
      SessionPrefixSnapshot.toolSource(
        { name: "mcp_tool_search", input_schema: { type: "object", properties: {} } },
        local,
      ),
    ).toBe("mcp")
  })
})
