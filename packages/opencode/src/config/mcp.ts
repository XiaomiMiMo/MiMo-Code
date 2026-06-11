import { Schema } from "effect"
import { isRecord } from "@/util/record"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export class Local extends Schema.Class<Local>("McpLocalConfig")({
  type: Schema.Literal("local").annotate({ description: "Type of MCP server connection" }),
  command: Schema.mutable(Schema.Array(Schema.String)).annotate({
    description: "Command and arguments to run the MCP server",
  }),
  environment: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Environment variables to set when running the MCP server",
  }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}) {
  static readonly zod = zod(this)
}

export class OAuth extends Schema.Class<OAuth>("McpOAuthConfig")({
  clientId: Schema.optional(Schema.String).annotate({
    description: "OAuth client ID. If not provided, dynamic client registration (RFC 7591) will be attempted.",
  }),
  clientSecret: Schema.optional(Schema.String).annotate({
    description: "OAuth client secret (if required by the authorization server)",
  }),
  scope: Schema.optional(Schema.String).annotate({ description: "OAuth scopes to request during authorization" }),
  redirectUri: Schema.optional(Schema.String).annotate({
    description: "OAuth redirect URI (default: http://127.0.0.1:19876/mcp/oauth/callback).",
  }),
}) {
  static readonly zod = zod(this)
}

export class Remote extends Schema.Class<Remote>("McpRemoteConfig")({
  type: Schema.Literal("remote").annotate({ description: "Type of MCP server connection" }),
  url: Schema.String.annotate({ description: "URL of the remote MCP server" }),
  enabled: Schema.optional(Schema.Boolean).annotate({
    description: "Enable or disable the MCP server on startup",
  }),
  headers: Schema.optional(Schema.Record(Schema.String, Schema.String)).annotate({
    description: "Headers to send with the request",
  }),
  oauth: Schema.optional(Schema.Union([OAuth, Schema.Literal(false)])).annotate({
    description: "OAuth authentication configuration for the MCP server. Set to false to disable OAuth auto-detection.",
  }),
  timeout: Schema.optional(Schema.Number).annotate({
    description: "Timeout in ms for MCP server requests. Defaults to 5000 (5 seconds) if not specified.",
  }),
}) {
  static readonly zod = zod(this)
}

export const Info = Schema.Union([Local, Remote])
  .annotate({ discriminator: "type" })
  .pipe(withStatics((s) => ({ zod: zod(s) })))
export type Info = Schema.Schema.Type<typeof Info>

export type Origin = {
  type: "opencode" | "claude"
  source: string
}

const remoteTypes = new Set(["http", "streamable-http", "remote"])
const localTypes = new Set(["stdio", "local"])
const sensitive = ["authorization", "token", "api_key", "apikey", "key", "secret", "password", "credential"]

function stringRecord(input: unknown) {
  if (!isRecord(input)) return undefined
  return Object.fromEntries(
    Object.entries(input).filter((entry): entry is [string, string] => typeof entry[1] === "string"),
  )
}

function isSensitive(input: string) {
  return sensitive.some((item) => input.toLowerCase().includes(item))
}

function oauth(input: unknown) {
  if (input === false) return false
  if (!isRecord(input)) return undefined
  const result = {
    ...(typeof input.clientId === "string" && { clientId: input.clientId }),
    ...(typeof input.clientSecret === "string" && { clientSecret: input.clientSecret }),
    ...(typeof input.scope === "string" && { scope: input.scope }),
    ...(typeof input.redirectUri === "string" && { redirectUri: input.redirectUri }),
  }
  return Object.keys(result).length > 0 ? result : undefined
}

export function fromClaude(name: string, input: unknown): { config: Info } | { warning: string } {
  if (!isRecord(input)) return { warning: `skipped Claude Code MCP server "${name}"; server config is not an object.` }

  if (input.type === "sse") {
    return { warning: `skipped Claude Code MCP server "${name}"; unsupported transport "sse".` }
  }

  if (input.args !== undefined && !Array.isArray(input.args)) {
    return { warning: `skipped Claude Code MCP server "${name}"; args is not an array.` }
  }

  const args = Array.isArray(input.args) ? input.args : []
  if (!args.every((item) => typeof item === "string")) {
    return { warning: `skipped Claude Code MCP server "${name}"; args must contain only strings.` }
  }

  const enabled = input.disabled === true ? false : input.enabled === false ? false : true
  const environment = stringRecord(input.environment) ?? stringRecord(input.env)
  const timeout = typeof input.timeout === "number" ? input.timeout : undefined
  const type = typeof input.type === "string" ? input.type : undefined

  if (typeof input.command === "string" && (!type || localTypes.has(type))) {
    return {
      config: {
        type: "local",
        command: [input.command, ...args],
        ...(environment && { environment }),
        enabled,
        ...(timeout !== undefined && { timeout }),
      },
    }
  }

  if (input.command !== undefined) {
    return { warning: `skipped Claude Code MCP server "${name}"; command is not a string.` }
  }

  if (typeof input.url === "string" && (!type || remoteTypes.has(type))) {
    const headers = stringRecord(input.headers)
    const oauthConfig = oauth(input.oauth)
    return {
      config: {
        type: "remote",
        url: input.url,
        enabled,
        ...(headers && { headers }),
        ...(oauthConfig !== undefined && { oauth: oauthConfig }),
        ...(timeout !== undefined && { timeout }),
      },
    }
  }

  if (input.url !== undefined) {
    return { warning: `skipped Claude Code MCP server "${name}"; url is not a string.` }
  }

  if (type && !localTypes.has(type) && !remoteTypes.has(type)) {
    return { warning: `skipped Claude Code MCP server "${name}"; unsupported transport "${type}".` }
  }

  return { warning: `skipped Claude Code MCP server "${name}"; missing command or url.` }
}

export function redactString(input: string) {
  return input
    .replace(/(Bearer\s+)[^\s]+/gi, "$1****")
    .replace(/([?&][^=\s&]*(?:authorization|token|api[_-]?key|apikey|key|secret|password|credential)[^=\s&]*=)[^&\s]+/gi, "$1****")
    .replace(/((?:authorization|token|api[_-]?key|apikey|key|secret|password|credential)=)[^\s]+/gi, "$1****")
}

export function redactCommand(command: string[]) {
  return command.map((item, index) => {
    if (index > 0 && isSensitive(command[index - 1])) return "****"
    return redactString(item)
  })
}

export * as ConfigMCP from "./mcp"
