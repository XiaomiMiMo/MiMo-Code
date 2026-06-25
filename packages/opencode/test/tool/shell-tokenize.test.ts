import { describe, test, expect } from "bun:test"
import { Effect } from "effect"
import { tokenize, type Argv, type ParseError } from "../../src/tool/shell-tokenize"

async function tokenizeOk(script: string): Promise<Argv[]> {
  const exit = await Effect.runPromise(Effect.exit(tokenize(script)))
  if (exit._tag === "Failure") throw new Error(`expected success: ${JSON.stringify(exit.cause)}`)
  return exit.value
}

async function tokenizeErr(script: string): Promise<ParseError> {
  const exit = await Effect.runPromise(Effect.exit(tokenize(script)))
  if (exit._tag !== "Failure") throw new Error("expected failure, got success")
  const cause: any = exit.cause
  const fail = cause.reasons?.find?.((r: any) => r._tag === "Fail")
  if (!fail) throw new Error(`no Fail reason in cause: ${JSON.stringify(cause)}`)
  return fail.error as ParseError
}

describe("shell-tokenize: basic", () => {
  test("verb plus positional, no quoting", async () => {
    const out = await tokenizeOk("task create T1")
    expect(out).toEqual([{ line: 1, tokens: ["task", "create", "T1"] }])
  })

  test("blank input produces no commands", async () => {
    const out = await tokenizeOk("")
    expect(out).toEqual([])
  })
})

describe("shell-tokenize: quoting", () => {
  test("double-quoted string preserves spaces", async () => {
    const out = await tokenizeOk('task create "hello world"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "create", "hello world"] }])
  })

  test("double-quoted string preserves literal newlines", async () => {
    const out = await tokenizeOk('task revise T1 "line1\nline2"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "revise", "T1", "line1\nline2"] }])
  })

  test("single-quoted string preserves verbatim", async () => {
    const out = await tokenizeOk(`task echo 'a"b c'`)
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", `a"b c`] }])
  })
})

describe("shell-tokenize: multi-command", () => {
  test("two commands separated by newline", async () => {
    const out = await tokenizeOk('task create "a"\ntask create "b"')
    expect(out).toEqual([
      { line: 1, tokens: ["task", "create", "a"] },
      { line: 2, tokens: ["task", "create", "b"] },
    ])
  })

  test("blank lines are skipped, line numbers preserved", async () => {
    const out = await tokenizeOk('\n\ntask list\n\ntask get T1\n')
    expect(out).toEqual([
      { line: 3, tokens: ["task", "list"] },
      { line: 5, tokens: ["task", "get", "T1"] },
    ])
  })

  test("command containing quoted multi-line still spans lines correctly", async () => {
    const out = await tokenizeOk('task list\ntask revise T1 "line1\nline2"\ntask get T1')
    expect(out).toEqual([
      { line: 1, tokens: ["task", "list"] },
      { line: 2, tokens: ["task", "revise", "T1", "line1\nline2"] },
      { line: 4, tokens: ["task", "get", "T1"] },
    ])
  })

  test("backslash-newline continuation joins to one command, line is the start", async () => {
    // task create T1 followed by line continuation, second physical line continues the same command
    const out = await tokenizeOk('task create \\\nT1\ntask list')
    // Two commands: line 1 (spans physical lines 1-2 via continuation), line 3 (task list)
    expect(out).toEqual([
      { line: 1, tokens: ["task", "create", "T1"] },
      { line: 3, tokens: ["task", "list"] },
    ])
  })
})

describe("shell-tokenize: variables", () => {
  test("$varname inside double quotes is preserved literally", async () => {
    const out = await tokenizeOk('task echo "use $myvar here"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "use $myvar here"] }])
  })

  test("${name} brace form normalized to $name", async () => {
    const out = await tokenizeOk('task echo "code ${name}"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "code $name"] }])
  })

  test("$ alone (no name following) is preserved", async () => {
    const out = await tokenizeOk('task echo "amount $5"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "amount $5"] }])
  })

  test("escaped \\$ produces literal $", async () => {
    const out = await tokenizeOk('task echo "literal \\$ here"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "literal $ here"] }])
  })

  test("single quotes preserve $ verbatim", async () => {
    const out = await tokenizeOk("task echo '$varname stays'")
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "$varname stays"] }])
  })
})

describe("shell-tokenize: errors", () => {
  test("pipe operator rejected", async () => {
    const err = await tokenizeErr("task list | head -1")
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain("|")
  })

  test("redirect operator rejected", async () => {
    const err = await tokenizeErr("task list > out.txt")
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain(">")
  })

  test("semicolon rejected as separator (only newlines separate commands)", async () => {
    const err = await tokenizeErr('task create "a"; task create "b"')
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain(";")
  })

  test("unclosed double quote", async () => {
    const err = await tokenizeErr('task create "unterminated')
    expect(err.kind).toBe("unclosed-quote")
    expect(err.line).toBe(1)
  })

  test("herestring (<<<) rejected", async () => {
    const err = await tokenizeErr("task list <<< foo")
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain("<<<")
  })

  test("subshell open paren rejected", async () => {
    const err = await tokenizeErr("(task list)")
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain("(")
  })

  test("glob pattern rejected", async () => {
    const err = await tokenizeErr("task create *.ts")
    expect(err.kind).toBe("unsupported-operator")
    expect(err.detail).toContain("*.ts")
  })
})

describe("shell-tokenize: POSIX # comment handling", () => {
  test("after-command comment dropped", async () => {
    const out = await tokenizeOk("task list # debug")
    expect(out).toEqual([{ line: 1, tokens: ["task", "list"] }])
  })

  test("whole-line comment dropped", async () => {
    const out = await tokenizeOk("# title\ntask list")
    expect(out).toEqual([{ line: 2, tokens: ["task", "list"] }])
  })

  test("mid-token # is literal", async () => {
    const out = await tokenizeOk("task create issue#123 fix")
    expect(out).toEqual([{ line: 1, tokens: ["task", "create", "issue#123", "fix"] }])
  })

  test("# inside double quotes is literal", async () => {
    const out = await tokenizeOk('task create "value with # hash"')
    expect(out).toEqual([{ line: 1, tokens: ["task", "create", "value with # hash"] }])
  })

  test("# inside single quotes is literal", async () => {
    const out = await tokenizeOk("task create 'value with # hash'")
    expect(out).toEqual([{ line: 1, tokens: ["task", "create", "value with # hash"] }])
  })

  test("markdown headings in double-quoted body are preserved", async () => {
    const out = await tokenizeOk('actor run general "review" "# Heading\n## Sub\nbody"')
    expect(out[0].tokens.at(-1)).toBe("# Heading\n## Sub\nbody")
  })

  test("markdown headings in heredoc body are preserved", async () => {
    const script = [
      "task revise T1 body <<EOF",
      "# Heading",
      "## Sub",
      "body line",
      "EOF",
    ].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("# Heading\n## Sub\nbody line")
  })

  test("escaped \\# is literal #", async () => {
    const out = await tokenizeOk("task list \\# escaped")
    expect(out).toEqual([{ line: 1, tokens: ["task", "list", "#", "escaped"] }])
  })
})

describe("shell-tokenize: heredoc", () => {
  test("simple heredoc body becomes last token verbatim", async () => {
    const script = ["task revise T1 <<EOF", "line 1", "line 2", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out).toEqual([{ line: 1, tokens: ["task", "revise", "T1", "line 1\nline 2"] }])
  })

  test("heredoc body preserves quotes, escapes, dollars verbatim", async () => {
    const script = [
      `task revise T1 <<EOF`,
      `He said "hello" and 'hi'`,
      `Path: C:\\Users`,
      `Var: $foo, escape: \\n`,
      `EOF`,
    ].join("\n")
    const out = await tokenizeOk(script)
    const last = out[0].tokens.at(-1)
    expect(last).toBe(`He said "hello" and 'hi'\nPath: C:\\Users\nVar: $foo, escape: \\n`)
  })

  test("multiple heredocs in same script", async () => {
    const script = [
      `task create "first" <<A`,
      `body A`,
      `A`,
      `task create "second" <<B`,
      `body B line 1`,
      `body B line 2`,
      `B`,
    ].join("\n")
    const out = await tokenizeOk(script)
    expect(out).toEqual([
      { line: 1, tokens: ["task", "create", "first", "body A"] },
      { line: 4, tokens: ["task", "create", "second", "body B line 1\nbody B line 2"] },
    ])
  })

  test("unclosed heredoc reports error with line where it opened", async () => {
    const script = ["task revise T1 <<EOF", "body line 1", "body line 2"].join("\n")
    const err = await tokenizeErr(script)
    expect(err.kind).toBe("unclosed-heredoc")
    expect(err.line).toBe(1)
    expect(err.detail).toContain("EOF")
  })

  test("<<MARKER inside double-quoted string is literal, not heredoc", async () => {
    const out = await tokenizeOk(`task echo "<<EOF should be literal"`)
    expect(out).toEqual([{ line: 1, tokens: ["task", "echo", "<<EOF should be literal"] }])
  })

  test("body line that equals marker after trim closes heredoc (not body content)", async () => {
    const script = ["task revise T1 <<DONE", "  some body  ", "DONE"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("  some body  ")
  })

  test("non-whitespace after <<MARKER on the same line is unsupported", async () => {
    const script = ["task echo <<EOF extra", "body", "EOF"].join("\n")
    const err = await tokenizeErr(script)
    expect(err.kind).toBe("unsupported-operator")
  })

  test("heredoc body is empty if marker is on the very next line", async () => {
    const script = ["task revise T1 <<EOF", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("")
  })

  test("single-quoted delimiter <<'EOF' parses, body verbatim", async () => {
    const script = ["task revise T1 <<'EOF'", "line 1", "$x and 'quotes'", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out).toEqual([{ line: 1, tokens: ["task", "revise", "T1", "line 1\n$x and 'quotes'"] }])
  })

  test('double-quoted delimiter <<"EOF" parses', async () => {
    const script = ['task revise T1 <<"EOF"', "body", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("body")
  })

  test("<<-EOF dash form parses", async () => {
    const script = ["task revise T1 <<-EOF", "body", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("body")
  })

  test("<< EOF leading whitespace before marker parses", async () => {
    const script = ["task revise T1 << EOF", "body", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("body")
  })

  test("combined <<-'EOF' parses", async () => {
    const script = ["task revise T1 <<-'EOF'", "body", "EOF"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("body")
  })

  test("closing marker matches the bare name even when the delimiter was quoted", async () => {
    const script = ["task revise T1 <<'END'", "keep 'END' inside", "END"].join("\n")
    const out = await tokenizeOk(script)
    expect(out[0].tokens.at(-1)).toBe("keep 'END' inside")
  })
})
