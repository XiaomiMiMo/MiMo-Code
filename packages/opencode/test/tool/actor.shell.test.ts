import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { parseActorScript } from "../../src/tool/actor"

// parseActorScript is a pure string-to-args mapper with no service dependencies.
// Run effects synchronously via Effect.runSync or runPromise with no layer needed.
async function parse(script: string) {
  return Effect.runPromise(parseActorScript(script))
}

describe("actor.shell.parse: spawn variants", () => {
  test("run (sync, block until done)", async () => {
    const out = await parse('actor run explore "Find recovery" "scan parser.ts"')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "Find recovery", prompt: "scan parser.ts" } },
    ])
  })

  test("spawn (async, return actor_id immediately)", async () => {
    const out = await parse('actor spawn general "Long task" "do stuff"')
    expect(out).toEqual([
      { operation: { action: "spawn", subagent_type: "general", description: "Long task", prompt: "do stuff" } },
    ])
  })

  test("run with heredoc prompt preserves verbatim multi-line content", async () => {
    const script = [
      `actor run general "Review" <<EOF`,
      `Read docs/spec.md §3.`,
      `Report: missing items + "quote-friendly" content.`,
      `Path: C:\\Users — backslash literal.`,
      `Var $foo stays.`,
      `EOF`,
    ].join("\n")
    const out = await parse(script)
    const cmd = out[0] as { operation: { action: string; prompt: string } }
    expect(cmd.operation.action).toBe("run")
    expect(cmd.operation.prompt).toContain("Read docs/spec.md §3.")
    expect(cmd.operation.prompt).toContain("\"quote-friendly\"")
    expect(cmd.operation.prompt).toContain("C:\\Users")
    expect(cmd.operation.prompt).toContain("$foo")
  })

  test("run with quoted heredoc delimiter <<'PROMPT' parses (original parse-error repro)", async () => {
    const script = [
      `actor run general "Implement Task 1" <<'PROMPT'`,
      `Add submodule fields to workspace_repos.`,
      `Columns: parent_workspace_repo_id, submodule_path.`,
      `PROMPT`,
    ].join("\n")
    const out = await parse(script)
    const cmd = out[0] as { operation: { action: string; subagent_type: string; prompt: string } }
    expect(cmd.operation.action).toBe("run")
    expect(cmd.operation.subagent_type).toBe("general")
    expect(cmd.operation.prompt).toBe(
      "Add submodule fields to workspace_repos.\nColumns: parent_workspace_repo_id, submodule_path.",
    )
  })
})

describe("actor.shell.parse: --model flag", () => {
  test("run with --model <ref> (space form)", async () => {
    const out = await parse('actor run explore "Find recovery" "scan parser.ts" --model lite')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "Find recovery", prompt: "scan parser.ts", model: "lite" } },
    ])
  })

  test("spawn with --model=<ref> (equals form, literal provider/model)", async () => {
    const out = await parse('actor spawn general "Long task" "do stuff" --model=anthropic/claude-opus-4-8')
    expect(out).toEqual([
      { operation: { action: "spawn", subagent_type: "general", description: "Long task", prompt: "do stuff", model: "anthropic/claude-opus-4-8" } },
    ])
  })

  test("flag before positionals still parses (scan is position-independent)", async () => {
    const out = await parse('actor run --model lite explore "d" "p"')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", model: "lite" } },
    ])
  })

  test("--model with no value fails with kind: flag", async () => {
    const exit = await Effect.runPromise(Effect.exit(parseActorScript('actor run explore "d" "p" --model')))
    expect(exit._tag).toBe("Failure")
    const cause: any = (exit as any).cause
    const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
    const err = fail.error ?? fail
    expect(err.kind).toBe("flag")
    expect(err.detail).toContain("--model requires a value")
  })

  test("no flag, 3 args still parses (arity unchanged)", async () => {
    const out = await parse('actor run explore "d" "p"')
    expect(out).toEqual([{ operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p" } }])
  })

  test("run with --task <TID> maps to task_id", async () => {
    const out = await parse('actor run explore "d" "p" --task T1')
    expect(out).toEqual([{ operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", task_id: "T1" } }])
  })

  test("spawn with both --model and --task", async () => {
    const out = await parse('actor spawn general "d" "p" --model lite --task T2.1')
    expect(out).toEqual([
      { operation: { action: "spawn", subagent_type: "general", description: "d", prompt: "p", model: "lite", task_id: "T2.1" } },
    ])
  })

  test("--task=<TID> equals form", async () => {
    const out = await parse('actor run explore "d" "p" --task=T3')
    expect(out).toEqual([{ operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", task_id: "T3" } }])
  })
})

describe("actor.shell.parse: lifecycle", () => {
  test.each([
    ["status", "status"],
    ["wait", "wait"],
    ["cancel", "cancel"],
  ] as const)("%s by actor_id", async (verb, action) => {
    const out = await parse(`actor ${verb} sess_xxx`)
    expect(out).toEqual([{ operation: { action, actor_id: "sess_xxx" } }] as typeof out)
  })

  test("wait with --timeout maps to timeout_ms", async () => {
    const out = await parse("actor wait explore-1 --timeout 60000")
    expect(out).toEqual([{ operation: { action: "wait", actor_id: "explore-1", timeout_ms: 60000 } }])
  })

  test("wait without --timeout still parses", async () => {
    const out = await parse("actor wait explore-1")
    expect(out).toEqual([{ operation: { action: "wait", actor_id: "explore-1" } }])
  })
})

describe("actor.shell.parse: dispatch errors", () => {
  test("unknown verb suggests close match", async () => {
    const exit = await Effect.runPromise(Effect.exit(parseActorScript("actor spwn explore \"x\" \"y\"")))
    expect(exit._tag).toBe("Failure")
    const cause: any = (exit as any).cause
    const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
    const err = fail.error ?? fail
    expect(err.kind).toBe("unknown-verb")
    expect(err.detail).toContain("did you mean: spawn")
  })

  test("run with wrong arity reports got/expected", async () => {
    const exit = await Effect.runPromise(Effect.exit(parseActorScript("actor run explore")))
    expect(exit._tag).toBe("Failure")
    const cause: any = (exit as any).cause
    const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
    const err = fail.error ?? fail
    expect(err.kind).toBe("arity")
    expect(err.detail).toContain("subagent_type")
  })

  test("multi-command parses two spawn calls", async () => {
    const out = await parse([
      `actor spawn explore "Q1" "search X"`,
      `actor spawn explore "Q2" "search Y"`,
    ].join("\n"))
    expect(out).toHaveLength(2)
    expect((out[0].operation as { action: string }).action).toBe("spawn")
    expect((out[1].operation as { action: string }).action).toBe("spawn")
  })
})

describe("actor.shell.parse: send", () => {
  test("basic send (to_actor_id + content)", async () => {
    const out = await parse('actor send explore-1 "ping"')
    expect(out).toEqual([{ operation: { action: "send", to_actor_id: "explore-1", content: "ping" } }])
  })

  test("send with --session and --type flags", async () => {
    const out = await parse('actor send main "status?" --session ses_abc --type actor_notification')
    expect(out).toEqual([
      { operation: { action: "send", to_actor_id: "main", content: "status?", to_session_id: "ses_abc", type: "actor_notification" } },
    ])
  })

  test("send with --session=<id> equals form", async () => {
    const out = await parse('actor send explore-2 "hi" --session=ses_xyz')
    expect(out).toEqual([{ operation: { action: "send", to_actor_id: "explore-2", content: "hi", to_session_id: "ses_xyz" } }])
  })

  test("flags before positionals still parse", async () => {
    const out = await parse('actor send --type text main "go"')
    expect(out).toEqual([{ operation: { action: "send", to_actor_id: "main", content: "go", type: "text" } }])
  })

  test("send with wrong arity reports got/expected", async () => {
    const exit = await Effect.runPromise(Effect.exit(parseActorScript("actor send main")))
    expect(exit._tag).toBe("Failure")
    const cause: any = (exit as any).cause
    const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail") ?? cause
    const err = fail.error ?? fail
    expect(err.kind).toBe("arity")
    expect(err.detail).toContain("to_actor_id")
  })
})

describe("actor.shell.parse: full parity flags", () => {
  test("run with --actor (resume) maps to actor_id", async () => {
    const out = await parse('actor run explore "d" "p" --actor explore-1')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", actor_id: "explore-1" } },
    ])
  })

  test("run with --timeout maps to timeout_ms (number)", async () => {
    const out = await parse('actor run explore "d" "p" --timeout 30000')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", timeout_ms: 30000 } },
    ])
  })

  test("run with --context (enum)", async () => {
    const out = await parse('actor run explore "d" "p" --context full')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", context: "full" } },
    ])
  })

  test("run with --command", async () => {
    const out = await parse('actor run explore "d" "p" --command "/review"')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", command: "/review" } },
    ])
  })

  test("run with --output-schema parses the JSON string into an object", async () => {
    const out = await parse(`actor run explore "d" "p" --output-schema '{"type":"object"}'`)
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", output_schema: { type: "object" } } },
    ])
  })

  test("spawn with --actor and --command (no timeout on spawn)", async () => {
    const out = await parse('actor spawn general "d" "p" --actor general-2 --command "/bg"')
    expect(out).toEqual([
      { operation: { action: "spawn", subagent_type: "general", description: "d", prompt: "p", actor_id: "general-2", command: "/bg" } },
    ])
  })

  test("multiple flags combine on run", async () => {
    const out = await parse('actor run explore "d" "p" --model lite --context state --timeout 5000')
    expect(out).toEqual([
      { operation: { action: "run", subagent_type: "explore", description: "d", prompt: "p", model: "lite", context: "state", timeout_ms: 5000 } },
    ])
  })

  // Negative paths for the two conversions the parser does NOT guard (it stays
  // dumb; validation is deferred to the zod schema at execute — except output-schema
  // which JSON.parses inline and so fails at PARSE time).
  test("malformed --output-schema fails at parse time (JSON.parse throws → parse error)", async () => {
    const exit = await Effect.runPromise(Effect.exit(parseActorScript(`actor run explore "d" "p" --output-schema '{not json}'`)))
    expect(exit._tag).toBe("Failure")
  })

  test("non-numeric --timeout parses to NaN (parser stays dumb; zod .int().positive() rejects at execute)", async () => {
    const out = await parse('actor run explore "d" "p" --timeout abc')
    const op = (out[0] as { operation: { timeout_ms?: number } }).operation
    expect(Number.isNaN(op.timeout_ms)).toBe(true)
  })
})
