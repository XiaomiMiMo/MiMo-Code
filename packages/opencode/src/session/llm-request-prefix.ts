import { Effect } from "effect"
import { tool, jsonSchema, asSchema, type Tool as AITool } from "ai"
import z from "zod"
import { MessageV2 } from "./message-v2"
import type { SessionID } from "./schema"
import { Agent } from "../agent/agent"
import type { Provider } from "../provider"
import { LLM } from "./llm"
import { ToolRegistry } from "../tool"
import { ProviderTransform } from "../provider"
import { MCP } from "../mcp"
import { Permission } from "@/permission"
import { usesGPTToolset } from "@/tool/gpt"
import type { PromptConfig } from "./session"

/**
 * Build the LLM request prefix (system + tools + inheritedMessages) from the
 * given msgs array. Given identical inputs this returns deep-equal output
 * (modulo plugin trigger determinism, which is the only external non-determinism
 * source).
 *
 * Used by:
 *   - parent runLoop, to construct its own request
 *   - tryStartCheckpointWriter, to capture a frozen ForkContext at spawn time
 *
 * Both call sites must use this same function — the byte-equal invariant
 * across parent and fork is a structural consequence, not a separate assertion.
 *
 * Slicing (e.g. for fork capture at a watermark) is a caller concern; callers
 * pass the already-sliced msgs. ForkContext.watermarkMsgID is a boundary marker
 * on the fork context, not a parameter here.
 */
export const buildLLMRequestPrefix = Effect.fn("Session.buildLLMRequestPrefix")(function* (input: {
  sessionID: SessionID
  agent: Agent.Info
  model: Provider.Model
  msgs: MessageV2.WithParts[]
  /**
   * Caller-built system parts to splice into the system array (after agent.prompt
   * and before memory instructions). Currently env, skills, instructions in that
   * order. Caller is responsible for the ordering and content.
   */
  additions: string[]
  prompt?: PromptConfig
  /**
   * Session permission ruleset, merged with the agent's own to decide which
   * MCP tools the wire request drops — the same input `LLM.resolveTools` feeds
   * to `Agent.runtimePermission` when it prunes the provider tool list. Omitted
   * (checkpoint capture has no session in scope) means "agent permission only",
   * which matches the parent whenever the session adds no MCP-scoped deny rule.
   */
  sessionPermission?: Permission.Ruleset
}) {
  const llm = yield* LLM.Service
  const toolRegistry = yield* ToolRegistry.Service
  const mcp = yield* MCP.Service

  // Always use full msgs — slicing is a fork-capture concern that lives at the
  // caller (ForkContext.watermarkMsgID is a boundary marker, not a slice arg).
  // See spec changelog at docs/superpowers/specs/2026-05-26-fork-agent-prefix-cache-design.md
  const inheritedMessages = yield* MessageV2.toModelMessagesEffect(input.msgs, input.model)

  // Find the last user message; required for system "user.system" pass-through
  const lastUserMsg = input.msgs.findLast((m) => m.info.role === "user")
  if (!lastUserMsg)
    return yield* Effect.die(new Error("buildLLMRequestPrefix: no user message in msgs"))
  const lastUser = input.prompt
    ? {
        ...(lastUserMsg.info as MessageV2.User),
        system: input.prompt.system,
        systemMode: input.prompt.systemMode,
        harness: input.prompt.harness,
      }
    : (lastUserMsg.info as MessageV2.User)

  // Build system using LLM.buildSystemArray (single source of truth shared with stream())
  const system = yield* llm.buildSystemArray({
    agent: input.agent,
    model: input.model,
    system: input.additions,
    user: lastUser,
    sessionID: input.sessionID as string,
    agentID: lastUser.agentID,
  })

  // Built-in tool schemas via the parent agent's registry view (its toolAllowlist
  // and harness gate which built-ins appear here); MCP tools are appended below.
  const toolDefs = yield* toolRegistry.tools({
    modelID: input.model.id,
    providerID: input.model.providerID,
    agent: input.agent,
    harness: lastUser.harness,
  })
  const tools: Record<string, AITool> = {}
  for (const item of toolDefs) {
    const schema = ProviderTransform.schema(input.model, z.toJSONSchema(item.parameters))
    tools[item.id] = tool({
      description: item.description,
      inputSchema: jsonSchema(schema),
    })
  }

  // Append MCP tool schemas so the captured prefix carries the same tool set the
  // parent's real request emits. Before this, MCP was merged ONLY in resolveTools
  // (the parent path); the prefix here saw built-ins alone, so any MCP server made
  // ForkContext.tools diverge from the parent on the first turn — breaking the
  // tool-list prefix cache and stripping MCP from fork:false checkpoint-writer
  // requests (which send this schema directly).
  //
  // The parent's provider-visible MCP set is what the AI SDK actually wires up:
  // SessionPrompt.resolveTools admits every connected MCP tool into its `tools`
  // map (prompt.ts:1847) but the SDK's prepareToolsAndToolChoice filters the wire
  // tools by `activeTools`. So the parity target is exactly "the connected MCP
  // tools that end up in activeTools":
  //   - Under the GPT/Codex toolset, MCP tools NEVER enter activeTools — they are
  //     reached through mcp-tool-search instead (prompt.ts:1705 `&& !useGPTTools`,
  //     :1918). The parent emits ZERO MCP tool definitions, so the prefix must too:
  //     skip the whole MCP append.
  //   - Otherwise MCP tools enter activeTools unless permission-denied or toggled
  //     off for the turn (user.tools); the agent toolAllowlist does not prune the
  //     wire set, so it is intentionally not applied here.
  // MCP.tools() output is TurnContext-independent (context only rides along to the
  // execute closure for lifecycle notifications), so a minimal session-scoped
  // context reproduces the parent's schema byte-for-byte.
  const useGPTTools = usesGPTToolset(input.model.id, lastUser.harness, input.model.api.id, input.model.family)
  if (!useGPTTools) {
    const mcpTools = Object.entries(
      yield* mcp.tools({ sessionId: input.sessionID as string, turnId: lastUser.id, actorId: lastUser.agentID }),
    ).toSorted(([a], [b]) => a.localeCompare(b))
    const disabledMcpTools = Permission.disabled(
      mcpTools.map(([key]) => key),
      Agent.runtimePermission(input.agent, input.sessionPermission),
    )
    for (const [key, item] of mcpTools) {
      if (!item.execute) continue
      if (key in tools) continue
      if (lastUser.tools?.[key] === false) continue
      if (disabledMcpTools.has(key)) continue
      const rawSchema = yield* Effect.promise(() => Promise.resolve(asSchema(item.inputSchema).jsonSchema))
      const schema = ProviderTransform.schema(input.model, rawSchema)
      tools[key] = tool({
        description: item.description,
        inputSchema: jsonSchema(schema),
      })
    }
  }

  return { system, tools, inheritedMessages }
})
