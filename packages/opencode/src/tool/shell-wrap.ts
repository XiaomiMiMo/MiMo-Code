import { Cause, Effect } from "effect"
import z from "zod"
import * as Tool from "./tool"

export const shellInputSchema = z.object({
  script: z.string().min(1).describe(
    [
      "Multi-line shell-style script. Each non-blank line is one command; commands run sequentially and stop on first failure.",
      'Quoting: "..." preserves literal newlines and processes \\" \\\\ escapes; \'...\' is verbatim.',
      "<<EOF heredoc bodies are fully verbatim (no escape, no $vars).",
      "# starts a line comment to end-of-line (quoted # is literal).",
      "Variables ($VAR, ${VAR}) are preserved as literal text — no expansion.",
      "See the tool description for the verb table.",
    ].join(" "),
  ),
})

type ShellInput = z.infer<typeof shellInputSchema>

export function shellWrap<P extends z.ZodType, M extends Tool.Metadata>(
  def: Tool.Def<P, M>,
): Tool.Def<typeof shellInputSchema, Tool.Metadata> {
  if (!def.shell) {
    throw new Error(`shellWrap called on tool '${def.id}' that has no shell field`)
  }
  const shell = def.shell
  return {
    id: def.id,
    description: shell.description,
    parameters: shellInputSchema,
    execute: (args: ShellInput, ctx) =>
      Effect.gen(function* () {
        // Guard: a model in shell mode may emit a JSON-shape call (e.g.
        // {description, prompt, subagent_type}) with NO `script` field. Without
        // this, shell.parse(undefined) → tokenize's script.trim() throws a
        // minified TypeError. Return a structured, teaching error instead so the
        // model can self-correct on the next turn.
        if (typeof args.script !== "string" || args.script.trim() === "") {
          // Shell mode received no usable `script`. Try tool-specific recovery:
          // a model may emit the tool's JSON-shape args directly (e.g. actor's
          // Task-prior {description,prompt,subagent_type}). If recover lifts it to
          // the parsed shape, route to def.execute (which re-validates via zod).
          const recovered = shell.recover?.(args as unknown)
          if (recovered !== undefined) {
            const op = operationLabel(recovered)
            const exit = yield* Effect.exit(def.execute(recovered, ctx as Tool.Context))
            if (exit._tag === "Failure") {
              return {
                title: `${def.id}: invalid arguments`,
                output: formatFailedCommandNoVerb(jsonTeachingBody(def.id, describeFailure(exit.cause))),
                metadata: { commands: 0, success: 0 } as Tool.Metadata,
              }
            }
            // Success is silent — NO format hint. If JSON-shape works, let the
            // session keep using it (actor fails shell-syntax on first try).
            // Output is the tool's own (not wrapped in <command index=...>): a
            // recovered call is a single op, so the per-command envelope is noise.
            return {
              title: `${def.id}: ${op}`,
              output: exit.value.output,
              metadata: { ...(exit.value.metadata as Tool.Metadata), commands: 1, success: 1 } as Tool.Metadata,
            }
          }
          const o = (typeof args === "object" && args ? args : {}) as Record<string, unknown>
          const body = "script" in o ? shellTeachingBody(def.id) : jsonTeachingBody(def.id)
          return {
            title: `${def.id}: missing script`,
            output: formatFailedCommandNoVerb(body),
            metadata: { commands: 0, success: 0 } as Tool.Metadata,
          }
        }
        const parseExit = yield* Effect.exit(shell.parse(args.script))
        if (parseExit._tag === "Failure") {
          const err = Cause.squash(parseExit.cause)
          const body = formatParseError(def.id, err)
          return {
            title: `${def.id}: parse error`,
            output: formatFailedCommandNoVerb(body),
            metadata: { commands: 0, success: 0 } as Tool.Metadata,
          }
        }
        const parsedList = parseExit.value
        if (parsedList.length === 0) {
          return {
            title: `${def.id}: empty script`,
            output: formatFailedCommandNoVerb(`${def.id}: no commands found in script`),
            metadata: { commands: 0, success: 0 } as Tool.Metadata,
          }
        }
        const blocks: string[] = []
        let lastMetadata: Tool.Metadata = {}
        let success = 0
        for (let i = 0; i < parsedList.length; i++) {
          const parsed = parsedList[i]
          // Convention: every shell-style tool's parameters discriminator is named
          // `operation`. It may be a flat string (e.g. actor: `{ operation: "run" }`)
          // or a nested object whose own discriminator is `action` (e.g. task:
          // `{ operation: { action: "create" } }` — see the `.meta` comment in task.ts).
          // Derive a string label for the output XML attribute from either shape.
          const operation = operationLabel(parsed)
          const exit = yield* Effect.exit(def.execute(parsed, ctx as Tool.Context))
          if (exit._tag === "Failure") {
            blocks.push(formatFailedCommand(i + 1, operation, describeFailure(exit.cause)))
            if (i + 1 < parsedList.length) {
              blocks.push(`<not-executed>commands #${i + 2}..#${parsedList.length}</not-executed>`)
            }
            return {
              title: `${def.id}: command #${i + 1} failed`,
              output: blocks.join("\n"),
              metadata: { commands: parsedList.length, success } as Tool.Metadata,
            }
          }
          success++
          lastMetadata = exit.value.metadata as Tool.Metadata
          blocks.push(formatOkCommand(i + 1, operation, exit.value.output))
        }
        return {
          title: `${def.id}: ${parsedList.length} command(s)`,
          output: blocks.join("\n"),
          metadata: { ...lastMetadata, commands: parsedList.length, success } as Tool.Metadata,
        }
      }),
  }
}

function formatOkCommand(index: number, operation: string, body: string): string {
  return `<command index="${index}" operation="${escapeAttr(operation)}">\n${body}\n</command>`
}

function formatFailedCommand(index: number, operation: string, body: string): string {
  return `<command index="${index}" operation="${escapeAttr(operation)}" failed="true">\n${body}\n</command>`
}

// Derives the string label for the `operation` XML attribute from a parsed
// command, tolerating both discriminator shapes:
//   - flat:   { operation: "run" }                 → "run"
//   - nested: { operation: { action: "create" } }  → "create"
// Falls back to "?" so the attribute is never undefined / "[object Object]".
function operationLabel(parsed: unknown): string {
  const op = (parsed as { operation?: unknown } | null | undefined)?.operation
  if (typeof op === "string") return op
  if (op && typeof op === "object" && typeof (op as { action?: unknown }).action === "string") {
    return (op as { action: string }).action
  }
  return "?"
}

function escapeAttr(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
}

function describeFailure(cause: Cause.Cause<unknown>): string {
  const squashed = Cause.squash(cause)
  if (squashed instanceof Error) return squashed.message
  return String(squashed)
}

function formatFailedCommandNoVerb(body: string): string {
  return `<command failed="true">\n${body}\n</command>`
}

function shellTeachingBody(toolId: string): string {
  return [
    `${toolId}: this tool takes a single \`script\` string (shell-style), not JSON fields.`,
    `Put the command in \`script\`, e.g.:  ${toolId} <verb> ...`,
    `See the tool description for the verb list and examples.`,
  ].join("\n")
}

function jsonTeachingBody(toolId: string, detail?: string): string {
  return [
    `${toolId}: could not run the call.`,
    `Pass the operation as JSON, e.g.:  {"operation":{"action":"<verb>", ...}}`,
    ...(detail ? [`detail: ${detail}`] : []),
  ].join("\n")
}

function formatParseError(toolId: string, err: unknown): string {
  if (err && typeof err === "object" && "kind" in err) {
    const e = err as { kind: string; line?: number; detail?: string }
    const line = e.line ?? "?"
    return `${toolId}: parse error at line ${line}\n  ${e.detail ?? e.kind}`
  }
  if (err instanceof Error) return `${toolId}: parse error\n  ${err.message}`
  return `${toolId}: parse error\n  ${String(err)}`
}
