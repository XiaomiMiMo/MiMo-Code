import { describe, expect, test } from "bun:test"
import { isOverflow, pressureLevel, usable } from "../../src/session/overflow"
import { Token } from "../../src/util"
import { Session as SessionNs } from "../../src/session"
import type { Provider } from "../../src/provider"

function mockCfg(opts?: { reserved?: number; auto?: boolean }) {
  return {
    compaction: { auto: opts?.auto ?? true, reserved: opts?.reserved },
  } as any
}

function createModel(opts: {
  context: number
  output?: number
  input?: number
  cost?: Provider.Model["cost"]
  npm?: string
}): Provider.Model {
  return {
    id: "test-model",
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
    api: { npm: opts.npm ?? "@ai-sdk/anthropic" },
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
    const tokens = { input: 75_000, output: 5_000, reasoning: 0, cache: { read: 0, write: 0 } } as any
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
    const tokens = { input: 60_000, output: 10_000, reasoning: 0, cache: { read: 10_000, write: 0 } } as any
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
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

  // ─── Bug reproduction tests ───────────────────────────────────────────
  // These tests demonstrate that when limit.input is set, isOverflow()
  // does not subtract any headroom for the next model response. This means
  // compaction only triggers AFTER we've already consumed the full input
  // budget, leaving zero room for the next API call's output tokens.
  //
  // Compare: without limit.input, usable = context - output (reserves space).
  // With limit.input, usable = limit.input (reserves nothing).
  //
  // Related issues: #10634, #8089, #11086, #12621
  // Open PRs: #6875, #12924

  test("BUG: no headroom when limit.input is set — compaction should trigger near boundary but does not", () => {
    // Simulate Claude with prompt caching: input limit = 200K, output limit = 32K
    const model = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    const cfg = mockCfg()

    // We've used 198K tokens total. Only 2K under the input limit.
    // On the next turn, the full conversation (198K) becomes input,
    // plus the model needs room to generate output — this WILL overflow.
    const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } } as any
    // count = 180K + 3K + 15K = 198K
    // usable = limit.input = 200K (no output subtracted!)
    // 198K > 200K = false → no compaction triggered

    // WITHOUT limit.input: usable = 200K - 32K = 168K, and 198K > 168K = true ✓
    // WITH limit.input: usable = 200K, and 198K > 200K = false ✗

    // With 198K used and only 2K headroom, the next turn will overflow.
    // Compaction MUST trigger here.
    expect(isOverflow({ cfg, tokens, model })).toBe(true)
  })

  test("BUG: without limit.input, same token count correctly triggers compaction", () => {
    // Same model but without limit.input — uses context - output instead
    const model = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg()

    // Same token usage as above
    const tokens = { input: 180_000, output: 15_000, reasoning: 0, cache: { read: 3_000, write: 0 } } as any
    // count = 198K
    // usable = context - output = 200K - 32K = 168K
    // 198K > 168K = true → compaction correctly triggered

    expect(isOverflow({ cfg, tokens, model })).toBe(true) // ← Correct: headroom is reserved
  })

  test("BUG: asymmetry — limit.input model allows 30K more usage before compaction than equivalent model without it", () => {
    // Two models with identical context/output limits, differing only in limit.input
    const withInputLimit = createModel({ context: 200_000, input: 200_000, output: 32_000 })
    const withoutInputLimit = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg()

    // 170K total tokens — well above context-output (168K) but below input limit (200K)
    const tokens = { input: 166_000, output: 10_000, reasoning: 0, cache: { read: 5_000, write: 0 } } as any

    const withLimit = isOverflow({ cfg, tokens, model: withInputLimit })
    const withoutLimit = isOverflow({ cfg, tokens, model: withoutInputLimit })

    // Both models have identical real capacity — they should agree:
    expect(withLimit).toBe(true) // should compact (170K leaves no room for 32K output)
    expect(withoutLimit).toBe(true) // correctly compacts (170K > 168K)
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
  test("caps output reservation at 20K when model.limit.output is larger", () => {
    // 200K context with 32K output — without the cap, usable would be 200K - 32K = 168K.
    // With OUTPUT_CAP=20K, usable should be 200K - 20K - reserved.
    const model = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg() // reserved defaults to min(20K, 32K) = 20K
    expect(usable({ cfg, model })).toBe(160_000) // 200K - 20K (output cap) - 20K (reserved)
  })

  test("does not cap when model.limit.output is below 20K", () => {
    // 100K context with 8K output — output cap (20K) does not bite.
    // usable should be 100K - 8K - reserved.
    const model = createModel({ context: 100_000, output: 8_000 })
    const cfg = mockCfg() // reserved defaults to min(20K, 8K) = 8K
    expect(usable({ cfg, model })).toBe(84_000) // 100K - 8K (raw output, below cap) - 8K (reserved)
  })

  test("respects user-configured cfg.compaction.reserved", () => {
    // 200K context, output 32K, user sets reserved=5K explicitly.
    // usable = 200K - min(32K, 20K) - 5K = 175K
    const model = createModel({ context: 200_000, output: 32_000 })
    const cfg = mockCfg({ reserved: 5_000 })
    expect(usable({ cfg, model })).toBe(175_000)
  })
})
