import * as Tool from "./tool"
import DESCRIPTION from "./session.txt"
import SHELL_DESCRIPTION from "./session.shell.txt"
import { tokenize } from "./shell-tokenize"
import z from "zod"
import { Effect } from "effect"
import { Session } from "@/session"
import { SessionPrompt } from "@/session/prompt"
import { ActorRegistry } from "@/actor/registry"
import { spawnRef } from "@/actor/spawn-ref"
import { Bus } from "@/bus"
import { TuiEvent } from "@/cli/cmd/tui/event"
import type { SessionID } from "../session/schema"

const KNOWN_VERBS = ["create", "switch", "list", "cancel"]

function levenshtein(a: string, b: string): number {
  const m = a.length, n = b.length
  if (m === 0) return n
  if (n === 0) return m
  const dp = Array.from({ length: m + 1 }, () => new Array(n + 1).fill(0))
  for (let i = 0; i <= m; i++) dp[i][0] = i
  for (let j = 0; j <= n; j++) dp[0][j] = j
  for (let i = 1; i <= m; i++) {
    for (let j = 1; j <= n; j++) {
      const cost = a[i - 1] === b[j - 1] ? 0 : 1
      dp[i][j] = Math.min(dp[i - 1][j] + 1, dp[i][j - 1] + 1, dp[i - 1][j - 1] + cost)
    }
  }
  return dp[m][n]
}

function suggestVerb(input: string): string | undefined {
  const candidates = KNOWN_VERBS.map((v) => ({ v, d: levenshtein(input, v) })).filter((c) => c.d <= 2)
  if (candidates.length !== 1) return undefined
  return candidates[0].v
}

const id = "session"

const createOperation = z.strictObject({
  action: z.literal("create"),
  task: z.string().min(1).describe("The task/prompt for the child session's first turn."),
  mode: z.enum(["build", "compose"]).optional().describe("Agent mode for the child session. Default build."),
  model: z.string().min(1).optional().describe("Model group/tier name or literal provider/model for the child."),
  title: z.string().min(1).optional().describe("Title for the child session. Defaults to the task prefix."),
})

const switchOperation = z.strictObject({
  action: z.literal("switch"),
  sessionID: z.string().min(1).describe("Session id to move the user's frontend panel to."),
})

const listOperation = z.strictObject({
  action: z.literal("list"),
})

const cancelOperation = z.strictObject({
  action: z.literal("cancel"),
  sessionID: z.string().min(1).describe("Session id of the child session to stop."),
})

const parameters = z.strictObject({
  // .meta({ type: "object" }) is REQUIRED — without it, the emitted JSON
  // schema's `operation` node has only `anyOf`, no `type`. Some models
  // (notably mimo-v2.5-pro) then stringify the entire envelope, producing
  // {"operation":"{\"action\":\"create\",...}"} which fails zod validation.
  // See research-tool-call-schema/REPORT.md §2.5 "success-nested" warning.
  operation: z
    .discriminatedUnion("action", [createOperation, switchOperation, listOperation, cancelOperation])
    .meta({ type: "object" }),
})

type SessionInput = z.infer<typeof parameters>
type SessionOperation = SessionInput

type Metadata = {
  sessionID?: string
}

type Deps = Session.Service | SessionPrompt.Service | ActorRegistry.Service | Bus.Service

function parseSessionScript(script: string): Effect.Effect<SessionOperation[], unknown> {
  return Effect.gen(function* () {
    const argvList = yield* tokenize(script)
    const out: SessionOperation[] = []
    for (const argv of argvList) {
      const [head, verb, ...rest] = argv.tokens
      if (head !== "session") {
        return yield* Effect.fail({
          kind: "unknown-verb",
          line: argv.line,
          detail: `session: every command must start with 'session' (got '${head ?? ""}')`,
        })
      }
      const parsed = yield* mapVerb(verb, rest, argv.line)
      out.push(parsed)
    }
    return out
  })
}

// Extract a fixed set of `--name value` / `--name=value` string flags from a
// verb's args, leaving positionals in `rest`. A value flag with no value
// (`--mode` at end, or `--mode=`) sets `error` rather than silently dropping —
// so a dangling flag never swallows a positional into a confusing arity error.
function extractSessionFlags(
  args: string[],
  valueFlags: string[],
): { flags: Record<string, string>; rest: string[]; error?: string } {
  const rest: string[] = []
  const flags: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const a = args[i]
    const valName = valueFlags.find((n) => a === `--${n}`)
    if (valName) {
      const next = args[i + 1]
      if (next === undefined) return { flags, rest, error: `--${valName} requires a value` }
      flags[valName] = next
      i++
      continue
    }
    const eq = valueFlags.find((n) => a.startsWith(`--${n}=`))
    if (eq) {
      const v = a.slice(`--${eq}=`.length)
      if (v === "") return { flags, rest, error: `--${eq} requires a value` }
      flags[eq] = v
      continue
    }
    rest.push(a)
  }
  return { flags, rest }
}

function flagError(verb: string, detail: string, line: number) {
  return Effect.fail({ kind: "flag", line, detail: `session: ${verb}: ${detail}` })
}

function arityError(verb: string, expected: string, args: string[], line: number) {
  return Effect.fail({
    kind: "arity",
    line,
    detail: `session: ${verb}: arity mismatch\n  got:      session ${verb} ${args.join(" ")}\n  expected: session ${verb} ${expected}`,
  })
}

function mapVerb(verb: string | undefined, args: string[], line: number): Effect.Effect<SessionOperation, unknown> {
  switch (verb) {
    case "create": {
      const { flags, rest, error } = extractSessionFlags(args, ["mode", "model", "title"])
      if (error) return flagError("create", error, line)
      if (rest.length < 1) return arityError("create", "<task...> [--mode build|compose] [--model <ref>] [--title <t>]", rest, line)
      if (flags.mode && flags.mode !== "build" && flags.mode !== "compose")
        return flagError("create", `--mode must be build or compose (got '${flags.mode}')`, line)
      return Effect.succeed({
        operation: {
          action: "create" as const,
          task: rest.join(" "),
          ...(flags.mode ? { mode: flags.mode as "build" | "compose" } : {}),
          ...(flags.model ? { model: flags.model } : {}),
          ...(flags.title ? { title: flags.title } : {}),
        },
      })
    }
    case "switch": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("switch", error, line)
      if (rest.length !== 1) return arityError("switch", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "switch" as const, sessionID: rest[0] } })
    }
    case "list": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("list", error, line)
      if (rest.length !== 0) return arityError("list", "", rest, line)
      return Effect.succeed({ operation: { action: "list" as const } })
    }
    case "cancel": {
      const { rest, error } = extractSessionFlags(args, [])
      if (error) return flagError("cancel", error, line)
      if (rest.length !== 1) return arityError("cancel", "<sessionID>", rest, line)
      return Effect.succeed({ operation: { action: "cancel" as const, sessionID: rest[0] } })
    }
    default: {
      const suggestion = suggestVerb(verb ?? "")
      const detail =
        `session: unknown verb "${verb ?? ""}"\n` +
        `  available verbs: ${KNOWN_VERBS.join(", ")}` +
        (suggestion ? `\n  did you mean: ${suggestion}?` : "")
      return Effect.fail({ kind: "unknown-verb", line, detail })
    }
  }
}

export const SessionTool = Tool.define<typeof parameters, Metadata, Deps>(
  id,
  Effect.gen(function* () {
    const sessions = yield* Session.Service
    const prompt = yield* SessionPrompt.Service
    const actorReg = yield* ActorRegistry.Service
    const bus = yield* Bus.Service

    // Resolve the Actor service through the late-bound spawnRef rather than as a
    // Layer dependency: pulling Actor.Service into Deps would create a layer
    // cycle (Actor → SessionPrompt → ToolRegistry → tool/session → Actor) that
    // Effect cannot satisfy. The ref is populated by Actor.layer's initialiser
    // (see actor/spawn-ref.ts). Same pattern as tool/actor.ts.
    const requireActor = () =>
      spawnRef.current
        ? Effect.succeed(spawnRef.current)
        : Effect.fail(
            new Error(
              "Actor service unavailable — Actor.defaultLayer must be running for session cancel",
            ),
          )

    const run = Effect.fn("SessionTool.execute")(function* (input: SessionInput, ctx: Tool.Context<Metadata>) {
      const op = input.operation

      if (op.action === "create") {
        const title = op.title ?? op.task.slice(0, 40)
        const child = yield* sessions.create({
          parentID: ctx.sessionID as SessionID,
          title,
        })
        yield* actorReg.register({
          sessionID: child.id,
          actorID: child.id,
          mode: "peer",
          parentActorID: ctx.actorID,
          agent: op.mode ?? "build",
          description: title,
          contextMode: "none",
          contextWatermark: undefined,
          background: true,
          lifecycle: "persistent",
          tools: "INHERIT",
        })
        // Background fork — the child's first turn must outlive this tool call.
        // spawnPeer uses Effect.forkIn(its long-lived Actor scope); the session
        // tool has no such scope, so forkDetach (attached to the global scope, so
        // it keeps running after this tool's fiber terminates) is the equivalent
        // fire-and-forget primitive. (effect 4 beta has no `forkDaemon`.)
        yield* prompt
          .prompt({
            sessionID: child.id,
            agent: op.mode ?? "build",
            ...(op.model ? { modelRef: op.model } : {}),
            parts: [{ type: "text", text: op.task }],
          })
          .pipe(Effect.forkDetach)
        return {
          title: `Session created: ${child.id}`,
          output: `Created child session ${child.id} (mode: ${op.mode ?? "build"}). Running in the background.`,
          metadata: { sessionID: child.id } as Metadata,
        }
      }

      if (op.action === "switch") {
        yield* bus.publish(TuiEvent.SessionSelect, { sessionID: op.sessionID as SessionID })
        return {
          title: `Switched to ${op.sessionID}`,
          output: `Requested the UI navigate to session ${op.sessionID}.`,
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      if (op.action === "list") {
        // Peers register with session_id === their own child.id (see
        // Actor.spawnPeer / the create branch above), so listByParent —
        // which filters on session_id === orchestrator id — never matches
        // them. The reliable parent link is the Session row's parentID, set
        // to ctx.sessionID at create time. Enrich each child with its actor
        // row (mode/agent/status) keyed by sessionID === actorID === child.id.
        const children = yield* sessions.children(ctx.sessionID as SessionID)
        if (children.length === 0)
          return { title: "Child sessions: 0", output: "No child sessions.", metadata: {} as Metadata }
        const lines = yield* Effect.forEach(children, (child) =>
          actorReg.get(child.id, child.id).pipe(
            Effect.map((actor) =>
              `${child.id} — ${child.title} — ${actor?.agent ?? "?"} — ${actor?.status ?? "unknown"}`,
            ),
          ),
        )
        return { title: `Child sessions: ${children.length}`, output: lines.join("\n"), metadata: {} as Metadata }
      }

      if (op.action === "cancel") {
        const actor = yield* requireActor()
        yield* actor.cancel(op.sessionID as SessionID, op.sessionID, "graceful")
        return {
          title: `Cancelled ${op.sessionID}`,
          output: `Requested cancellation of session ${op.sessionID}.`,
          metadata: { sessionID: op.sessionID } as Metadata,
        }
      }

      // Exhaustive: every action in the discriminated union is handled above,
      // so `op` is `never` here. This guards against a future verb being added
      // to the union without a matching branch.
      return yield* Effect.fail(new Error(`session: unhandled verb ${JSON.stringify(op)}`))
    })

    return {
      description: DESCRIPTION,
      parameters,
      execute: (args: z.infer<typeof parameters>, ctx: Tool.Context<Metadata>) => run(args, ctx).pipe(Effect.orDie),
      shell: {
        description: SHELL_DESCRIPTION,
        parse: parseSessionScript,
      },
    } satisfies Tool.DefWithoutID<typeof parameters, Metadata>
  }),
)
