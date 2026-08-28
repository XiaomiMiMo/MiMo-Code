import { afterEach, describe, expect, test } from "bun:test"
import { contextPressureLevel, contextWindow, isOverflow, pressureLevel, usable } from "../../src/session/overflow"
import { Token } from "../../src/util"
import { Session as SessionNs } from "../../src/session"
import type { Provider } from "../../src/provider"

function mockCfg(opts?: { reserved?: number; auto?: boolean; max_context?: number | string | Record<string, string> }) {
  return {
    compaction: { auto: opts?.auto ?? true, reserved: opts?.reserved, max_context: opts?.max_context },
  } as any
}

function createModel(opts: {
  context: number
  output?: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
  id?: string
}): Provider.Model {
  return {
    id: opts.id ?? "test-model",
    providerID: "test",
    name: "Test",
    limit: {
      context: opts.context,
      input: opts.input,
      output: opts.output ?? 32_000,
    },
    cost: opts.cost ?? { input: 0, output: 0, cache: { read: 0, write: 0 } },
    capabilities: {
      toolcall: true,
      attachment: false,
      reasoning: false,
      temperature: true,
      input: { text: true, image: false, audio: false, video: false },
      output: { text: true, image: false, audio: false, video: false },
    },
    api: { id: opts.id ?? "test-model", npm: opts.npm ?? "@ai-sdk/anthropic" },
    options: {},
  } as Provider.Model
}

describe("pressureLevel", () => {
  test("returns 0 when under 50%", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg()
    const limit = usable({ cfg, model })
    const tokens = { input: Math.floor(limit * 0.3), output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(0)
  })

  test("returns 1 when 50-70%", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg()
    const limit = usable({ cfg, model })
    const tokens = { input: Math.floor(limit * 0.6), output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(1)
  })

  test("returns 2 when 70-85%", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg()
    const limit = usable({ cfg, model })
    const tokens = { input: Math.floor(limit * 0.8), output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(2)
  })

  test("returns 3 when over 85%", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg()
    const limit = usable({ cfg, model })
    const tokens = { input: Math.floor(limit * 0.9), output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(3)
  })

  test("returns 0 when auto compaction disabled", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg({ auto: false })
    const limit = usable({ cfg, model })
    const tokens = { input: Math.floor(limit * 0.9), output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(0)
    expect(contextPressureLevel({ cfg, tokens, model })).toBe(3)
  })

  test("uses exact context pressure boundaries independently of compaction policy", () => {
    const model = createModel({ context: 200_000 })
    const cfg = mockCfg({ auto: false })
    const limit = usable({ cfg, model })
    const tokens = (ratio: number) =>
      ({ input: limit * ratio, output: 0, cache: { read: 0, write: 0 } }) as any

    expect(contextPressureLevel({ cfg, tokens: tokens(0.5), model })).toBe(1)
    expect(contextPressureLevel({ cfg, tokens: tokens(0.7), model })).toBe(2)
    expect(contextPressureLevel({ cfg, tokens: tokens(0.85), model })).toBe(3)
  })

  test("returns 0 when context limit is 0", () => {
    const model = createModel({ context: 0 })
    const cfg = mockCfg()
    const tokens = { input: 100_000, output: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(0)
  })
})

describe("isOverflow", () => {
  test("returns true when token count exceeds usable context", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const cfg = mockCfg()
    // usable = floor(100K * 0.9) = 90K; 88K + 5K = 93K exceeds it
    const tokens = { input: 88_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
  })

  test("returns false when token count within usable context", () => {
    const model = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg()
    const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })

  test("includes cache.read in token count", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const cfg = mockCfg()
    // usable = floor(100K * 0.9) = 90K; 60K + 10K + 25K cache.read = 95K exceeds it
    const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 25_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
  })

  test("includes cache.write in token count", () => {
    // On the first request against a fresh cache, read is 0 and nearly the whole prompt is
    // a cache write. input/read/write partition one request's prompt (getUsage subtracts
    // both cache figures out of the SDK's inputTokens), so dropping write here would make
    // a full context look empty. Provider totals confirm the partition: totalTokens equals
    // input + output + reasoning + read + write.
    const model = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg()
    const tokens = { input: 300, output: 400, reasoning: 0, cache: { read: 0, write: 180_000 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
    expect(contextPressureLevel({ cfg, tokens, model })).toBe(3)
  })

  test("respects input limit for input caps", () => {
    const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
    const cfg = mockCfg()
    const tokens = { input: 271_000, output: 1_000, reasoning: 0, cache: { read: 2_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
  })

  test("returns false when input/output are within input caps", () => {
    const model = createModel({ context: 400_000, input: 272_000, output: 128_000 })
    const cfg = mockCfg()
    const tokens = { input: 200_000, output: 20_000, reasoning: 0, cache: { read: 10_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })

  test("returns false when output within limit with input caps", () => {
    const model = createModel({ context: 200_000, input: 120_000, output: 10_000 })
    const cfg = mockCfg()
    const tokens = { input: 50_000, output: 9_999, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })

  // The compaction trigger is a flat fraction of the window (see
  // Flag.MIMOCODE_COMPACTION_TRIGGER_RATIO), so it reserves headroom uniformly
  // whether or not the model publishes a dedicated input cap. This removes the
  // old asymmetry where a limit.input model triggered compaction later than an
  // equivalent model without one (issues #10634, #8089, #11086, #12621).

  test("reserves headroom via the flat ratio when limit.input is set", () => {
    const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    const cfg = mockCfg()
    // usable = floor(200K * 0.9) = 180K. 180K + 15K + 3K = 198K exceeds it, so
    // compaction fires while ~2K of real headroom remains for the next output.
    const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
  })

  test("limit.input and no-limit models trigger at the same point", () => {
    const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg()
    // Both resolve hard = 200K → usable = 180K, so they agree exactly.
    const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model: withInputLimit })).toBe(true)
    expect(isOverflow({ cfg, tokens, model: withoutInputLimit })).toBe(true)
  })

  test("returns false when model context limit is 0", () => {
    const model = createModel({ context: 0, output: 32_000 })
    const cfg = mockCfg()
    const tokens = { input: 100_000, output: 10_000, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })

  test("returns false when compaction.auto is disabled", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const cfg = mockCfg({ auto: false })
    const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })
})

describe("util.token.estimate", () => {
  test("estimates tokens from text (4 chars per token)", () => {
    const text = "x".repeat(4000)
    expect(Token.estimate(text)).toBe(1000)
  })

  test("estimates tokens from larger text", () => {
    const text = "y".repeat(20_000)
    expect(Token.estimate(text)).toBe(5000)
  })

  test("returns 0 for empty string", () => {
    expect(Token.estimate("")).toBe(0)
  })
})

describe("SessionNs.getUsage", () => {
  test("normalizes standard usage to token format", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(500)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
  })

  test("extracts cached tokens to cache.read", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("handles anthropic cache write metadata", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        anthropic: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.cache.write).toBe(300)
  })

  test("subtracts cached tokens for anthropic provider", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    // AI SDK v6 normalizes inputTokens to include cached tokens for all providers
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        anthropic: {},
      },
    })

    expect(result.tokens.input).toBe(800)
    expect(result.tokens.cache.read).toBe(200)
  })

  test("separates reasoning tokens from output tokens", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 400,
          reasoningTokens: 100,
        },
      },
    })

    expect(result.tokens.input).toBe(1000)
    expect(result.tokens.output).toBe(400)
    expect(result.tokens.reasoning).toBe(100)
    expect(result.tokens.total).toBe(1500)
  })

  test("does not double count reasoning tokens in cost", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 0,
        output: 15,
        cache: { read: 0, write: 0 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 1_000_000,
        totalTokens: 1_000_000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: 750_000,
          reasoningTokens: 250_000,
        },
      },
    })

    expect(result.tokens.output).toBe(750_000)
    expect(result.tokens.reasoning).toBe(250_000)
    expect(result.cost).toBe(15)
  })

  test("handles undefined optional values gracefully", () => {
    const model = createModel({ context: 100_000, output: 32_000 })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.tokens.input).toBe(0)
    expect(result.tokens.output).toBe(0)
    expect(result.tokens.reasoning).toBe(0)
    expect(result.tokens.cache.read).toBe(0)
    expect(result.tokens.cache.write).toBe(0)
    expect(Number.isNaN(result.cost)).toBe(false)
  })

  test("calculates cost correctly", () => {
    const model = createModel({
      context: 100_000,
      output: 32_000,
      cost: {
        input: 3,
        output: 15,
        cache: { read: 0.3, write: 3.75 },
      },
    })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1_000_000,
        outputTokens: 100_000,
        totalTokens: 1_100_000,
        inputTokenDetails: {
          noCacheTokens: undefined,
          cacheReadTokens: undefined,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
    })

    expect(result.cost).toBe(3 + 1.5)
  })

  test.each(["@ai-sdk/anthropic", "@ai-sdk/amazon-bedrock", "@ai-sdk/google-vertex/anthropic"])(
    "computes total from components for %s models",
    (npm) => {
      const model = createModel({ context: 100_000, output: 32_000, npm })
      // AI SDK v6: inputTokens includes cached tokens for all providers
      const usage = {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      }
      if (npm === "@ai-sdk/amazon-bedrock") {
        const result = SessionNs.getUsage({
          model,
          usage,
          metadata: {
            bedrock: {
              usage: {
                cacheWriteInputTokens: 300,
              },
            },
          },
        })

        // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
        expect(result.tokens.input).toBe(500)
        expect(result.tokens.cache.read).toBe(200)
        expect(result.tokens.cache.write).toBe(300)
        // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
        expect(result.tokens.total).toBe(1500)
        return
      }

      const result = SessionNs.getUsage({
        model,
        usage,
        metadata: {
          anthropic: {
            cacheCreationInputTokens: 300,
          },
        },
      })

      // inputTokens (1000) includes cache, so adjusted = 1000 - 200 - 300 = 500
      expect(result.tokens.input).toBe(500)
      expect(result.tokens.cache.read).toBe(200)
      expect(result.tokens.cache.write).toBe(300)
      // total = adjusted (500) + output (500) + cacheRead (200) + cacheWrite (300)
      expect(result.tokens.total).toBe(1500)
    },
  )

  test("extracts cache write tokens from vertex metadata key", () => {
    const model = createModel({ context: 100_000, output: 32_000, npm: "@ai-sdk/google-vertex/anthropic" })
    const result = SessionNs.getUsage({
      model,
      usage: {
        inputTokens: 1000,
        outputTokens: 500,
        totalTokens: 1500,
        inputTokenDetails: {
          noCacheTokens: 800,
          cacheReadTokens: 200,
          cacheWriteTokens: undefined,
        },
        outputTokenDetails: {
          textTokens: undefined,
          reasoningTokens: undefined,
        },
      },
      metadata: {
        vertex: {
          cacheCreationInputTokens: 300,
        },
      },
    })

    expect(result.tokens.input).toBe(500)
    expect(result.tokens.cache.read).toBe(200)
    expect(result.tokens.cache.write).toBe(300)
  })
})

describe("usable", () => {
  test("is a flat 90% of the model window regardless of output size", () => {
    // The trigger is a fixed fraction of the window now, so output size no
    // longer shrinks it — a 32K-output model and an 8K-output model with the
    // same context share the same 90% trigger.
    const big = createModel({ context: 200_000, output: 32_000 })
    const small = createModel({ context: 200_000, output: 8_000 })
    expect(usable({ cfg: mockCfg(), model: big })).toBe(180_000) // floor(200K * 0.9)
    expect(usable({ cfg: mockCfg(), model: small })).toBe(180_000)
  })

  test("cfg.compaction.reserved no longer shrinks the trigger", () => {
    // reserved only gates config-budget validation now; the trigger stays 90%.
    const model = createModel({ context: 200_000, output: 32_000 })
    expect(usable({ cfg: mockCfg({ reserved: 5_000 }), model })).toBe(180_000)
  })
})

describe("MIMOCODE_COMPACTION_TRIGGER_RATIO", () => {
  afterEach(() => {
    delete process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"]
  })

  test("a decimal moves the trigger", () => {
    process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"] = "0.75"
    expect(usable({ cfg: mockCfg(), model: createModel({ context: 200_000 }) })).toBe(150_000)
  })

  test("a percentage is equivalent to the decimal", () => {
    process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"] = "75%"
    expect(usable({ cfg: mockCfg(), model: createModel({ context: 200_000 }) })).toBe(150_000)
  })

  test("1 lets usage fill the whole working window", () => {
    process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"] = "1"
    expect(usable({ cfg: mockCfg(), model: createModel({ context: 200_000 }) })).toBe(200_000)
  })

  test("applies on top of the max_context budget rather than replacing it", () => {
    process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"] = "0.5"
    const model = createModel({ context: 200_000 })
    expect(contextWindow({ cfg: mockCfg({ max_context: "100K" }), model })).toEqual({
      hard: 200_000,
      effective: 100_000,
      usable: 50_000,
      source: "config",
    })
  })

  test.each(["0", "-0.5", "1.5", "150%", "abc", ""])("ignores %p and keeps the 0.9 default", (value) => {
    process.env["MIMOCODE_COMPACTION_TRIGGER_RATIO"] = value
    expect(usable({ cfg: mockCfg(), model: createModel({ context: 200_000 }) })).toBe(180_000)
  })
})

describe("compaction.max_context", () => {
  // 1M-class GPT shape: models.dev publishes both context and a smaller input cap.
  const large = () => createModel({ context: 1_050_000, input: 922_000, output: 128_000, id: "gpt-5.6" })

  test("no budget configured leaves the model window untouched", () => {
    const model = large()
    expect(usable({ cfg: mockCfg(), model })).toBe(829_800)
    expect(contextWindow({ cfg: mockCfg(), model })).toEqual({
      hard: 922_000,
      effective: 922_000,
      usable: 829_800,
      source: "model",
    })
  })

  test("lowers the compaction trigger to the budget", () => {
    const model = large()
    const cfg = mockCfg({ max_context: "300K" })
    expect(contextWindow({ cfg, model })).toEqual({
      hard: 922_000,
      effective: 300_000,
      usable: 270_000,
      source: "config",
    })
    const tokens = { input: 270_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
    const under = { input: 269_999, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens: under, model })).toBe(false)
  })

  test("accepts a plain token count and a percentage", () => {
    const model = large()
    expect(usable({ cfg: mockCfg({ max_context: 500_000 }), model })).toBe(450_000)
    expect(usable({ cfg: mockCfg({ max_context: "50%" }), model })).toBe(414_900)
  })

  test("never raises the window above the provider cap", () => {
    const model = createModel({ context: 128_000, output: 16_384 })
    const cfg = mockCfg({ max_context: "1M" })
    expect(contextWindow({ cfg, model })).toEqual({
      hard: 128_000,
      effective: 128_000,
      usable: 115_200,
      source: "model",
    })
  })

  test("matches per-model keys with wildcards, longest pattern wins", () => {
    const cfg = mockCfg({ max_context: { "test/gpt-5*": "300K", "test/gpt-5.6": "200K" } })
    expect(usable({ cfg, model: large() })).toBe(180_000)
    expect(usable({ cfg, model: createModel({ context: 1_050_000, input: 922_000, id: "gpt-5.4" }) })).toBe(270_000)
  })

  test("ignores keys that match no model", () => {
    const cfg = mockCfg({ max_context: { "openai/gpt-4o": "100K" } })
    expect(usable({ cfg, model: large() })).toBe(829_800)
  })

  test("ignores a budget that leaves no room for the reserves", () => {
    const model = large()
    expect(usable({ cfg: mockCfg({ max_context: 20_000 }), model })).toBe(829_800)
    expect(usable({ cfg: mockCfg({ max_context: "not-a-budget" }), model })).toBe(829_800)
  })

  test("keeps overflow handling disabled when the model reports no window", () => {
    const model = createModel({ context: 0, output: 0 })
    const cfg = mockCfg({ max_context: "300K" })
    expect(contextWindow({ cfg, model })).toEqual({ hard: 0, effective: 0, usable: 0, source: "model" })
    const tokens = { input: 500_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(false)
  })

  test("drives checkpoint pressure off the budget", () => {
    const model = large()
    const cfg = mockCfg({ max_context: "300K" })
    const tokens = { input: 250_000, output: 0, reasoning: 0, cache: { read: 0, write: 0 } } as any
    expect(pressureLevel({ cfg, tokens, model })).toBe(3)
    expect(pressureLevel({ cfg: mockCfg(), tokens, model })).toBe(0)
  })
})

describe("util.token.parseQuantity", () => {
  test("parses numbers, shorthand and percentages", () => {
    expect(Token.parseQuantity(300_000)).toBe(300_000)
    expect(Token.parseQuantity("300K")).toBe(300_000)
    expect(Token.parseQuantity("1.5m")).toBe(1_500_000)
    expect(Token.parseQuantity("50%", 1_000_000)).toBe(500_000)
    expect(Token.parseQuantity(" 200k ")).toBe(200_000)
  })

  test("returns undefined for invalid input", () => {
    expect(Token.parseQuantity("abc")).toBeUndefined()
    expect(Token.parseQuantity("100G")).toBeUndefined()
    expect(Token.parseQuantity("")).toBeUndefined()
    expect(Token.parseQuantity("0%", 1_000)).toBeUndefined()
    expect(Token.parseQuantity("101%", 1_000)).toBeUndefined()
    expect(Token.parseQuantity("50%")).toBeUndefined()
    expect(Token.parseQuantity(-5)).toBeUndefined()
  })
})

describe("compaction.max_context reset sentinel", () => {
  test("0 restores the model window without a warning path", () => {
    const model = createModel({ context: 1_050_000, input: 922_000, id: "gpt-5.6" })
    expect(usable({ cfg: mockCfg({ max_context: { "test/gpt-5.6": 0 } as any }), model })).toBe(829_800)
    expect(contextWindow({ cfg: mockCfg({ max_context: 0 }), model }).source).toBe("model")
    // The picker writes a number, but a hand-edited config may carry the string form.
    expect(usable({ cfg: mockCfg({ max_context: { "test/gpt-5.6": "0" } }), model })).toBe(829_800)
    expect(usable({ cfg: mockCfg({ max_context: "" }), model })).toBe(829_800)
  })
})

describe("small windows", () => {
  test("the trigger stays proportional instead of collapsing to 0", () => {
    // The old fixed-reserve formula could drive usable to 0 on a tiny window
    // (reserved 8K + output 8K > 8K window). The flat 90% fraction keeps a
    // usable trigger no matter how small the window is.
    const model = createModel({ context: 8_192, output: 8_192 })
    expect(contextWindow({ cfg: mockCfg(), model })).toEqual({
      hard: 8_192,
      effective: 8_192,
      usable: 7_372, // floor(8_192 * 0.9)
      source: "model",
    })
  })

  test("an oversized cfg.compaction.reserved no longer zeroes the trigger", () => {
    // reserved only gates config-budget validation now, so a huge value leaves
    // the model window's 90% trigger intact.
    const model = createModel({ context: 200_000, output: 32_000 })
    expect(usable({ cfg: mockCfg({ reserved: 500_000 }), model })).toBe(180_000)
  })
})
