import type {
  Event,
  createOpencodeClient,
  Project,
  Model,
  Provider,
  Permission,
  UserMessage,
  Message,
  Part,
  Auth,
  Config as SDKConfig,
} from "@mimo-ai/sdk"
import type { Provider as ProviderV2, Model as ModelV2 } from "@mimo-ai/sdk/v2"

import type { BunShell } from "./shell.js"
import { type ToolDefinition } from "./tool.js"

export * from "./tool.js"

export type ProviderContext = {
  source: "env" | "config" | "custom" | "api"
  info: Provider
  options: Record<string, any>
}

export type WorkspaceInfo = {
  id: string
  type: string
  name: string
  branch: string | null
  directory: string | null
  extra: unknown | null
  projectID: string
}

export type WorkspaceTarget =
  | {
      type: "local"
      directory: string
    }
  | {
      type: "remote"
      url: string | URL
      headers?: HeadersInit
    }

export type WorkspaceAdaptor = {
  name: string
  description: string
  configure(config: WorkspaceInfo): WorkspaceInfo | Promise<WorkspaceInfo>
  create(config: WorkspaceInfo, env: Record<string, string | undefined>, from?: WorkspaceInfo): Promise<void>
  remove(config: WorkspaceInfo): Promise<void>
  target(config: WorkspaceInfo): WorkspaceTarget | Promise<WorkspaceTarget>
}

export type PluginInput = {
  client: ReturnType<typeof createOpencodeClient>
  project: Project
  directory: string
  worktree: string
  experimental_workspace: {
    register(type: string, adaptor: WorkspaceAdaptor): void
  }
  serverUrl: URL
  $: BunShell
}

export type PluginOptions = Record<string, unknown>

export type Config = Omit<SDKConfig, "plugin"> & {
  plugin?: Array<string | [string, PluginOptions]>
}

export type Plugin = (input: PluginInput, options?: PluginOptions) => Promise<Hooks>

export type PluginModule = {
  id?: string
  server: Plugin
  tui?: never
}

type Rule = {
  key: string
  op: "eq" | "neq"
  value: string
}

export type AuthHook = {
  provider: string
  loader?: (auth: () => Promise<Auth>, provider: Provider) => Promise<Record<string, any>>
  methods: (
    | {
        type: "oauth"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize(inputs?: Record<string, string>): Promise<AuthOAuthResult>
      }
    | {
        type: "api"
        label: string
        prompts?: Array<
          | {
              type: "text"
              key: string
              message: string
              placeholder?: string
              validate?: (value: string) => string | undefined
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
          | {
              type: "select"
              key: string
              message: string
              options: Array<{
                label: string
                value: string
                hint?: string
              }>
              /** @deprecated Use `when` instead */
              condition?: (inputs: Record<string, string>) => boolean
              when?: Rule
            }
        >
        authorize?(inputs?: Record<string, string>): Promise<
          | {
              type: "success"
              key: string
              provider?: string
            }
          | {
              type: "failed"
            }
        >
      }
  )[]
}

export type AuthOAuthResult = { url: string; instructions: string } & (
  | {
      method: "auto"
      callback(code?: string): Promise<
        | ({
            type: "success"
            provider?: string
            metadata?: Record<string, string>
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
  | {
      method: "code"
      callback(code: string): Promise<
        | ({
            type: "success"
            provider?: string
            metadata?: Record<string, string>
          } & (
            | {
                refresh: string
                access: string
                expires: number
                accountId?: string
                enterpriseUrl?: string
              }
            | { key: string }
          ))
        | {
            type: "failed"
          }
      >
    }
)

export type ProviderHookContext = {
  auth?: Auth
}

export type ProviderHook = {
  id: string
  models?: (provider: ProviderV2, ctx: ProviderHookContext) => Promise<Record<string, ModelV2>>
}

/** @deprecated Use AuthOAuthResult instead. */
export type AuthOuathResult = AuthOAuthResult

// ----- Actor lifecycle hook types -----

/**
 * Agent types excluded from actor.preStop / actor.postStop by default.
 * Includes the agents registered in src/agent/agent.ts plus runtime-only
 * pseudo-agents ("main" = root actor, "compaction" = auto-compaction subsystem)
 * that are never spawned via the agent registry.
 */
export const BUILT_IN_AGENTS = [
  "main", "general", "build", "explore", "summary",
  "title", "checkpoint-writer", "dream", "distill", "compaction",
] as const

export type BuiltInAgent = (typeof BUILT_IN_AGENTS)[number]
export type ActorMode = "subagent" | "peer"
export type ActorLifecycle = "ephemeral" | "persistent"
export type ActorOutcome = "success" | "failure" | "cancelled"

export type ActorMatcher = {
  mode?: ActorMode
  agentType?:
    | string
    | string[]
    | { include: string[]; exclude?: string[] }
    | { excludeOnly: string[] } // matches every agent (incl. built-ins) except those listed
}

export type ActorStopBaseInput = {
  sessionID: string
  /** Parent session id when the actor runs in a child session (e.g. checkpoint-writer
   *  runs under a child session keyed on parent_id). Undefined when sessionID === parent.
   *  Plugins that re-derive paths from sessionID should read `parentSessionID ?? sessionID`. */
  parentSessionID?: string
  actorID: string
  parentActorID?: string
  agentType: string
  mode: ActorMode
  lifecycle: ActorLifecycle
  task: string
  description?: string
  finalText?: string
  task_id?: string  // Spec ②: if set, postStop hooks can validate tasks/<task_id>/progress.md
  iteration: number
}

export type ActorPreStopInput = ActorStopBaseInput

export type ActorPostStopInput = ActorStopBaseInput & {
  outcome: ActorOutcome
  error?: string  // outcome === "failure" 时存在
  // false → the spawned agent cannot use the Write tool (read-only, e.g. explore).
  // Absent/undefined → unknown; hooks must NOT suppress on absence (fail-open).
  canWrite?: boolean
}

export type ActorStopOutput = {
  continue?: boolean
  reason?: string
}

export type ActorPreStopHook = (
  input: ActorPreStopInput,
  output: ActorStopOutput,
) => Promise<void>

export type ActorPostStopHook = (
  input: ActorPostStopInput,
  output: ActorStopOutput,
) => Promise<void>

export type ActorPreStopRegistration =
  | ActorPreStopHook
  | { matcher?: ActorMatcher; run: ActorPreStopHook }

export type ActorPostStopRegistration =
  | ActorPostStopHook
  | { matcher?: ActorMatcher; run: ActorPostStopHook }

export interface Hooks {
  event?: (input: { event: Event }) => Promise<void>
  config?: (input: Config) => Promise<void>
  tool?: {
    [key: string]: ToolDefinition
  }
  auth?: AuthHook
  provider?: ProviderHook
  /**
   * Called when a new message is received
   */
  "chat.message"?: (
    input: {
      sessionID: string
      agent?: string
      model?: { providerID: string; modelID: string }
      messageID?: string
      variant?: string
    },
    output: { message: UserMessage; parts: Part[] },
  ) => Promise<void>
  /**
   * Modify parameters sent to LLM
   */
  "chat.params"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: {
      temperature: number
      topP: number
      topK: number
      maxOutputTokens: number | undefined
      options: Record<string, any>
    },
  ) => Promise<void>
  "chat.headers"?: (
    input: { sessionID: string; agent: string; model: Model; provider: ProviderContext; message: UserMessage },
    output: { headers: Record<string, string> },
  ) => Promise<void>
  "permission.ask"?: (input: Permission, output: { status: "ask" | "deny" | "allow" }) => Promise<void>
  "command.execute.before"?: (
    input: { command: string; sessionID: string; arguments: string },
    output: { parts: Part[] },
  ) => Promise<void>
  "tool.execute.before"?: (
    input: { tool: string; sessionID: string; callID: string },
    output: { args: any; cancel?: boolean; cancelReason?: string },
  ) => Promise<void>
  "shell.env"?: (
    input: { cwd: string; sessionID?: string; callID?: string },
    output: { env: Record<string, string> },
  ) => Promise<void>
  "tool.execute.after"?: (
    input: { tool: string; sessionID: string; callID: string; args: any },
    output: {
      title: string
      output: string
      metadata: any
    },
  ) => Promise<void>
  "experimental.chat.messages.transform"?: (
    input: {},
    output: {
      messages: {
        info: Message
        parts: Part[]
      }[]
    },
  ) => Promise<void>
  "experimental.chat.system.transform"?: (
    input: { sessionID?: string; model: Model },
    output: {
      system: string[]
    },
  ) => Promise<void>
  /**
   * Called before session compaction starts. Allows plugins to customize
   * the compaction prompt.
   *
   * - `context`: Additional context strings appended to the default prompt
   * - `prompt`: If set, replaces the default compaction prompt entirely
   */
  "experimental.session.compacting"?: (
    input: { sessionID: string },
    output: { context: string[]; prompt?: string },
  ) => Promise<void>
  /**
   * Called after compaction succeeds and before a synthetic user
   * auto-continue message is added.
   *
   * - `enabled`: Defaults to `true`. Set to `false` to skip the synthetic
   *   user "continue" turn.
   */
  "experimental.compaction.autocontinue"?: (
    input: {
      sessionID: string
      agent: string
      model: Model
      provider: ProviderContext
      message: UserMessage
      overflow: boolean
    },
    output: { enabled: boolean },
  ) => Promise<void>
  "experimental.text.complete"?: (
    input: { sessionID: string; messageID: string; partID: string },
    output: { text: string },
  ) => Promise<void>
  /**
   * Modify tool definitions (description and parameters) sent to LLM
   */
  "tool.definition"?: (input: { toolID: string }, output: { description: string; parameters: any }) => Promise<void>
  /**
   * Fires when an actor (subagent or peer) is about to deliver finalText to its caller.
   * Set `output.continue = true` with `output.reason = "..."` to inject the reason as a
   * synthetic user message and have the actor run another turn before delivery.
   * Default matcher excludes BUILT_IN_AGENTS.
   */
  "actor.preStop"?: ActorPreStopRegistration
  /**
   * Fires AFTER an actor has delivered finalText to its caller. The actor stays alive
   * until the postStop chain ends. Like preStop, can return continue=true with reason
   * to make the actor run another turn — but the new finalText does NOT propagate to
   * the caller (the caller already got finalText_locked at delivery time).
   * Default matcher excludes BUILT_IN_AGENTS.
   */
  "actor.postStop"?: ActorPostStopRegistration
}
