import { describe, test, expect } from "bun:test"
import {
  clean,
  createPipeline,
  defaultPlugins,
  progressPlugin,
  ansiPlugin,
  redactPlugin,
  longLinePlugin,
  type CleanPlugin,
} from "../../src/tool/bash_token_efficient_pipeline"

describe("progressPlugin", () => {
  test("no \\r is a no-op", () => {
    const text = "line 1\nline 2\nline 3"
    expect(progressPlugin().apply(text, {})).toBe(text)
  })

  test("keeps only the last frame after \\r redraws", () => {
    const text = "10%\r25%\r50%\r100%"
    expect(progressPlugin().apply(text, {})).toBe("100%")
  })

  test("strips trailing \\r (CRLF tail)", () => {
    const text = "hello\r"
    expect(progressPlugin().apply(text, {})).toBe("hello")
  })

  test("folds each line independently", () => {
    const text = "first\rFIRST\nsecond\rSECOND"
    expect(progressPlugin().apply(text, {})).toBe("FIRST\nSECOND")
  })

  test("preserves lines without \\r in a mixed body", () => {
    const text = "intact line\nold\rNEW\nanother intact"
    expect(progressPlugin().apply(text, {})).toBe("intact line\nNEW\nanother intact")
  })
})

describe("ansiPlugin", () => {
  test("strips CSI color sequences", () => {
    const text = "\x1b[31merror\x1b[0m message"
    expect(ansiPlugin().apply(text, {})).toBe("error message")
  })

  test("strips OSC hyperlinks (BEL terminated)", () => {
    const text = "before \x1b]8;;https://example.com\x07link\x1b]8;;\x07 after"
    expect(ansiPlugin().apply(text, {})).toBe("before link after")
  })

  test("strips DCS sequences spanning multiple chars", () => {
    const text = "before\x1bPpayload here\x1b\\after"
    expect(ansiPlugin().apply(text, {})).toBe("beforeafter")
  })

  test("collapses backspace overstrike iteratively", () => {
    expect(ansiPlugin().apply("ab\b\bcd", {})).toBe("cd")
  })

  test("removes other control bytes but preserves \\t \\n \\r", () => {
    const text = "tab\there\x00\x07\nnext\rline"
    expect(ansiPlugin().apply(text, {})).toBe("tab\there\nnext\rline")
  })

  test("clean text passes through unchanged", () => {
    const text = "plain ascii output\nwith newlines"
    expect(ansiPlugin().apply(text, {})).toBe(text)
  })
})

describe("redactPlugin", () => {
  test("masks Bearer tokens", () => {
    const text = "Authorization: Bearer abcdefghijklmnop1234"
    expect(redactPlugin().apply(text, {})).toBe("Authorization: Bearer <redacted>")
  })

  test("masks Token credentials", () => {
    const text = "header: Token deadbeef1234567890abcd"
    expect(redactPlugin().apply(text, {})).toBe("header: Token <redacted>")
  })

  test("masks JWT tokens", () => {
    const text = "auth=eyJhbGciOiJIUzI1NiJ9.eyJzdWIiOiIxMjMifQ.dBjftJeZ4CVPmB92Sg done"
    expect(redactPlugin().apply(text, {})).toBe("auth=<redacted-jwt> done")
  })

  test("masks AWS access keys (AKIA + ASIA)", () => {
    const text = "key=AKIAIOSFODNN7EXAMPLE temp=ASIAIOSFODNN7EXAMPLE"
    expect(redactPlugin().apply(text, {})).toBe("key=<redacted-aws-key> temp=<redacted-aws-key>")
  })

  test("masks GitHub tokens (all prefixes)", () => {
    const text = "ghp_AAAAAAAAAAAAAAAAAAAAA gho_BBBBBBBBBBBBBBBBBBBBB ghs_CCCCCCCCCCCCCCCCCCCCC"
    expect(redactPlugin().apply(text, {})).toBe(
      "<redacted-gh-token> <redacted-gh-token> <redacted-gh-token>",
    )
  })

  test("masks OpenAI keys", () => {
    const text = "OPENAI_KEY=sk-proj-abcdefghijklmnopqrstuvwxyz"
    expect(redactPlugin().apply(text, {})).toContain("<redacted-openai-key>")
  })

  test("masks Slack tokens", () => {
    const text = "SLACK=xoxb-1234567890-abcdefgh"
    expect(redactPlugin().apply(text, {})).toBe("SLACK=<redacted-slack-token>")
  })

  test("masks PEM blocks across multiple lines", () => {
    const text =
      "header\n-----BEGIN RSA PRIVATE KEY-----\nMIIEpAIBAAKCAQEA\nabcdef\n-----END RSA PRIVATE KEY-----\nfooter"
    expect(redactPlugin().apply(text, {})).toBe("header\n<redacted-pem-block>\nfooter")
  })

  test("masks generic KEY=VALUE assignments (case insensitive)", () => {
    const text = 'api_key="0123456789abcdef" SECRET_TOKEN=xyzxyzxyzxyz12'
    const out = redactPlugin().apply(text, {})
    expect(out).toContain("api_key=<redacted>")
    expect(out).toContain("SECRET_TOKEN=<redacted>")
  })

  test("benign text passes through unchanged", () => {
    const text = "Hello world\nNo secrets here\nJust regular output"
    expect(redactPlugin().apply(text, {})).toBe(text)
  })
})

describe("longLinePlugin", () => {
  test("text under threshold passes through unchanged", () => {
    const text = "short line\nanother short line"
    expect(longLinePlugin().apply(text, {})).toBe(text)
  })

  test("elides a single long line preserving the head", () => {
    const line = "a".repeat(600)
    const out = longLinePlugin().apply(line, {})
    expect(out.startsWith("a".repeat(160))).toBe(true)
    expect(out).toContain("…<elided 440 chars>")
  })

  test("keeps short lines intact when mixed with one long line", () => {
    const longLine = "x".repeat(600)
    const text = `intro\n${longLine}\noutro`
    const out = longLinePlugin().apply(text, {})
    const lines = out.split("\n")
    expect(lines[0]).toBe("intro")
    expect(lines[2]).toBe("outro")
    expect(lines[1]).toContain("…<elided 440 chars>")
  })

  test("threshold boundary: 500 chars stays, 501 chars elided", () => {
    expect(longLinePlugin().apply("a".repeat(500), {})).toBe("a".repeat(500))
    const out = longLinePlugin().apply("a".repeat(501), {})
    expect(out).toContain("<elided 341 chars>")
  })
})

describe("createPipeline", () => {
  test("runs injected plugins in declaration order", () => {
    const order: string[] = []
    const tag = (name: string): CleanPlugin => ({
      name,
      apply(text) {
        order.push(name)
        return text
      },
    })
    createPipeline([tag("first"), tag("second"), tag("third")]).run("hello", { command: "x" })
    expect(order).toEqual(["first", "second", "third"])
  })

  test("never-worse guard returns original when chain doesn't shrink", () => {
    const noop: CleanPlugin = { name: "noop", apply: (t) => t }
    const result = createPipeline([noop]).run("unchanged content", { command: "x" })
    expect(result.text).toBe("unchanged content")
    expect(result.degraded).toBe(true)
    expect(result.bytesOut).toBe(result.bytesIn)
  })

  test("never-worse guard reverts even when a plugin inflates output", () => {
    const inflate: CleanPlugin = { name: "inflate", apply: (t) => t + "PADDING_PADDING" }
    const result = createPipeline([inflate]).run("seed", { command: "x" })
    expect(result.text).toBe("seed")
    expect(result.degraded).toBe(true)
  })

  test("reports bytesIn / bytesOut when a plugin shrinks the text", () => {
    const shrink: CleanPlugin = { name: "shrink", apply: (t) => t.replace(/X+/g, "") }
    const result = createPipeline([shrink]).run("aaXXXXXXbb", { command: "x" })
    expect(result.text).toBe("aabb")
    expect(result.bytesIn).toBe(10)
    expect(result.bytesOut).toBe(4)
    expect(result.degraded).toBe(false)
  })

  test("empty input returns empty text without invoking plugins", () => {
    let called = false
    const spy: CleanPlugin = {
      name: "spy",
      apply(t) {
        called = true
        return t
      },
    }
    const result = createPipeline([spy]).run("", { command: "x" })
    expect(called).toBe(false)
    expect(result.text).toBe("")
    expect(result.bytesIn).toBe(0)
    expect(result.bytesOut).toBe(0)
    expect(result.degraded).toBe(false)
  })

  test("'# nofilter' marker bypasses the pipeline", () => {
    const drop: CleanPlugin = { name: "drop", apply: () => "" }
    const result = createPipeline([drop]).run("\x1b[31mraw\x1b[0m", {
      command: "ls -la # nofilter",
    })
    expect(result.text).toBe("\x1b[31mraw\x1b[0m")
    expect(result.degraded).toBe(false)
  })

  test("'# raw' marker bypasses the pipeline", () => {
    const drop: CleanPlugin = { name: "drop", apply: () => "" }
    const result = createPipeline([drop]).run("payload", { command: "ls # raw" })
    expect(result.text).toBe("payload")
  })

  test("MIMOCODE_BASH_RAW=1 bypasses the pipeline", () => {
    const prev = process.env.MIMOCODE_BASH_RAW
    process.env.MIMOCODE_BASH_RAW = "1"
    try {
      const drop: CleanPlugin = { name: "drop", apply: () => "" }
      const result = createPipeline([drop]).run("payload", { command: "ls" })
      expect(result.text).toBe("payload")
    } finally {
      if (prev === undefined) delete process.env.MIMOCODE_BASH_RAW
      else process.env.MIMOCODE_BASH_RAW = prev
    }
  })

  test("plugins receive the command via ctx", () => {
    const seen: Array<string | undefined> = []
    const recorder: CleanPlugin = {
      name: "rec",
      apply(text, ctx) {
        seen.push(ctx.command)
        return text.slice(0, -1)
      },
    }
    createPipeline([recorder]).run("hello", { command: "echo hi" })
    expect(seen).toEqual(["echo hi"])
  })

  test("exposes its plugin list", () => {
    const pipeline = createPipeline(defaultPlugins())
    expect(pipeline.plugins.map((p) => p.name)).toEqual(["progress", "ansi", "redact", "longline"])
  })

  test("empty plugin list runs cleanly (degraded since nothing shrinks)", () => {
    const result = createPipeline([]).run("hello world", { command: "x" })
    expect(result.text).toBe("hello world")
    expect(result.degraded).toBe(true)
  })

  test("missing options defaults to empty context", () => {
    const result = createPipeline([{ name: "shrink", apply: (t) => t.replace("X", "") }]).run(
      "aXb",
    )
    expect(result.text).toBe("ab")
  })
})

describe("defaultPlugins", () => {
  test("returns the canonical chain in correct order", () => {
    expect(defaultPlugins().map((p) => p.name)).toEqual(["progress", "ansi", "redact", "longline"])
  })

  test("returns a fresh array each call (callers may splice safely)", () => {
    const a = defaultPlugins()
    const b = defaultPlugins()
    expect(a).not.toBe(b)
    a.push({ name: "extra", apply: (t) => t })
    expect(defaultPlugins()).toHaveLength(4)
  })
})

describe("clean (default pipeline)", () => {
  test("end-to-end: ANSI + progress + secret + long line all cleaned", () => {
    const longTail = "z".repeat(600)
    const dirty =
      "10%\r50%\r\x1b[32m100% done\x1b[0m\n" +
      "Bearer abcdefghijklmnopqrstuv\n" +
      `payload: ${longTail}`
    const result = clean(dirty, { command: "build" })
    expect(result.text).toContain("100% done")
    expect(result.text).not.toContain("10%")
    expect(result.text).not.toContain("\x1b[")
    expect(result.text).toContain("Bearer <redacted>")
    expect(result.text).toContain("…<elided")
    expect(result.bytesOut).toBeLessThan(result.bytesIn)
    expect(result.degraded).toBe(false)
  })

  test("clean output (no noise, no secrets) triggers never-worse and returns original", () => {
    const text = "ok\nresult: 42\n"
    const result = clean(text, { command: "echo ok" })
    expect(result.text).toBe(text)
    expect(result.degraded).toBe(true)
    expect(result.bytesOut).toBe(result.bytesIn)
  })

  test("undefined command still runs cleaning", () => {
    const dirty = "\x1b[31mred\x1b[0m text here"
    const result = clean(dirty)
    expect(result.text).toBe("red text here")
  })

  test("composition: user plugin can be appended after defaults", () => {
    const stripBanner: CleanPlugin = {
      name: "strip-banner",
      apply: (t) => t.replace(/^=+ START =+\n/, ""),
    }
    const pipeline = createPipeline([...defaultPlugins(), stripBanner])
    const input = "=== START ===\n" + "\x1b[31m" + "payload line\n".repeat(5) + "\x1b[0m"
    const result = pipeline.run(input, { command: "x" })
    expect(result.text.startsWith("=== START ===")).toBe(false)
    expect(result.text).not.toContain("\x1b[")
  })
})
