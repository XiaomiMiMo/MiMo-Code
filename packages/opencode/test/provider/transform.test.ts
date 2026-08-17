import { describe, expect, test } from "bun:test"
import { ProviderTransform, type Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"

describe("ProviderTransform.options - setCacheKey", () => {
  const sessionID = "test-session-123"

  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should set promptCacheKey when providerOptions.setCacheKey is true", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: true },
    })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should not set promptCacheKey when providerOptions.setCacheKey is false", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: { setCacheKey: false },
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions is undefined", () => {
    const result = ProviderTransform.options({
      model: mockModel,
      sessionID,
      providerOptions: undefined,
    })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should not set promptCacheKey when providerOptions does not have setCacheKey", () => {
    const result = ProviderTransform.options({ model: mockModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBeUndefined()
  })

  test("should set promptCacheKey for openai provider regardless of setCacheKey", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({ model: openaiModel, sessionID, providerOptions: {} })
    expect(result.promptCacheKey).toBe(sessionID)
  })

  test("should set store=false for openai provider", () => {
    const openaiModel = {
      ...mockModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }
    const result = ProviderTransform.options({
      model: openaiModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(false)
  })

  test("should set store=true for azure provider by default", () => {
    const azureModel = {
      ...mockModel,
      providerID: "azure",
      api: {
        id: "gpt-4",
        url: "https://azure.com",
        npm: "@ai-sdk/azure",
      },
    }
    const result = ProviderTransform.options({
      model: azureModel,
      sessionID,
      providerOptions: {},
    })
    expect(result.store).toBe(true)
  })
})

describe("ProviderTransform.maxOutputTokens", () => {
  const baseModel: Provider.Model = {
    id: ModelID.make("model"),
    providerID: ProviderID.make("test"),
    api: {
      id: "model",
      url: "https://example.com",
      npm: "@ai-sdk/openai-compatible",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: false,
      toolcall: true,
      input: { text: true, audio: false, image: false, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 1_000_000, output: 8_192 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }

  test("uses 128K for mimo provider models", () => {
    expect(
      ProviderTransform.maxOutputTokens({
        ...baseModel,
        id: ModelID.make("mimo-auto"),
        providerID: ProviderID.make("mimo"),
      }),
    ).toBe(128_000)
  })

  test("uses 128K for xiaomi provider models", () => {
    expect(
      ProviderTransform.maxOutputTokens({
        ...baseModel,
        id: ModelID.make("mimo-coder"),
        providerID: ProviderID.make("xiaomi"),
      }),
    ).toBe(128_000)
  })

  test("keeps the default cap for non-mimo models", () => {
    expect(ProviderTransform.maxOutputTokens({ ...baseModel, limit: { context: 1_000_000, output: 64_000 } })).toBe(
      32_000,
    )
  })
})

describe("ProviderTransform.options - zai/zhipuai thinking", () => {
  const sessionID = "test-session-123"

  const createModel = (providerID: string) =>
    ({
      id: `${providerID}/glm-4.6`,
      providerID,
      api: {
        id: "glm-4.6",
        url: "https://open.bigmodel.cn/api/paas/v4",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "GLM 4.6",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 128000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  for (const providerID of ["zai-coding-plan", "zai", "zhipuai-coding-plan", "zhipuai"]) {
    test(`${providerID} should set thinking cfg`, () => {
      const result = ProviderTransform.options({
        model: createModel(providerID),
        sessionID,
        providerOptions: {},
      })

      expect(result.thinking).toEqual({
        type: "enabled",
        clear_thinking: false,
      })
    })
  }
})

describe("ProviderTransform.options - google thinkingConfig gating", () => {
  const sessionID = "test-session-123"

  const createGoogleModel = (reasoning: boolean, npm: "@ai-sdk/google" | "@ai-sdk/google-vertex") =>
    ({
      id: `${npm === "@ai-sdk/google" ? "google" : "google-vertex"}/gemini-2.0-flash`,
      providerID: npm === "@ai-sdk/google" ? "google" : "google-vertex",
      api: {
        id: "gemini-2.0-flash",
        url: npm === "@ai-sdk/google" ? "https://generativelanguage.googleapis.com" : "https://vertexai.googleapis.com",
        npm,
      },
      name: "Gemini 2.0 Flash",
      capabilities: {
        temperature: true,
        reasoning,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 1_000_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("does not set thinkingConfig for google models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })

  test("sets thinkingConfig for google models with reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(true, "@ai-sdk/google"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toEqual({
      includeThoughts: true,
    })
  })

  test("does not set thinkingConfig for vertex models without reasoning capability", () => {
    const result = ProviderTransform.options({
      model: createGoogleModel(false, "@ai-sdk/google-vertex"),
      sessionID,
      providerOptions: {},
    })
    expect(result.thinkingConfig).toBeUndefined()
  })
})

describe("ProviderTransform.options - gpt-5 textVerbosity", () => {
  const sessionID = "test-session-123"

  const createGpt5Model = (apiId: string) =>
    ({
      id: `openai/${apiId}`,
      providerID: "openai",
      api: {
        id: apiId,
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
      name: apiId,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
      limit: { context: 128000, output: 4096 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("gpt-5.2 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.2")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.1 should have textVerbosity set to low", () => {
    const model = createGpt5Model("gpt-5.1")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBe("low")
  })

  test("gpt-5.2-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.2-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.1-chat-latest should NOT have textVerbosity set (only supports medium)", () => {
    const model = createGpt5Model("gpt-5.1-chat-latest")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5.2-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5-chat should NOT have textVerbosity set", () => {
    const model = createGpt5Model("gpt-5-chat")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.2-codex should NOT have textVerbosity set (codex models excluded)", () => {
    const model = createGpt5Model("gpt-5.2-codex")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.textVerbosity).toBeUndefined()
  })

  test("gpt-5.5 should request encrypted reasoning via include (store:false round-trip)", () => {
    const model = createGpt5Model("gpt-5.5")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.store).toBe(false)
    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("gpt-5 should request encrypted reasoning via include", () => {
    const model = createGpt5Model("gpt-5")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("gpt-5-pro should NOT set include (pro path skips reasoning options)", () => {
    const model = createGpt5Model("gpt-5-pro")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result.include).toBeUndefined()
  })
})

describe("ProviderTransform.smallOptions - gpt-5 encrypted reasoning", () => {
  const createModel = (apiId: string, npm: string, providerID = "openai") =>
    ({
      id: `${providerID}/${apiId}`,
      providerID,
      api: { id: apiId, url: "https://api.openai.com", npm },
      name: apiId,
    }) as any

  test("gpt-5.5 small model requests encrypted reasoning (store:false round-trip)", () => {
    const result = ProviderTransform.smallOptions(createModel("gpt-5.5", "@ai-sdk/openai")) as any
    expect(result.store).toBe(false)
    expect(result.reasoningEffort).toBe("low")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("gpt-5 small model requests encrypted reasoning", () => {
    const result = ProviderTransform.smallOptions(createModel("gpt-5", "@ai-sdk/openai")) as any
    expect(result.store).toBe(false)
    expect(result.reasoningEffort).toBe("minimal")
    expect(result.include).toEqual(["reasoning.encrypted_content"])
  })

  test("github-copilot small model does NOT set include (uses its own path)", () => {
    const result = ProviderTransform.smallOptions(
      createModel("gpt-5", "@ai-sdk/github-copilot", "github-copilot"),
    ) as any
    expect(result.store).toBe(false)
    expect(result.include).toBeUndefined()
  })
})

describe("ProviderTransform.options - gateway", () => {
  const sessionID = "test-session-123"

  const createModel = (id: string) =>
    ({
      id,
      providerID: "vercel",
      api: {
        id,
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: id,
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 8192,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
    }) as any

  test("puts gateway defaults under gateway key", () => {
    const model = createModel("anthropic/claude-sonnet-4")
    const result = ProviderTransform.options({ model, sessionID, providerOptions: {} })
    expect(result).toEqual({
      gateway: {
        caching: "auto",
      },
    })
  })
})

describe("ProviderTransform.providerOptions", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "test/test-model",
      providerID: "test",
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm: "@ai-sdk/openai",
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: {
        input: 0.001,
        output: 0.002,
        cache: { read: 0.0001, write: 0.0002 },
      },
      limit: {
        context: 200_000,
        output: 64_000,
      },
      status: "active",
      options: {},
      headers: {},
      release_date: "2024-01-01",
      ...overrides,
    }) as any

  test("uses sdk key for non-gateway models", () => {
    const model = createModel({
      providerID: "my-bedrock",
      api: {
        id: "anthropic.claude-sonnet-4",
        url: "https://bedrock.aws",
        npm: "@ai-sdk/amazon-bedrock",
      },
    })

    expect(ProviderTransform.providerOptions(model, { cachePoint: { type: "default" } })).toEqual({
      bedrock: { cachePoint: { type: "default" } },
    })
  })

  test("uses gateway model provider slug for gateway models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("falls back to gateway key when gateway api id is unscoped", () => {
    const model = createModel({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { thinking: { type: "enabled", budgetTokens: 12_000 } })).toEqual({
      gateway: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    })
  })

  test("splits gateway routing options from provider-specific options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(
      ProviderTransform.providerOptions(model, {
        gateway: { order: ["vertex", "anthropic"] },
        thinking: { type: "enabled", budgetTokens: 12_000 },
      }),
    ).toEqual({
      gateway: { order: ["vertex", "anthropic"] },
      anthropic: { thinking: { type: "enabled", budgetTokens: 12_000 } },
    } as any)
  })

  test("falls back to gateway key when model id has no provider slug", () => {
    const model = createModel({
      id: "claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningEffort: "high" })).toEqual({
      gateway: { reasoningEffort: "high" },
    })
  })

  test("maps amazon slug to bedrock for provider options", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "amazon/nova-2-lite",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningConfig: { type: "enabled" } })).toEqual({
      bedrock: { reasoningConfig: { type: "enabled" } },
    })
  })

  test("uses groq slug for groq models", () => {
    const model = createModel({
      providerID: "vercel",
      api: {
        id: "groq/llama-3.3-70b-versatile",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
    })

    expect(ProviderTransform.providerOptions(model, { reasoningFormat: "parsed" })).toEqual({
      groq: { reasoningFormat: "parsed" },
    })
  })
})

describe("ProviderTransform.schema - gemini array items", () => {
  test("adds missing items for array properties", () => {
    const geminiModel = {
      providerID: "google",
      api: {
        id: "gemini-3-pro",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        nodes: { type: "array" },
        edges: { type: "array", items: { type: "string" } },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.nodes.items).toBeDefined()
    expect(result.properties.edges.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini nested array items", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("adds type to 2D array with empty inner items", () => {
    const schema = {
      type: "object",
      properties: {
        values: {
          type: "array",
          items: {
            type: "array",
            items: {}, // Empty items object
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Inner items should have a default type
    expect(result.properties.values.items.items.type).toBe("string")
  })

  test("adds items and type to 2D array with missing inner items", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "array" }, // No items at all
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.items.items).toBeDefined()
    expect(result.properties.data.items.items.type).toBe("string")
  })

  test("handles deeply nested arrays (3D)", () => {
    const schema = {
      type: "object",
      properties: {
        matrix: {
          type: "array",
          items: {
            type: "array",
            items: {
              type: "array",
              // No items
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.matrix.items.items.items).toBeDefined()
    expect(result.properties.matrix.items.items.items.type).toBe("string")
  })

  test("preserves existing item types in nested arrays", () => {
    const schema = {
      type: "object",
      properties: {
        numbers: {
          type: "array",
          items: {
            type: "array",
            items: { type: "number" }, // Has explicit type
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    // Should preserve the explicit type
    expect(result.properties.numbers.items.items.type).toBe("number")
  })

  test("handles mixed nested structures with objects and arrays", () => {
    const schema = {
      type: "object",
      properties: {
        spreadsheetData: {
          type: "object",
          properties: {
            rows: {
              type: "array",
              items: {
                type: "array",
                items: {}, // Empty items
              },
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.spreadsheetData.properties.rows.items.items.type).toBe("string")
  })
})

describe("ProviderTransform.schema - gemini combiner nodes", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  const walk = (node: any, cb: (node: any, path: (string | number)[]) => void, path: (string | number)[] = []) => {
    if (node === null || typeof node !== "object") {
      return
    }
    if (Array.isArray(node)) {
      node.forEach((item, i) => walk(item, cb, [...path, i]))
      return
    }
    cb(node, path)
    Object.entries(node).forEach(([key, value]) => walk(value, cb, [...path, key]))
  }

  test("keeps edits.items.anyOf without adding type", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                },
                required: ["old_string", "new_string"],
              },
              {
                type: "object",
                properties: {
                  old_string: { type: "string" },
                  new_string: { type: "string" },
                  replace_all: { type: "boolean" },
                },
                required: ["old_string", "new_string"],
              },
            ],
          },
        },
      },
      required: ["edits"],
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(Array.isArray(result.properties.edits.items.anyOf)).toBe(true)
    expect(result.properties.edits.items.type).toBeUndefined()
  })

  test("does not add sibling keys to combiner nodes during sanitize", () => {
    const schema = {
      type: "object",
      properties: {
        edits: {
          type: "array",
          items: {
            anyOf: [{ type: "string" }, { type: "number" }],
          },
        },
        value: {
          oneOf: [{ type: "string" }, { type: "boolean" }],
        },
        meta: {
          allOf: [
            {
              type: "object",
              properties: { a: { type: "string" } },
            },
            {
              type: "object",
              properties: { b: { type: "string" } },
            },
          ],
        },
      },
    } as any
    const input = JSON.parse(JSON.stringify(schema))
    const result = ProviderTransform.schema(geminiModel, schema) as any

    walk(result, (node, path) => {
      const hasCombiner = Array.isArray(node.anyOf) || Array.isArray(node.oneOf) || Array.isArray(node.allOf)
      if (!hasCombiner) {
        return
      }
      const before = path.reduce((acc: any, key) => acc?.[key], input)
      const added = Object.keys(node).filter((key) => !(key in before))
      expect(added).toEqual([])
    })
  })
})

describe("ProviderTransform.schema - gemini non-object properties removal", () => {
  const geminiModel = {
    providerID: "google",
    api: {
      id: "gemini-3-pro",
    },
  } as any

  test("removes properties from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("string")
    expect(result.properties.data.properties).toBeUndefined()
  })

  test("removes required from non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "array",
          items: { type: "string" },
          required: ["invalid"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("array")
    expect(result.properties.data.required).toBeUndefined()
  })

  test("removes properties and required from nested non-object types", () => {
    const schema = {
      type: "object",
      properties: {
        outer: {
          type: "object",
          properties: {
            inner: {
              type: "number",
              properties: { bad: { type: "string" } },
              required: ["bad"],
            },
          },
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.outer.properties.inner.type).toBe("number")
    expect(result.properties.outer.properties.inner.properties).toBeUndefined()
    expect(result.properties.outer.properties.inner.required).toBeUndefined()
  })

  test("keeps properties and required on object types", () => {
    const schema = {
      type: "object",
      properties: {
        data: {
          type: "object",
          properties: { name: { type: "string" } },
          required: ["name"],
        },
      },
    } as any

    const result = ProviderTransform.schema(geminiModel, schema) as any

    expect(result.properties.data.type).toBe("object")
    expect(result.properties.data.properties).toBeDefined()
    expect(result.properties.data.required).toEqual(["name"])
  })

  test("does not affect non-gemini providers", () => {
    const openaiModel = {
      providerID: "openai",
      api: {
        id: "gpt-4",
      },
    } as any

    const schema = {
      type: "object",
      properties: {
        data: {
          type: "string",
          properties: { invalid: { type: "string" } },
        },
      },
    } as any

    const result = ProviderTransform.schema(openaiModel, schema) as any

    expect(result.properties.data.properties).toBeDefined()
  })
})

describe("ProviderTransform.message - DeepSeek reasoning content", () => {
  test("DeepSeek with tool calls includes reasoning_content in providerOptions", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Let me think about this..." },
          {
            type: "tool-call",
            toolCallId: "test",
            toolName: "bash",
            input: { command: "echo hello" },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("deepseek/deepseek-chat"),
        providerID: ProviderID.make("deepseek"),
        api: {
          id: "deepseek-chat",
          url: "https://api.deepseek.com",
          npm: "@ai-sdk/openai-compatible",
        },
        name: "DeepSeek Chat",
        capabilities: {
          temperature: true,
          reasoning: true,
          attachment: false,
          toolcall: true,
          input: { text: true, audio: false, image: false, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: {
            field: "reasoning_content",
          },
        },
        cost: {
          input: 0.001,
          output: 0.002,
          cache: { read: 0.0001, write: 0.0002 },
        },
        limit: {
          context: 128000,
          output: 8192,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result).toHaveLength(2)
    expect(result[0].content).toEqual([
      {
        type: "tool-call",
        toolCallId: "test",
        toolName: "bash",
        input: { command: "echo hello" },
      },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("Let me think about this...")
  })

  test("Non-DeepSeek providers leave reasoning content unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Should not be processed" },
          { type: "text", text: "Answer" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(
      msgs,
      {
        id: ModelID.make("openai/gpt-4"),
        providerID: ProviderID.make("openai"),
        api: {
          id: "gpt-4",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        name: "GPT-4",
        capabilities: {
          temperature: true,
          reasoning: false,
          attachment: true,
          toolcall: true,
          input: { text: true, audio: false, image: true, video: false, pdf: false },
          output: { text: true, audio: false, image: false, video: false, pdf: false },
          interleaved: false,
        },
        cost: {
          input: 0.03,
          output: 0.06,
          cache: { read: 0.001, write: 0.002 },
        },
        limit: {
          context: 128000,
          output: 4096,
        },
        status: "active",
        options: {},
        headers: {},
        release_date: "2023-04-01",
      },
      {},
    )

    expect(result[0].content).toEqual([
      { type: "reasoning", text: "Should not be processed" },
      { type: "text", text: "Answer" },
    ])
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - empty image handling", () => {
  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("should replace empty base64 image with error text", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: "data:image/png;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })

  test("should keep valid base64 images unchanged", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "text", text: "What is in this image?" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })

  test("should handle mixed valid and empty images", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "Compare these images" },
          { type: "image", image: `data:image/png;base64,${validBase64}` },
          { type: "image", image: "data:image/jpeg;base64," },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})

    expect(result).toHaveLength(1)
    expect(result[0].content).toHaveLength(3)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Compare these images" })
    expect(result[0].content[1]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
    expect(result[0].content[2]).toEqual({
      type: "text",
      text: "ERROR: Image file is empty or corrupted. Please provide a valid image.",
    })
  })
})

describe("ProviderTransform.message - oversized image handling", () => {
  const PROVIDER_HARD_LIMIT = 5_242_880
  const mockModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: { id: "claude-3-5-sonnet-20241022", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const base64ByteSize = (b64: string) => {
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
    return Math.floor((b64.length * 3) / 4) - padding
  }

  // A big decodable JPEG (>5 MB): noisy pixels resist JPEG compression, so the
  // encoded payload actually exceeds the limit and forces the shrink path.
  const bigJpegBase64 = (() => {
    const jpeg = require("jpeg-js")
    const width = 2600
    const height = 2600
    const data = Buffer.alloc(width * height * 4)
    for (let i = 0; i < data.length; i += 4) {
      data[i] = (i * 73) % 256
      data[i + 1] = (i * 151) % 256
      data[i + 2] = (i * 199) % 256
      data[i + 3] = 255
    }
    const encoded = jpeg.encode({ data, width, height }, 100)
    return Buffer.from(encoded.data).toString("base64")
  })()

  test("baseline: fixture is a real oversized image", () => {
    expect(base64ByteSize(bigJpegBase64)).toBeGreaterThan(PROVIDER_HARD_LIMIT)
  })

  test("recompresses an oversized user image below the limit", () => {
    const msgs = [
      {
        role: "user",
        content: [
          { type: "text", text: "What is in this image?" },
          { type: "image", image: `data:image/jpeg;base64,${bigJpegBase64}` },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})
    const part = (result[0].content as any[])[1]
    // Either shrunk to a smaller image, or stripped to text — never still oversized.
    if (part.type === "image") {
      const match = String(part.image).match(/^data:[^;]+;base64,(.*)$/)
      expect(match).not.toBeNull()
      expect(base64ByteSize(match![1])).toBeLessThanOrEqual(PROVIDER_HARD_LIMIT)
    } else {
      expect(part.type).toBe("text")
      expect(part.text).toContain("Image omitted")
    }
  })

  test("recompresses an oversized tool-result image below the limit", () => {
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: {
              type: "content",
              value: [
                { type: "text", text: "Image read successfully" },
                { type: "media", mediaType: "image/jpeg", data: bigJpegBase64 },
              ],
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})
    const entry = (result[0].content[0] as any).output.value[1]
    if (entry.type === "media" || entry.type === "image-data") {
      expect(base64ByteSize(entry.data)).toBeLessThanOrEqual(PROVIDER_HARD_LIMIT)
    } else {
      expect(entry.type).toBe("text")
      expect(entry.text).toContain("Image omitted")
    }
  })

  test("strips an oversized undecodable image (webp) to a placeholder", () => {
    // >5 MB of base64 that is NOT a decodable jpeg/png → must become a placeholder.
    const junk = Buffer.alloc(6_000_000, 0x42).toString("base64")
    const msgs = [
      {
        role: "user",
        content: [{ type: "image", image: `data:image/webp;base64,${junk}` }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})
    const part = (result[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain("Image omitted")
  })

  test("strips an oversized undecodable tool-result image to a placeholder", () => {
    const junk = Buffer.alloc(6_000_000, 0x42).toString("base64")
    const msgs = [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: {
              type: "content",
              value: [{ type: "media", mediaType: "image/webp", data: junk }],
            },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})
    const entry = (result[0].content[0] as any).output.value[0]
    expect(entry.type).toBe("text")
    expect(entry.text).toContain("Image omitted")
  })

  test("leaves a small image untouched (default cap applies by default)", () => {
    const validBase64 =
      "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const msgs = [
      { role: "user", content: [{ type: "image", image: `data:image/png;base64,${validBase64}` }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, mockModel, {})
    expect(result[0].content[0]).toEqual({ type: "image", image: `data:image/png;base64,${validBase64}` })
  })
})

describe("ProviderTransform.message - provider-aware image size cap", () => {
  const PROVIDER_HARD_LIMIT = 5_242_880

  const withApi = (providerID: string, api: { id: string; url: string; npm: string }, id?: string) =>
    ({
      id: id ?? `${providerID}/${api.id}`,
      providerID,
      api,
      name: api.id,
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
      limit: { context: 200000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  const base64ByteSize = (b64: string) => {
    const padding = b64.endsWith("==") ? 2 : b64.endsWith("=") ? 1 : 0
    return Math.floor((b64.length * 3) / 4) - padding
  }

  // 6 MB of raw base64 bytes. Not a decodable jpeg/png, so if it ever hit the
  // cap path it would be STRIPPED to a placeholder — which makes "left untouched"
  // an unambiguous signal that no cap was applied.
  const sixMbJunk = Buffer.alloc(6_000_000, 0x42).toString("base64")
  const wrappedSixMbJunk = sixMbJunk.replace(/.{76}/g, "$&\n")

  test("baseline: fixture exceeds the anthropic 5MB hard limit", () => {
    expect(base64ByteSize(sixMbJunk)).toBeGreaterThan(PROVIDER_HARD_LIMIT)
  })

  const userMsgs = () =>
    [{ role: "user", content: [{ type: "image", image: `data:image/webp;base64,${sixMbJunk}` }] }] as any[]

  const toolMsgs = () =>
    [
      {
        role: "tool",
        content: [
          {
            type: "tool-result",
            toolCallId: "call_1",
            toolName: "read",
            output: { type: "content", value: [{ type: "media", mediaType: "image/webp", data: sixMbJunk }] },
          },
        ],
      },
    ] as any[]

  const fileMsgs = (data: string | Uint8Array | URL) =>
    [
      {
        role: "user",
        content: [{ type: "file", mediaType: "image/webp", filename: "capture.webp", data }],
      },
    ] as any[]

  test("anthropic: strips an oversized undecodable user image (cap enforced)", () => {
    const model = withApi("anthropic", {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    })
    const part = (ProviderTransform.message(userMsgs(), model, {})[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain("Image omitted")
  })

  test("anthropic: caps normalized raw-base64 and byte-array image files", () => {
    const model = withApi("anthropic", {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    })

    for (const data of [sixMbJunk, wrappedSixMbJunk, Buffer.from(sixMbJunk, "base64")]) {
      const part = (ProviderTransform.message(fileMsgs(data), model, {})[0].content as any[])[0]
      expect(part.type).toBe("text")
      expect(part.text).toContain("Image omitted")
    }
  })

  test("anthropic: leaves remote image-file URLs untouched", () => {
    const model = withApi("anthropic", {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    })
    const remote = new URL("https://example.com/capture.webp")
    const part = (ProviderTransform.message(fileMsgs(remote), model, {})[0].content as any[])[0]
    expect(part).toEqual({ type: "file", mediaType: "image/webp", filename: "capture.webp", data: remote })
  })

  test("bedrock: strips an oversized undecodable tool-result image (cap enforced)", () => {
    const model = withApi("amazon-bedrock", {
      id: "anthropic.claude-opus-4-6",
      url: "https://bedrock-runtime.us-east-1.amazonaws.com",
      npm: "@ai-sdk/amazon-bedrock",
    })
    const entry = (ProviderTransform.message(toolMsgs(), model, {})[0].content[0] as any).output.value[0]
    expect(entry.type).toBe("text")
    expect(entry.text).toContain("Image omitted")
  })

  test("openai: leaves a 6MB user image UNTOUCHED (no cap for non-anthropic)", () => {
    const model = withApi("openai", { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" })
    const part = (ProviderTransform.message(userMsgs(), model, {})[0].content as any[])[0]
    expect(part).toEqual({ type: "image", image: `data:image/webp;base64,${sixMbJunk}` })
  })

  test("openai: leaves a 6MB raw-base64 image file UNTOUCHED (no cap for non-anthropic)", () => {
    const model = withApi("openai", { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" })
    const part = (ProviderTransform.message(fileMsgs(sixMbJunk), model, {})[0].content as any[])[0]
    expect(part).toEqual({
      type: "file",
      mediaType: "image/webp",
      filename: "capture.webp",
      data: sixMbJunk,
    })
  })

  test("openai: leaves a 6MB tool-result image UNTOUCHED (no cap for non-anthropic)", () => {
    const model = withApi("openai", { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" })
    const entry = (ProviderTransform.message(toolMsgs(), model, {})[0].content[0] as any).output.value[0]
    expect(entry).toEqual({ type: "media", mediaType: "image/webp", data: sixMbJunk })
  })

  test("openrouter claude: still caps (routes to anthropic) — strips oversized image", () => {
    const model = withApi(
      "openrouter",
      { id: "anthropic/claude-sonnet-4", url: "https://openrouter.ai/api", npm: "@openrouter/ai-sdk-provider" },
      "openrouter/anthropic/claude-sonnet-4",
    )
    const part = (ProviderTransform.message(userMsgs(), model, {})[0].content as any[])[0]
    expect(part.type).toBe("text")
    expect(part.text).toContain("Image omitted")
  })

  test("openrouter non-claude: leaves a 6MB image UNTOUCHED (no anthropic route)", () => {
    const model = withApi(
      "openrouter",
      { id: "openai/gpt-4o", url: "https://openrouter.ai/api", npm: "@openrouter/ai-sdk-provider" },
      "openrouter/openai/gpt-4o",
    )
    const part = (ProviderTransform.message(userMsgs(), model, {})[0].content as any[])[0]
    expect(part).toEqual({ type: "image", image: `data:image/webp;base64,${sixMbJunk}` })
  })
})

describe("ProviderTransform.message - anthropic empty content filtering", () => {
  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.003,
      output: 0.015,
      cache: { read: 0.0003, write: 0.00375 },
    },
    limit: {
      context: 200000,
      output: 8192,
    },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("filters out messages with empty string content", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    // String content is left unchanged by the crash guard (strings are valid
    // ModelMessage content — the AI SDK handles them natively).
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("filters out empty text parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Hello" },
          { type: "text", text: "" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Hello" })
  })

  test("filters out empty reasoning parts from array content", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Answer" },
          { type: "reasoning", text: "" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({ type: "text", text: "Answer" })
  })

  test("removes entire message when all parts are empty", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "reasoning", text: "" },
        ],
      },
      { role: "user", content: "World" },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toBe("World")
  })

  test("keeps non-text/reasoning parts even if text parts are empty", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "tool-call", toolCallId: "123", toolName: "bash", input: { command: "ls" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toHaveLength(1)
    expect(result[0].content[0]).toEqual({
      type: "tool-call",
      toolCallId: "123",
      toolName: "bash",
      input: { command: "ls" },
    })
  })

  test("keeps messages with valid text alongside empty parts", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "" },
          { type: "text", text: "Result" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {})

    expect(result).toHaveLength(2)
    expect(result[0].content).toHaveLength(2)
    expect(result[0].content[0]).toEqual({ type: "reasoning", text: "Thinking..." })
    expect(result[0].content[1]).toEqual({ type: "text", text: "Result" })
  })

  test("filters empty content for bedrock provider", () => {
    const bedrockModel = {
      ...anthropicModel,
      id: "amazon-bedrock/anthropic.claude-opus-4-6",
      providerID: "amazon-bedrock",
      api: {
        id: "anthropic.claude-opus-4-6",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
    }

    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [
          { type: "text", text: "" },
          { type: "text", text: "Answer" },
        ],
      },
      // Bedrock rejects a trailing assistant message, so end on a user turn to
      // isolate the empty-content filtering behavior under test here.
      { role: "user", content: "Thanks" },
    ] as any[]

    const result = ProviderTransform.message(msgs, bedrockModel, {})

    expect(result).toHaveLength(3)
    expect(result[0].content).toBe("Hello")
    expect(result[1].content).toHaveLength(1)
    expect(result[1].content[0]).toEqual({ type: "text", text: "Answer" })
    expect(result[2].content).toBe("Thanks")
  })

  test("does not filter for non-anthropic providers", () => {
    const openaiModel = {
      ...anthropicModel,
      providerID: "openai",
      api: {
        id: "gpt-4",
        url: "https://api.openai.com",
        npm: "@ai-sdk/openai",
      },
    }

    const msgs = [
      { role: "assistant", content: "" },
      {
        role: "assistant",
        content: [{ type: "text", text: "" }],
      },
      { role: "user", content: "next" },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, {})

    expect(result).toHaveLength(3)
    expect(result[0].content).toBe("")
    expect(result[1].content).toHaveLength(1)
  })

  test("splits anthropic assistant messages when text trails tool calls", () => {
    const msgs = [
      {
        role: "user",
        content: [{ type: "text", text: "Check my home directory for PDFs" }],
      },
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
          { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
          { type: "text", text: "I checked your home directory and looked for PDF files." },
        ],
      },
      {
        role: "tool",
        content: [
          { type: "tool-result", toolCallId: "toolu_1", toolName: "read", output: { type: "text", value: "ok" } },
          {
            type: "tool-result",
            toolCallId: "toolu_2",
            toolName: "glob",
            output: { type: "text", value: "No files found" },
          },
        ],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result).toHaveLength(4)
    expect(result[1]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I checked your home directory and looked for PDF files." }],
    })
    expect(result[2]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
        { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
      ],
    })
  })

  test("leaves valid anthropic assistant tool ordering unchanged", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "text", text: "I checked your home directory and looked for PDF files." },
          { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
          { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result).toHaveLength(2)
    expect(result[0].content).toMatchObject([
      { type: "text", text: "I checked your home directory and looked for PDF files." },
      { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
      { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
    ])
  })

  test("splits vertex anthropic assistant messages when text trails tool calls", () => {
    const model = {
      ...anthropicModel,
      providerID: "google-vertex-anthropic",
      api: {
        id: "claude-sonnet-4@20250514",
        url: "https://us-central1-aiplatform.googleapis.com",
        npm: "@ai-sdk/google-vertex/anthropic",
      },
    }

    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
          { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
          { type: "text", text: "I checked your home directory and looked for PDF files." },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result).toHaveLength(3)
    expect(result[0]).toMatchObject({
      role: "assistant",
      content: [{ type: "text", text: "I checked your home directory and looked for PDF files." }],
    })
    expect(result[1]).toMatchObject({
      role: "assistant",
      content: [
        { type: "tool-call", toolCallId: "toolu_1", toolName: "read", input: { filePath: "/root" } },
        { type: "tool-call", toolCallId: "toolu_2", toolName: "glob", input: { pattern: "**/*.pdf" } },
      ],
    })
  })
})

describe("ProviderTransform.isAssistantPrefillRejection - error-body detection (defensive backstop)", () => {
  // Backstop for any path that might still slip a trailing assistant prefill to
  // the wire despite the unconditional proactive drop. The only reliable signal
  // for the rejection is the deterministic 400 body, so detection keys off that.
  const bedrockPrefillBody = JSON.stringify({
    message: "This model does not support assistant message prefill. The conversation must end with a user message.",
    Service: "BedrockRuntime",
  })

  test("detects the AI SDK APICallError shape (statusCode 400 + responseBody)", () => {
    const error = {
      name: "AI_APICallError",
      statusCode: 400,
      responseBody: bedrockPrefillBody,
      message: "Bad Request",
      isRetryable: false,
    }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(true)
  })

  test("detects the phrase in the error message even when responseBody is absent", () => {
    const error = {
      statusCode: 400,
      message: "This model does not support assistant message prefill.",
    }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(true)
  })

  test("detects the 'must end with a user message' variant (case-insensitive)", () => {
    const error = { statusCode: 400, responseBody: "The conversation MUST END WITH A USER MESSAGE." }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(true)
  })

  test("matches when statusCode is a numeric string (some gateways stringify it)", () => {
    const error = { statusCode: "400", responseBody: bedrockPrefillBody }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(true)
  })

  test("does NOT match an unrelated 400 (no prefill phrase)", () => {
    const error = { statusCode: 400, responseBody: JSON.stringify({ message: "invalid_request: bad tool schema" }) }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(false)
  })

  test("does NOT match a non-400 status even if the phrase appears (must be the 400 rejection)", () => {
    const error = { statusCode: 500, responseBody: "does not support assistant message prefill" }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(false)
  })

  test("does NOT match null / undefined / non-object", () => {
    expect(ProviderTransform.isAssistantPrefillRejection(undefined)).toBe(false)
    expect(ProviderTransform.isAssistantPrefillRejection(null)).toBe(false)
    expect(ProviderTransform.isAssistantPrefillRejection("does not support assistant message prefill")).toBe(false)
  })

  test("matches when statusCode is absent but the phrase is present (stream-body error without a parsed status)", () => {
    const error = { message: "400 does not support assistant message prefill (Service: BedrockRuntime)" }
    expect(ProviderTransform.isAssistantPrefillRejection(error)).toBe(true)
  })
})

describe("ProviderTransform.ensureTrailingUserMessage - safe proactive guard (never deletes a completed reply)", () => {
  const withProvider = (providerID: string, api: { id: string; url: string; npm: string }) =>
    ({
      id: `${providerID}/${api.id}`,
      providerID,
      api,
      name: api.id,
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
      limit: { context: 200000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  const anthropicModel = withProvider("anthropic", {
    id: "claude-3-5-sonnet-20241022",
    url: "https://api.anthropic.com",
    npm: "@ai-sdk/anthropic",
  })
  const bedrockModel = withProvider("amazon-bedrock", {
    id: "anthropic.claude-opus-4-6",
    url: "https://bedrock-runtime.us-east-1.amazonaws.com",
    npm: "@ai-sdk/amazon-bedrock",
  })
  // Gateway exposing an Anthropic-backed model via a dotted id — the live-400 path
  // (gateway -> Bedrock). The guard is provider-agnostic so it applies here too.
  const gatewayModel = withProvider("mimo", {
    id: "anthropic.claude-sonnet-4",
    url: "http://gateway.example/v1/messages",
    npm: "@ai-sdk/anthropic",
  })

  test("preserves a COMPLETED trailing assistant reply and appends a continuation user turn (no content deleted)", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "text", text: "the full completed answer" }] },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    expect(result).toHaveLength(3)
    // Reply preserved verbatim...
    expect(result[1].role).toBe("assistant")
    expect((result[1].content as any)[0].text).toBe("the full completed answer")
    // ...and the conversation now ends with a user message.
    expect(result[result.length - 1].role).toBe("user")
  })

  test("preserves a trailing assistant that carries a tool-call (real content) via a continuation user turn", () => {
    const msgs = [
      { role: "user", content: "read" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    expect(result.some((m) => Array.isArray(m.content) && (m.content[0] as any)?.type === "tool-call")).toBe(true)
    expect(result[result.length - 1].role).toBe("user")
  })

  test("drops an INCOMPLETE (empty) trailing assistant (residue) without appending anything", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: [] },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
  })

  test("drops a reasoning-only trailing assistant (residue: no final text/tool-call, matches toModelMessages)", () => {
    const msgs = [
      { role: "user", content: "q" },
      { role: "assistant", content: [{ type: "reasoning", text: "some reasoning" }] },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    // A reasoning-only trailing assistant carries no final answer or tool call, so
    // it is residue (upstream toModelMessages skips such aborted turns). Dropped;
    // the conversation then ends on the user turn with nothing appended.
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
  })

  test("peels trailing empty residue but preserves an earlier content-bearing reply with a continuation turn", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "real reply" }] },
      { role: "assistant", content: [] },
      { role: "assistant", content: "   " },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    expect(result.some((m) => Array.isArray(m.content) && (m.content[0] as any)?.text === "real reply")).toBe(true)
    expect(result[result.length - 1].role).toBe("user")
  })

  test("leaves a conversation already ending with a user message untouched (identity)", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "hello" }] },
      { role: "user", content: "bye" },
    ] as any[]
    expect(ProviderTransform.ensureTrailingUserMessage(msgs)).toBe(msgs)
  })

  test("leaves a trailing tool message untouched (tool result is a valid conversation end, not a prefill)", () => {
    const msgs = [
      { role: "user", content: "read" },
      { role: "assistant", content: [{ type: "tool-call", toolCallId: "c1", toolName: "read", input: {} }] },
      {
        role: "tool",
        content: [{ type: "tool-result", toolCallId: "c1", toolName: "read", output: { type: "text", value: "ok" } }],
      },
    ] as any[]
    const result = ProviderTransform.ensureTrailingUserMessage(msgs)
    expect(result).toHaveLength(3)
    expect(result[result.length - 1].role).toBe("tool")
  })

  describe("end-to-end via message() — every provider ends the request with a user message", () => {
    for (const [label, model] of [
      ["anthropic-native", anthropicModel],
      ["bedrock", bedrockModel],
      ["anthropic gateway", gatewayModel],
    ] as const) {
      test(`${label}: a completed trailing reply is kept and the request ends with a user message`, () => {
        const msgs = [
          { role: "user", content: "Question?" },
          { role: "assistant", content: [{ type: "text", text: "Completed answer." }] },
        ] as any[]
        const result = ProviderTransform.message(msgs, model, {})
        expect(result[result.length - 1].role).toBe("user")
        expect(
          result.some((m: any) => Array.isArray(m.content) && m.content.some((p: any) => p.text === "Completed answer.")),
        ).toBe(true)
      })
    }
  })
})

describe("ProviderTransform.dropTrailingAssistantPrefill - hard prune (reactive backstop last resort)", () => {
  test("drops the entire trailing assistant run, discarding content", () => {
    const msgs = [
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "first" }] },
      { role: "assistant", content: [{ type: "text", text: "second" }] },
    ] as any[]
    const result = ProviderTransform.dropTrailingAssistantPrefill(msgs)
    expect(result).toHaveLength(1)
    expect(result[0].role).toBe("user")
  })

  test("only drops the trailing run, preserving mid-conversation assistants", () => {
    const msgs = [
      { role: "user", content: "hi" },
      { role: "assistant", content: [{ type: "text", text: "mid" }] },
      { role: "user", content: "go" },
      { role: "assistant", content: [{ type: "text", text: "tail" }] },
    ] as any[]
    const result = ProviderTransform.dropTrailingAssistantPrefill(msgs)
    expect(result[result.length - 1].role).toBe("user")
    expect(result[result.length - 1].content).toBe("go")
    expect(result.some((m) => Array.isArray(m.content) && (m.content[0] as any)?.text === "mid")).toBe(true)
  })

  test("leaves a user/tool-terminated list unchanged (identity)", () => {
    const msgs = [{ role: "user", content: "hi" }] as any[]
    expect(ProviderTransform.dropTrailingAssistantPrefill(msgs)).toBe(msgs)
  })
})


describe("ProviderTransform.message - strip openai metadata when store=false", () => {
  const openaiModel = {
    id: "openai/gpt-5",
    providerID: "openai",
    api: {
      id: "gpt-5",
      url: "https://api.openai.com",
      npm: "@ai-sdk/openai",
    },
    name: "GPT-5",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.03, output: 0.06, cache: { read: 0.001, write: 0.002 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("strips openai itemId and preserves reasoningEncryptedContent when store=false", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result).toHaveLength(2)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.reasoningEncryptedContent).toBe("encrypted")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBeUndefined()
  })

  test("strips itemId based on SDK package namespace, not provider ID", () => {
    // Custom providerID but @ai-sdk/openai npm (e.g. a proxy) still strips via the openai key.
    const zenModel = {
      ...openaiModel,
      providerID: "zen",
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "reasoning",
            text: "thinking...",
            providerOptions: {
              openai: {
                itemId: "rs_123",
                reasoningEncryptedContent: "encrypted",
              },
            },
          },
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_456",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, zenModel, { store: false }) as any[]

    expect(result).toHaveLength(2)
    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.reasoningEncryptedContent).toBe("encrypted")
    expect(result[0].content[1].providerOptions?.openai?.itemId).toBeUndefined()
  })

  test("strips itemId but preserves other openai options", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, openaiModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.openai?.otherOption).toBe("value")
  })

  test("strips Azure itemId from the azure namespace when store=false", () => {
    const azureModel = {
      ...openaiModel,
      providerID: "azure",
      api: {
        id: "gpt-5",
        url: "https://example.openai.azure.com",
        npm: "@ai-sdk/azure",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              azure: { itemId: "msg_123", otherOption: "value" },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, azureModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.azure?.itemId).toBeUndefined()
    expect(result[0].content[0].providerOptions?.azure?.otherOption).toBe("value")
  })

  test("preserves metadata for openai package when store is true", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              openai: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    // store=true keeps itemId (stateful Responses API resolves items by id)
    const result = ProviderTransform.message(msgs, openaiModel, { store: true }) as any[]

    expect(result[0].content[0].providerOptions?.openai?.itemId).toBe("msg_123")
  })

  test("preserves metadata for non-openai packages when store is false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              anthropic: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    // store=false does NOT strip for non-openai/azure packages
    const result = ProviderTransform.message(msgs, anthropicModel, { store: false }) as any[]

    expect(result[0].content[0].providerOptions?.anthropic?.itemId).toBe("msg_123")
  })

  test("preserves metadata using providerID key for openai-compatible packages", () => {
    const opencodeModel = {
      ...openaiModel,
      providerID: "opencode",
      api: {
        id: "opencode-test",
        url: "https://api.mimocode.ai",
        npm: "@ai-sdk/openai-compatible",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              opencode: {
                itemId: "msg_123",
                otherOption: "value",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, opencodeModel, { store: false }) as any[]

    // @ai-sdk/openai-compatible is not in the strip list, so itemId survives
    expect(result[0].content[0].providerOptions?.opencode?.itemId).toBe("msg_123")
    expect(result[0].content[0].providerOptions?.opencode?.otherOption).toBe("value")
  })

  test("does not strip metadata for non-openai packages when store is not false", () => {
    const anthropicModel = {
      ...openaiModel,
      providerID: "anthropic",
      api: {
        id: "claude-3",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    }
    const msgs = [
      {
        role: "assistant",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              anthropic: {
                itemId: "msg_123",
              },
            },
          },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, anthropicModel, {}) as any[]

    expect(result[0].content[0].providerOptions?.anthropic?.itemId).toBe("msg_123")
  })
})

describe("ProviderTransform.message - providerOptions key remapping", () => {
  const createModel = (providerID: string, npm: string) =>
    ({
      id: `${providerID}/test-model`,
      providerID,
      api: {
        id: "test-model",
        url: "https://api.test.com",
        npm,
      },
      name: "Test Model",
      capabilities: {
        temperature: true,
        reasoning: false,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    }) as any

  test("azure keeps 'azure' key and does not remap to 'openai'", () => {
    const model = createModel("azure", "@ai-sdk/azure")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          azure: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.azure).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.openai).toBeUndefined()
  })

  test("azure cognitive services remaps providerID to 'azure' key", () => {
    const model = createModel("azure-cognitive-services", "@ai-sdk/azure")
    const msgs = [
      {
        role: "user",
        content: [
          {
            type: "text",
            text: "Hello",
            providerOptions: {
              "azure-cognitive-services": { part: true },
            },
          },
        ],
        providerOptions: {
          "azure-cognitive-services": { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]
    const part = result[0].content[0] as any

    expect(result[0].providerOptions?.azure).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["azure-cognitive-services"]).toBeUndefined()
    expect(part.providerOptions?.azure).toEqual({ part: true })
    expect(part.providerOptions?.["azure-cognitive-services"]).toBeUndefined()
  })

  test("copilot remaps providerID to 'copilot' key", () => {
    const model = createModel("github-copilot", "@ai-sdk/github-copilot")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          copilot: { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.copilot).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["github-copilot"]).toBeUndefined()
  })

  test("bedrock remaps providerID to 'bedrock' key", () => {
    const model = createModel("my-bedrock", "@ai-sdk/amazon-bedrock")
    const msgs = [
      {
        role: "user",
        content: "Hello",
        providerOptions: {
          "my-bedrock": { someOption: "value" },
        },
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual({ someOption: "value" })
    expect(result[0].providerOptions?.["my-bedrock"]).toBeUndefined()
  })
})

describe("ProviderTransform.message - claude w/bedrock custom inference profile", () => {
  test("adds cachePoint", () => {
    const model = {
      id: "amazon-bedrock/custom-claude-sonnet-4.5",
      providerID: "amazon-bedrock",
      api: {
        id: "arn:aws:bedrock:xxx:yyy:application-inference-profile/zzz",
        url: "https://api.test.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Custom inference profile",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {})

    expect(result[0].providerOptions?.bedrock).toEqual(
      expect.objectContaining({
        cachePoint: {
          type: "default",
        },
      }),
    )
  })
})

describe("ProviderTransform.message - bedrock caching with non-bedrock providerID", () => {
  test("applies cache options at message level when npm package is amazon-bedrock", () => {
    const model = {
      id: "aws/us.anthropic.claude-opus-4-6-v1",
      providerID: "aws",
      api: {
        id: "us.anthropic.claude-opus-4-6-v1",
        url: "https://bedrock-runtime.us-east-1.amazonaws.com",
        npm: "@ai-sdk/amazon-bedrock",
      },
      name: "Claude Opus 4.6",
      capabilities: {},
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant" }],
      },
      {
        role: "user",
        content: [{ type: "text", text: "Hello" }],
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // Cache should be at the message level and not the content-part level
    expect(result[0].providerOptions?.bedrock).toEqual({
      cachePoint: { type: "default" },
    })
    expect(result[0].content[0].providerOptions?.bedrock).toBeUndefined()
  })
})

describe("ProviderTransform.message - cache control on gateway", () => {
  const createModel = (overrides: Partial<any> = {}) =>
    ({
      id: "anthropic/claude-sonnet-4",
      providerID: "vercel",
      api: {
        id: "anthropic/claude-sonnet-4",
        url: "https://ai-gateway.vercel.sh/v3/ai",
        npm: "@ai-sdk/gateway",
      },
      name: "Claude Sonnet 4",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: true,
        toolcall: true,
        input: { text: true, audio: false, image: true, video: false, pdf: true },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: false,
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 200_000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
      ...overrides,
    }) as any

  test("gateway does not set cache control for anthropic models", () => {
    const model = createModel()
    const msgs = [
      {
        role: "system",
        content: [{ type: "text", text: "You are a helpful assistant" }],
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].content[0].providerOptions).toBeUndefined()
    expect(result[0].providerOptions).toBeUndefined()
  })

  test("non-gateway anthropic keeps existing cache control behavior", () => {
    const model = createModel({
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openrouter: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      bedrock: {
        cachePoint: {
          type: "default",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      copilot: {
        copilot_cache_control: {
          type: "ephemeral",
        },
      },
      alibaba: {
        cacheControl: {
          type: "ephemeral",
        },
      },
    })
  })

  test("non-gateway anthropic with cachePromptTTL '1h' sets ttl on anthropic and openrouter only", () => {
    const model = createModel({
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      cachePromptTTL: "1h",
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
      },
      openrouter: {
        cacheControl: { type: "ephemeral", ttl: "1h" },
      },
      bedrock: {
        cachePoint: { type: "default" },
      },
      openaiCompatible: {
        cache_control: { type: "ephemeral" },
      },
      copilot: {
        copilot_cache_control: { type: "ephemeral" },
      },
      alibaba: {
        cacheControl: { type: "ephemeral" },
      },
    })
  })

  test("non-gateway anthropic with cachePromptTTL '5m' does not set ttl (default behavior)", () => {
    const model = createModel({
      providerID: "anthropic",
      api: {
        id: "claude-sonnet-4",
        url: "https://api.anthropic.com",
        npm: "@ai-sdk/anthropic",
      },
      cachePromptTTL: "5m",
    })
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "Hello" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions?.anthropic).toEqual({ cacheControl: { type: "ephemeral" } })
    expect(result[0].providerOptions?.openrouter).toEqual({ cacheControl: { type: "ephemeral" } })
  })

  test("google-vertex-anthropic applies cache control", () => {
    const model = createModel({
      providerID: "google-vertex-anthropic",
      api: {
        id: "google-vertex-anthropic",
        url: "https://us-central1-aiplatform.googleapis.com",
        npm: "@ai-sdk/google-vertex/anthropic",
      },
      id: "claude-sonnet-4@20250514",
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // String content is left as-is (not normalized to array), so cache markers
    // are applied at the message level — the pre-existing behavior.
    expect(result[0].providerOptions).toEqual({
      anthropic: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      openrouter: {
        cacheControl: {
          type: "ephemeral",
        },
      },
      bedrock: {
        cachePoint: {
          type: "default",
        },
      },
      openaiCompatible: {
        cache_control: {
          type: "ephemeral",
        },
      },
      copilot: {
        copilot_cache_control: {
          type: "ephemeral",
        },
      },
      alibaba: {
        cacheControl: {
          type: "ephemeral",
        },
      },
    })
  })

  test("openai-compatible with claude in model id does NOT trigger caching", () => {
    const model = createModel({
      id: "gateway/claude-opus-4-8",
      providerID: "custom",
      api: {
        id: "gateway/claude-opus-4-8",
        url: "https://proxy.example.com/v1",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const msgs = [
      {
        role: "system",
        content: "You are a helpful assistant",
      },
      {
        role: "user",
        content: "Hello",
      },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    expect(result[0].providerOptions).toBeUndefined()
  })

  test("multi-turn anthropic pins breakpoints to last system + last two messages", () => {
    const model = createModel({
      providerID: "anthropic",
      api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    })
    const msgs = [
      { role: "system", content: "You are a helpful assistant" },
      { role: "user", content: "first question" },
      { role: "assistant", content: "first answer" },
      { role: "user", content: "second question" },
      { role: "assistant", content: "second answer" },
      { role: "user", content: "third question" },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    // The last system message plus the last TWO messages carry a breakpoint
    // (rolling double buffer): the prior turn's tail marker survives as the
    // read point while the new tail marker is the next write.
    const marked = result
      .map((msg, index) => ({ index, role: msg.role, hasCache: !!msg.providerOptions?.anthropic?.cacheControl }))
      .filter((m) => m.hasCache)

    expect(marked).toEqual([
      { index: 0, role: "system", hasCache: true },
      { index: 4, role: "assistant", hasCache: true },
      { index: 5, role: "user", hasCache: true },
    ])
    // No drifting midpoint marker on earlier turns.
    expect(result[2].providerOptions?.anthropic).toBeUndefined()
    expect(result[3].providerOptions?.anthropic).toBeUndefined()
  })

  test("content-level provider marks the last two messages regardless of role", () => {
    // Providers that reach applyCaching honor message-level markers (incl.
    // assistant). The unconditional prefill drop removes any TRAILING assistant
    // before caching, so a mid-conversation assistant (index 3) is the "regardless
    // of role" case: it still gets marked when it lands in the double-tail window.
    const model = createModel({
      providerID: "openrouter",
      api: { id: "anthropic/claude-sonnet-4", url: "https://openrouter.ai/api", npm: "@openrouter/ai-sdk-provider" },
    })
    const msgs = [
      { role: "system", content: [{ type: "text", text: "sys" }] },
      { role: "user", content: [{ type: "text", text: "first question" }] },
      { role: "assistant", content: [{ type: "text", text: "first answer" }] },
      { role: "assistant", content: [{ type: "text", text: "second answer" }] },
      { role: "user", content: [{ type: "text", text: "second question" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, model, {}) as any[]

    const hasMarker = (msg: any) =>
      !!msg.providerOptions?.openrouter ||
      msg.content?.some?.((c: any) => c.providerOptions?.openrouter)

    // The last two messages (index 3 assistant, 4 user) are both marked.
    expect(hasMarker(result[3])).toBe(true)
    expect(hasMarker(result[4])).toBe(true)
    // Earlier turns are not.
    expect(hasMarker(result[1])).toBe(false)
    expect(hasMarker(result[2])).toBe(false)
  })
})

describe("ProviderTransform.tools", () => {
  const createModel = (overrides: Partial<any> = {}): any => ({
    id: "test/test-model",
    providerID: "test",
    api: { id: "test-model", url: "https://api.test.com", npm: "@ai-sdk/openai" },
    name: "Test Model",
    ...overrides,
  })

  test("marks the last tool for anthropic", () => {
    const model = createModel({
      providerID: "anthropic",
      api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    })
    const tools = { read: {}, write: {}, bash: {} } as Record<string, any>

    const result = ProviderTransform.tools(tools, model)

    expect(result.read.providerOptions).toBeUndefined()
    expect(result.write.providerOptions).toBeUndefined()
    expect(result.bash.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral" } } })
  })

  test("threads cachePromptTTL 1h into the tool marker", () => {
    const model = createModel({
      providerID: "anthropic",
      api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
      cachePromptTTL: "1h",
    })
    const tools = { read: {}, bash: {} } as Record<string, any>

    const result = ProviderTransform.tools(tools, model)

    expect(result.bash.providerOptions).toEqual({ anthropic: { cacheControl: { type: "ephemeral", ttl: "1h" } } })
  })

  test("uses cachePoint shape for bedrock", () => {
    const model = createModel({
      providerID: "amazon-bedrock",
      api: { id: "anthropic.claude-sonnet-4", url: "https://api.test.com", npm: "@ai-sdk/amazon-bedrock" },
    })
    const tools = { read: {}, bash: {} } as Record<string, any>

    const result = ProviderTransform.tools(tools, model)

    expect(result.bash.providerOptions).toEqual({ bedrock: { cachePoint: { type: "default" } } })
  })

  test("uses copilot_cache_control shape for github-copilot", () => {
    const model = createModel({
      providerID: "github-copilot",
      api: { id: "claude-sonnet-4", url: "https://api.githubcopilot.com", npm: "@ai-sdk/github-copilot" },
    })
    const tools = { read: {}, bash: {} } as Record<string, any>

    const result = ProviderTransform.tools(tools, model)

    expect(result.bash.providerOptions).toEqual({ copilot: { copilot_cache_control: { type: "ephemeral" } } })
  })

  test("no marker for providers that do not support cache markers", () => {
    const model = createModel({
      providerID: "openai",
      api: { id: "gpt-4", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    })
    const tools = { read: {}, bash: {} } as Record<string, any>

    const result = ProviderTransform.tools(tools, model)

    expect(result.read.providerOptions).toBeUndefined()
    expect(result.bash.providerOptions).toBeUndefined()
  })

  test("no-op on empty tools", () => {
    const model = createModel({
      providerID: "anthropic",
      api: { id: "claude-sonnet-4", url: "https://api.anthropic.com", npm: "@ai-sdk/anthropic" },
    })
    expect(ProviderTransform.tools({}, model)).toEqual({})
  })
})

describe("ProviderTransform.variants", () => {
  const createMockModel = (overrides: Partial<any> = {}): any => ({
    id: "test/test-model",
    providerID: "test",
    api: {
      id: "test-model",
      url: "https://api.test.com",
      npm: "@ai-sdk/openai",
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: {
      input: 0.001,
      output: 0.002,
      cache: { read: 0.0001, write: 0.0002 },
    },
    limit: {
      context: 200_000,
      output: 64_000,
    },
    status: "active",
    options: {},
    headers: {},
    release_date: "2024-01-01",
    ...overrides,
  })

  test("returns empty object when model has no reasoning capabilities", () => {
    const model = createMockModel({
      capabilities: { reasoning: false },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("deepseek returns empty object", () => {
    const model = createMockModel({
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("minimax returns empty object", () => {
    const model = createMockModel({
      id: "minimax/minimax-model",
      providerID: "minimax",
      api: {
        id: "minimax-model",
        url: "https://api.minimax.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("glm returns empty object", () => {
    const model = createMockModel({
      id: "glm/glm-4",
      providerID: "glm",
      api: {
        id: "glm-4",
        url: "https://api.glm.com",
        npm: "@ai-sdk/openai-compatible",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  test("mistral returns empty object", () => {
    const model = createMockModel({
      id: "mistral/mistral-large",
      providerID: "mistral",
      api: {
        id: "mistral-large-latest",
        url: "https://api.mistral.com",
        npm: "@ai-sdk/mistral",
      },
    })
    const result = ProviderTransform.variants(model)
    expect(result).toEqual({})
  })

  describe("@openrouter/ai-sdk-provider", () => {
    test("returns empty object for non-qualifying models", () => {
      const model = createMockModel({
        id: "openrouter/test-model",
        providerID: "openrouter",
        api: {
          id: "test-model",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("gpt models return OPENAI_EFFORTS with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gpt-4",
        providerID: "openrouter",
        api: {
          id: "gpt-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })

    test("gemini-3 returns OPENAI_EFFORTS with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/gemini-3-5-pro",
        providerID: "openrouter",
        api: {
          id: "gemini-3-5-pro",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    })

    test("grok-4 returns empty object", () => {
      const model = createMockModel({
        id: "openrouter/grok-4",
        providerID: "openrouter",
        api: {
          id: "grok-4",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("grok-3-mini returns low and high with reasoning", () => {
      const model = createMockModel({
        id: "openrouter/grok-3-mini",
        providerID: "openrouter",
        api: {
          id: "grok-3-mini",
          url: "https://openrouter.ai",
          npm: "@openrouter/ai-sdk-provider",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoning: { effort: "low" } })
      expect(result.high).toEqual({ reasoning: { effort: "high" } })
    })
  })

  describe("@ai-sdk/gateway", () => {
    test("anthropic sonnet 4.6 models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4-6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic sonnet 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.medium).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "medium",
      })
    })

    test("anthropic opus 4.6 dot-format models return adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-6",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.6",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("anthropic opus 4.7 models return adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4-7",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "xhigh",
      })
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "max",
      })
    })

    test("anthropic opus 4.7 dot-format models return adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-opus-4.7",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
    })

    test("anthropic models return anthropic thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4",
        providerID: "gateway",
        api: {
          id: "anthropic/claude-sonnet-4",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("returns OPENAI_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "gateway/gateway-model",
        providerID: "gateway",
        api: {
          id: "gateway-model",
          url: "https://gateway.ai",
          npm: "@ai-sdk/gateway",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/github-copilot", () => {
    test("standard models return low, medium, high", () => {
      const model = createMockModel({
        id: "gpt-4.5",
        providerID: "github-copilot",
        api: {
          id: "gpt-4.5",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.1-codex-max includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-max",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-max",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.1-codex-mini does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex-mini",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex-mini",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.1-codex does not include xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.1-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.1-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
    })

    test("gpt-5.2 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
      expect(result.xhigh).toEqual({
        reasoningEffort: "xhigh",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5.2-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.2-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.2-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.3-codex includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.3-codex",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.3-codex",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })

    test("gpt-5.4 includes xhigh", () => {
      const model = createMockModel({
        id: "gpt-5.4",
        release_date: "2026-03-05",
        providerID: "github-copilot",
        api: {
          id: "gpt-5.4",
          url: "https://api.githubcopilot.com",
          npm: "@ai-sdk/github-copilot",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh"])
    })
  })

  describe("@ai-sdk/cerebras", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "cerebras/llama-4",
        providerID: "cerebras",
        api: {
          id: "llama-4-sc",
          url: "https://api.cerebras.ai",
          npm: "@ai-sdk/cerebras",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/togetherai", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "togetherai/llama-4",
        providerID: "togetherai",
        api: {
          id: "llama-4-sc",
          url: "https://api.togetherai.com",
          npm: "@ai-sdk/togetherai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/xai", () => {
    test("grok-3 returns empty object", () => {
      const model = createMockModel({
        id: "xai/grok-3",
        providerID: "xai",
        api: {
          id: "grok-3",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("grok-3-mini returns low and high with reasoningEffort", () => {
      const model = createMockModel({
        id: "xai/grok-3-mini",
        providerID: "xai",
        api: {
          id: "grok-3-mini",
          url: "https://api.x.ai",
          npm: "@ai-sdk/xai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/deepinfra", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "deepinfra/llama-4",
        providerID: "deepinfra",
        api: {
          id: "llama-4-sc",
          url: "https://api.deepinfra.com",
          npm: "@ai-sdk/deepinfra",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/openai-compatible", () => {
    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningEffort", () => {
      const model = createMockModel({
        id: "custom-provider/custom-model",
        providerID: "custom-provider",
        api: {
          id: "custom-model",
          url: "https://api.custom.com",
          npm: "@ai-sdk/openai-compatible",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })
  })

  describe("@ai-sdk/azure", () => {
    test("o1-mini returns empty object", () => {
      const model = createMockModel({
        id: "o1-mini",
        providerID: "azure",
        api: {
          id: "o1-mini",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("standard azure models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "o1",
        providerID: "azure",
        api: {
          id: "o1",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("gpt-5 adds minimal effort", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "azure",
        api: {
          id: "gpt-5",
          url: "https://azure.com",
          npm: "@ai-sdk/azure",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
    })
  })

  describe("@ai-sdk/openai", () => {
    test("gpt-5-pro returns empty object", () => {
      const model = createMockModel({
        id: "gpt-5-pro",
        providerID: "openai",
        api: {
          id: "gpt-5-pro",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("standard openai models return custom efforts with reasoningSummary", () => {
      const model = createMockModel({
        id: "gpt-5",
        providerID: "openai",
        api: {
          id: "gpt-5",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2024-06-01",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["minimal", "low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningEffort: "low",
        reasoningSummary: "auto",
        include: ["reasoning.encrypted_content"],
      })
    })

    test("models after 2025-11-13 include 'none' effort", () => {
      const model = createMockModel({
        id: "gpt-5-nano",
        providerID: "openai",
        api: {
          id: "gpt-5-nano",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-11-14",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high"])
    })

    test("models after 2025-12-04 include 'xhigh' effort", () => {
      const model = createMockModel({
        id: "openai/gpt-5-chat",
        providerID: "openai",
        api: {
          id: "gpt-5-chat",
          url: "https://api.openai.com",
          npm: "@ai-sdk/openai",
        },
        release_date: "2025-12-05",
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "minimal", "low", "medium", "high", "xhigh"])
    })
  })

  describe("@ai-sdk/anthropic", () => {
    test("sonnet 4.6 returns adaptive thinking options", () => {
      const model = createMockModel({
        id: "anthropic/claude-sonnet-4-6",
        providerID: "anthropic",
        api: {
          id: "claude-sonnet-4-6",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "high",
      })
    })

    test("opus 4.7 returns adaptive thinking options with xhigh", () => {
      const model = createMockModel({
        id: "anthropic/claude-opus-4-7",
        providerID: "anthropic",
        api: {
          id: "claude-opus-4-7",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "xhigh",
      })
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
          display: "summarized",
        },
        effort: "max",
      })
    })

    test("returns high and max with thinking config", () => {
      const model = createMockModel({
        id: "anthropic/claude-4",
        providerID: "anthropic",
        api: {
          id: "claude-4",
          url: "https://api.anthropic.com",
          npm: "@ai-sdk/anthropic",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })
  })

  describe("@ai-sdk/amazon-bedrock", () => {
    test("anthropic sonnet 4.6 returns adaptive reasoning options", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-sonnet-4-6",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-sonnet-4-6",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.max).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "max",
        },
      })
    })

    test("anthropic opus 4.7 returns adaptive reasoning options with xhigh", () => {
      const model = createMockModel({
        id: "bedrock/anthropic-claude-opus-4-7",
        providerID: "bedrock",
        api: {
          id: "anthropic.claude-opus-4-7",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "xhigh", "max"])
      expect(result.xhigh).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "xhigh",
          display: "summarized",
        },
      })
      expect(result.max).toEqual({
        reasoningConfig: {
          type: "adaptive",
          maxReasoningEffort: "max",
          display: "summarized",
        },
      })
    })

    test("returns WIDELY_SUPPORTED_EFFORTS with reasoningConfig", () => {
      const model = createMockModel({
        id: "bedrock/llama-4",
        providerID: "bedrock",
        api: {
          id: "llama-4-sc",
          url: "https://bedrock.amazonaws.com",
          npm: "@ai-sdk/amazon-bedrock",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({
        reasoningConfig: {
          type: "enabled",
          maxReasoningEffort: "low",
        },
      })
    })
  })

  describe("@ai-sdk/google", () => {
    test("gemini-2.5 returns high and max with thinkingConfig and thinkingBudget", () => {
      const model = createMockModel({
        id: "google/gemini-2.5-pro",
        providerID: "google",
        api: {
          id: "gemini-2.5-pro",
          url: "https://generativelanguage.googleapis.com",
          npm: "@ai-sdk/google",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 16000,
        },
      })
      expect(result.max).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 24576,
        },
      })
    })

    test("other gemini models return low and high with thinkingLevel", () => {
      const model = createMockModel({
        id: "google/gemini-2.0-pro",
        providerID: "google",
        api: {
          id: "gemini-2.0-pro",
          url: "https://generativelanguage.googleapis.com",
          npm: "@ai-sdk/google",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
      expect(result.low).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "low",
        },
      })
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingLevel: "high",
        },
      })
    })
  })

  describe("@ai-sdk/google-vertex", () => {
    test("gemini-2.5 returns high and max with thinkingConfig and thinkingBudget", () => {
      const model = createMockModel({
        id: "google-vertex/gemini-2.5-pro",
        providerID: "google-vertex",
        api: {
          id: "gemini-2.5-pro",
          url: "https://vertexai.googleapis.com",
          npm: "@ai-sdk/google-vertex",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
    })

    test("other vertex models return low and high with thinkingLevel", () => {
      const model = createMockModel({
        id: "google-vertex/gemini-2.0-pro",
        providerID: "google-vertex",
        api: {
          id: "gemini-2.0-pro",
          url: "https://vertexai.googleapis.com",
          npm: "@ai-sdk/google-vertex",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "high"])
    })
  })

  describe("@ai-sdk/cohere", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "cohere/command-r",
        providerID: "cohere",
        api: {
          id: "command-r",
          url: "https://api.cohere.com",
          npm: "@ai-sdk/cohere",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })

  describe("@ai-sdk/groq", () => {
    test("returns none and WIDELY_SUPPORTED_EFFORTS with thinkingLevel", () => {
      const model = createMockModel({
        id: "groq/llama-4",
        providerID: "groq",
        api: {
          id: "llama-4-sc",
          url: "https://api.groq.com",
          npm: "@ai-sdk/groq",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["none", "low", "medium", "high"])
      expect(result.none).toEqual({
        reasoningEffort: "none",
      })
      expect(result.low).toEqual({
        reasoningEffort: "low",
      })
    })
  })

  describe("@ai-sdk/perplexity", () => {
    test("returns empty object", () => {
      const model = createMockModel({
        id: "perplexity/sonar-plus",
        providerID: "perplexity",
        api: {
          id: "sonar-plus",
          url: "https://api.perplexity.ai",
          npm: "@ai-sdk/perplexity",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })

  describe("@jerome-benoit/sap-ai-provider-v2", () => {
    test("anthropic models return thinking variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/anthropic--claude-sonnet-4",
        providerID: "sap-ai-core",
        api: {
          id: "anthropic--claude-sonnet-4",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 16000,
        },
      })
      expect(result.max).toEqual({
        thinking: {
          type: "enabled",
          budgetTokens: 31999,
        },
      })
    })

    test("anthropic 4.6 models return adaptive thinking variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/anthropic--claude-sonnet-4-6",
        providerID: "sap-ai-core",
        api: {
          id: "anthropic--claude-sonnet-4-6",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high", "max"])
      expect(result.low).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "low",
      })
      expect(result.max).toEqual({
        thinking: {
          type: "adaptive",
        },
        effort: "max",
      })
    })

    test("gemini 2.5 models return thinkingConfig variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/gcp--gemini-2.5-pro",
        providerID: "sap-ai-core",
        api: {
          id: "gcp--gemini-2.5-pro",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["high", "max"])
      expect(result.high).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 16000,
        },
      })
      expect(result.max).toEqual({
        thinkingConfig: {
          includeThoughts: true,
          thinkingBudget: 24576,
        },
      })
    })

    test("gpt models return reasoningEffort variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/azure-openai--gpt-4o",
        providerID: "sap-ai-core",
        api: {
          id: "azure-openai--gpt-4o",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("o-series models return reasoningEffort variants", () => {
      const model = createMockModel({
        id: "sap-ai-core/azure-openai--o3-mini",
        providerID: "sap-ai-core",
        api: {
          id: "azure-openai--o3-mini",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(Object.keys(result)).toEqual(["low", "medium", "high"])
      expect(result.low).toEqual({ reasoningEffort: "low" })
      expect(result.high).toEqual({ reasoningEffort: "high" })
    })

    test("sonar models return empty object", () => {
      const model = createMockModel({
        id: "sap-ai-core/perplexity--sonar-pro",
        providerID: "sap-ai-core",
        api: {
          id: "perplexity--sonar-pro",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })

    test("mistral models return empty object", () => {
      const model = createMockModel({
        id: "sap-ai-core/mistral--mistral-large",
        providerID: "sap-ai-core",
        api: {
          id: "mistral--mistral-large",
          url: "https://api.ai.sap",
          npm: "@jerome-benoit/sap-ai-provider-v2",
        },
      })
      const result = ProviderTransform.variants(model)
      expect(result).toEqual({})
    })
  })
})

// Regression: OpenAI's function-calling validator rejects discriminated-union
// tools with "schema must have type 'object' and not have 'oneOf'/'anyOf'/
// 'allOf'/'enum'/'not' at the top level." Adding `type: "object"` to a root
// anyOf is NOT enough — the union itself must be removed from the top level.
// The transform flattens variants into a single object, with the discriminator
// becoming an enum and per-variant required encoded in its description.
describe("ProviderTransform.schema - openai discriminated-union flatten", () => {
  const anyOfSchema = {
    anyOf: [
      {
        type: "object",
        properties: {
          action: { const: "create", description: "Operation" },
          summary: { type: "string", minLength: 1 },
          parent_id: { type: "string", minLength: 1 },
        },
        required: ["action", "summary"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: { action: { const: "list" } },
        required: ["action"],
        additionalProperties: false,
      },
      {
        type: "object",
        properties: {
          action: { const: "rename" },
          id: { type: "string", minLength: 1 },
          summary: { type: "string", minLength: 1 },
        },
        required: ["action", "id", "summary"],
        additionalProperties: false,
      },
    ],
  } as any

  test("openai providerID — flattens to single object, no oneOf/anyOf at root", () => {
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    expect(result.type).toBe("object")
    expect(result.anyOf).toBeUndefined()
    expect(result.oneOf).toBeUndefined()
    expect(result.allOf).toBeUndefined()
    expect(result.additionalProperties).toBe(false)
  })

  test("openai — merges variant properties at root", () => {
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    // All non-discriminator properties merged in (the flatten adds an
    // "(only when action=...)" prefix to descriptions; assert structurally).
    expect(result.properties.summary.type).toBe("string")
    expect(result.properties.summary.minLength).toBe(1)
    expect(result.properties.parent_id.type).toBe("string")
    expect(result.properties.parent_id.minLength).toBe(1)
    expect(result.properties.id.type).toBe("string")
    expect(result.properties.id.minLength).toBe(1)
  })

  test("openai — annotates each property with which actions own it", () => {
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    // parent_id only appears in the "create" variant
    expect(result.properties.parent_id.description).toContain('only when action="create"')
    // id only appears in the "rename" variant
    expect(result.properties.id.description).toContain('only when action="rename"')
    // summary appears in both create and rename
    expect(result.properties.summary.description).toContain('only when action="create"|"rename"')
  })

  test("openai — discriminator becomes enum with per-variant required hints", () => {
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    expect(result.properties.action.type).toBe("string")
    expect(result.properties.action.enum).toEqual(["create", "list", "rename"])
    expect(result.properties.action.description).toContain("create: requires summary")
    expect(result.properties.action.description).toContain("list: no extra required")
    expect(result.properties.action.description).toContain("rename: requires id, summary")
  })

  test("openai — only discriminator is required at root", () => {
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    expect(result.required).toEqual(["action"])
  })

  test("@ai-sdk/openai-compatible npm — also flattens", () => {
    const result = ProviderTransform.schema(
      { providerID: "custom-router", api: { id: "x", npm: "@ai-sdk/openai-compatible" } } as any,
      anyOfSchema,
    ) as any
    expect(result.type).toBe("object")
    expect(result.anyOf).toBeUndefined()
  })

  test("azure providerID — also flattens", () => {
    const result = ProviderTransform.schema({ providerID: "azure", api: { id: "gpt-4" } } as any, anyOfSchema) as any
    expect(result.type).toBe("object")
    expect(result.anyOf).toBeUndefined()
  })

  test("anthropic — also flattens anyOf-rooted schema (bedrock proxy compatibility)", () => {
    const result = ProviderTransform.schema(
      { providerID: "anthropic", api: { id: "claude", npm: "@ai-sdk/anthropic" } } as any,
      anyOfSchema,
    ) as any
    expect(result.type).toBe("object")
    expect(result.anyOf).toBeUndefined()
  })

  test("openai — passes through schemas that are already type: object", () => {
    const flat = { type: "object", properties: { a: { type: "string" } }, required: ["a"] } as any
    const result = ProviderTransform.schema({ providerID: "openai", api: { id: "gpt-4" } } as any, flat) as any
    expect(result.type).toBe("object")
    expect(result.properties.a).toBeDefined()
    expect(result.anyOf).toBeUndefined()
  })
})

describe("ProviderTransform.schema - moonshot combiner sibling type", () => {
  // Real shape of the `operation` node emitted by task/actor/cron/session:
  // z.discriminatedUnion(...).meta({ type: "object" }) serializes to
  // { type: "object", anyOf: [...] } nested under a root strictObject (so
  // flattenDiscriminatedUnion leaves it alone). oneOf is also covered — the
  // transform handles it defensively.
  const nested = (combiner: "oneOf" | "anyOf") =>
    ({
      type: "object",
      properties: {
        operation: {
          type: "object",
          [combiner]: [
            {
              type: "object",
              properties: { action: { type: "string", const: "create" }, summary: { type: "string", minLength: 1 } },
              required: ["action", "summary"],
              additionalProperties: false,
            },
            {
              type: "object",
              properties: { action: { type: "string", const: "list" } },
              required: ["action"],
              additionalProperties: false,
            },
          ],
        },
      },
      required: ["operation"],
      additionalProperties: false,
    }) as any

  const moonshot = { providerID: "moonshotai", api: { id: "kimi-k2.7-code", npm: "@ai-sdk/openai-compatible" } } as any

  test("moonshotai — drops the parent type sitting next to oneOf", () => {
    const result = ProviderTransform.schema(moonshot, nested("oneOf")) as any
    expect(result.properties.operation.type).toBeUndefined()
    expect(Array.isArray(result.properties.operation.oneOf)).toBe(true)
    // Variants keep their own type, so the meaning is preserved.
    expect(result.properties.operation.oneOf.every((v: any) => v.type === "object")).toBe(true)
    // Root object is untouched.
    expect(result.type).toBe("object")
    expect(result.required).toEqual(["operation"])
  })

  test("moonshotai — drops the parent type sitting next to anyOf", () => {
    const result = ProviderTransform.schema(moonshot, nested("anyOf")) as any
    expect(result.properties.operation.type).toBeUndefined()
    expect(Array.isArray(result.properties.operation.anyOf)).toBe(true)
  })

  test("detects Kimi via model id even when the provider id is not moonshot (e.g. a gateway)", () => {
    const gateway = { providerID: "opencode", api: { id: "kimi-k2.7-code", npm: "@ai-sdk/openai-compatible" } } as any
    const result = ProviderTransform.schema(gateway, nested("oneOf")) as any
    expect(result.properties.operation.type).toBeUndefined()
  })

  test("pushes the parent type into a combiner item that lacks its own, keeping the item's own keys", () => {
    const schema = {
      type: "object",
      properties: {
        operation: {
          type: "object",
          anyOf: [
            { properties: { action: { const: "x" }, note: { type: "string" } }, required: ["action"] },
            { type: "object", properties: { action: { const: "y" } }, additionalProperties: false },
          ],
        },
      },
    } as any
    const result = ProviderTransform.schema(moonshot, schema) as any
    expect(result.properties.operation.type).toBeUndefined()
    // The typeless variant inherits the parent type WITHOUT losing its own keys.
    expect(result.properties.operation.anyOf[0].type).toBe("object")
    expect(result.properties.operation.anyOf[0].properties.action.const).toBe("x")
    expect(result.properties.operation.anyOf[0].properties.note.type).toBe("string")
    expect(result.properties.operation.anyOf[0].required).toEqual(["action"])
    // The already-typed variant is preserved untouched.
    expect(result.properties.operation.anyOf[1].type).toBe("object")
    expect(result.properties.operation.anyOf[1].properties.action.const).toBe("y")
    expect(result.properties.operation.anyOf[1].additionalProperties).toBe(false)
  })

  test("matches Moonshot via provider id 'kimi-for-coding' and via 'moonshot' in the model id", () => {
    // exercises the isMoonshot branches provider.includes('kimi') and apiID.includes('moonshot')
    const kfc = { providerID: "kimi-for-coding", api: { id: "k2", npm: "@ai-sdk/anthropic" } } as any
    expect((ProviderTransform.schema(kfc, nested("anyOf")) as any).properties.operation.type).toBeUndefined()
    const byModelId = { providerID: "custom", api: { id: "moonshot-v1-8k", npm: "@ai-sdk/openai-compatible" } } as any
    expect((ProviderTransform.schema(byModelId, nested("anyOf")) as any).properties.operation.type).toBeUndefined()
  })

  test("normalizes a combiner+type nested deep inside array items and additionalProperties", () => {
    const schema = {
      type: "object",
      properties: {
        list: { type: "array", items: { type: "object", anyOf: [{ type: "object", properties: { k: { const: "a" } } }] } },
        bag: { type: "object", additionalProperties: { type: "object", oneOf: [{ type: "object", properties: { k: { const: "b" } } }] } },
      },
    } as any
    const result = ProviderTransform.schema(moonshot, schema) as any
    expect(result.properties.list.items.type).toBeUndefined()
    expect(Array.isArray(result.properties.list.items.anyOf)).toBe(true)
    expect(result.properties.bag.additionalProperties.type).toBeUndefined()
    expect(Array.isArray(result.properties.bag.additionalProperties.oneOf)).toBe(true)
    // The array/object containers keep their own type.
    expect(result.properties.list.type).toBe("array")
    expect(result.properties.bag.type).toBe("object")
  })

  test("leaves a combiner that has NO sibling type untouched", () => {
    const schema = {
      type: "object",
      properties: { operation: { anyOf: [{ type: "object", properties: { a: { const: "x" } } }] } },
    } as any
    const result = ProviderTransform.schema(moonshot, schema) as any
    expect("type" in result.properties.operation).toBe(false)
    expect(result.properties.operation.anyOf[0].type).toBe("object")
  })

  test("non-moonshot models keep the parent type (guards the mimo/MiniMax stringify mitigation, #1371)", () => {
    const mimo = { providerID: "mimo", api: { id: "mimo-v2.5-pro", npm: "@ai-sdk/openai-compatible" } } as any
    const result = ProviderTransform.schema(mimo, nested("oneOf")) as any
    expect(result.properties.operation.type).toBe("object")
    expect(Array.isArray(result.properties.operation.oneOf)).toBe(true)
  })

  test("leaves allOf + type untouched (only anyOf/oneOf are rejected by Moonshot)", () => {
    const schema = {
      type: "object",
      properties: {
        operation: { type: "object", allOf: [{ type: "object", properties: { a: { type: "string" } } }] },
      },
    } as any
    const result = ProviderTransform.schema(moonshot, schema) as any
    expect(result.properties.operation.type).toBe("object")
    expect(Array.isArray(result.properties.operation.allOf)).toBe(true)
  })

  test("does not mutate the input schema", () => {
    const input = nested("anyOf")
    const snapshot = JSON.stringify(input)
    ProviderTransform.schema(moonshot, input)
    expect(JSON.stringify(input)).toBe(snapshot)
    expect(input.properties.operation.type).toBe("object")
  })
})

describe("ProviderTransform.message - non-array content guard (j.map is not a function)", () => {
  const anthropicModel = {
    id: "anthropic/claude-3-5-sonnet",
    providerID: "anthropic",
    api: {
      id: "claude-3-5-sonnet-20241022",
      url: "https://api.anthropic.com",
      npm: "@ai-sdk/anthropic",
    },
    name: "Claude 3.5 Sonnet",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: true },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.003, output: 0.015, cache: { read: 0.0003, write: 0.00375 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  const genericModel = {
    id: "openai/gpt-4o",
    providerID: "openai",
    api: { id: "gpt-4o", url: "https://api.openai.com", npm: "@ai-sdk/openai" },
    name: "GPT-4o",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0.005, output: 0.015, cache: { read: 0.0025, write: 0.005 } },
    limit: { context: 128000, output: 4096 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("string content is left unchanged (strings are valid ModelMessage content)", () => {
    const msgs = [{ role: "user", content: "Hello" }] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe("Hello")
  })

  test("empty string content is left unchanged", () => {
    const msgs = [
      { role: "assistant", content: "" },
      { role: "user", content: "next" },
    ] as any[]
    const result = ProviderTransform.message(msgs, anthropicModel, {})
    // The empty string assistant gets dropped by normalizeMessages (anthropic
    // filtering), so only the user message remains.
    expect(result).toHaveLength(1)
    expect(result[0].content).toBe("next")
  })

  test("undefined content is normalized to empty array (crash guard)", () => {
    const msgs = [{ role: "user", content: undefined }] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    expect(result).toHaveLength(1)
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(result[0].content).toEqual([])
  })

  test("null content is normalized to empty array (crash guard)", () => {
    const msgs = [{ role: "user", content: null }] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    expect(result).toHaveLength(1)
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(result[0].content).toEqual([])
  })

  test("object content is normalized to empty array (crash guard)", () => {
    const msgs = [{ role: "user", content: { type: "text", text: "oops" } }] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    expect(result).toHaveLength(1)
    expect(Array.isArray(result[0].content)).toBe(true)
    expect(result[0].content).toEqual([])
  })

  test("already-array content passes through unchanged", () => {
    const msgs = [{ role: "user", content: [{ type: "text", text: "Hello" }] }] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    expect(result).toHaveLength(1)
    expect(result[0].content).toEqual([{ type: "text", text: "Hello" }])
  })

  test("mixed: string user + array assistant + undefined all survive", () => {
    const msgs = [
      { role: "user", content: "Hello" },
      { role: "assistant", content: [{ type: "text", text: "Hi!" }] },
      { role: "user", content: undefined },
    ] as any[]
    const result = ProviderTransform.message(msgs, genericModel, {})
    // String user and array assistant survive; undefined user gets []
    expect(result.length).toBeGreaterThanOrEqual(2)
    expect(result[0].content).toBe("Hello")
    expect(Array.isArray(result[1].content)).toBe(true)
  })

  test("object/undefined/null content does not throw (the original j.map bug)", () => {
    const msgs = [
      { role: "user", content: { some: "object" } },
      { role: "assistant", content: undefined },
      { role: "user", content: null },
    ] as any[]
    expect(() => ProviderTransform.message(msgs, genericModel, {})).not.toThrow()
  })
})

describe("ProviderTransform.message - interleaved field: openrouter exclusion", () => {
  const openrouterModel = {
    id: "openrouter/anthropic/claude-sonnet-4",
    providerID: "openrouter",
    api: {
      id: "anthropic/claude-sonnet-4",
      url: "https://openrouter.ai/api",
      npm: "@openrouter/ai-sdk-provider",
    },
    name: "Claude Sonnet 4",
    capabilities: {
      temperature: true,
      reasoning: true,
      attachment: true,
      toolcall: true,
      input: { text: true, audio: false, image: true, video: false, pdf: false },
      output: { text: true, audio: false, image: false, video: false, pdf: false },
      interleaved: { field: "reasoning_content" },
    },
    cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
    limit: { context: 200000, output: 8192 },
    status: "active",
    options: {},
    headers: {},
  } as any

  test("openrouter is excluded from interleaved field injection", () => {
    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "Thinking..." },
          { type: "text", text: "Answer" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, openrouterModel, {})

    // Reasoning parts should be LEFT IN content (not extracted to providerOptions.openaiCompatible)
    const assistantContent = result[0].content as any[]
    expect(assistantContent).toHaveLength(2)
    expect(assistantContent[0].type).toBe("reasoning")
    expect(assistantContent[0].text).toBe("Thinking...")
    expect(assistantContent[1].type).toBe("text")
    expect(assistantContent[1].text).toBe("Answer")
    // The interleaved field must NOT be set on the message (openrouter excluded)
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBeUndefined()
  })
})

describe("ProviderTransform.message - interleaved field: empty reasoning still sets the field", () => {
  test("empty reasoning_content is echoed back (DeepSeek-style)", () => {
    const deepseekModel = {
      id: "deepseek/deepseek-chat",
      providerID: "deepseek",
      api: {
        id: "deepseek-chat",
        url: "https://api.deepseek.com",
        npm: "@ai-sdk/openai-compatible",
      },
      name: "DeepSeek Chat",
      capabilities: {
        temperature: true,
        reasoning: true,
        attachment: false,
        toolcall: true,
        input: { text: true, audio: false, image: false, video: false, pdf: false },
        output: { text: true, audio: false, image: false, video: false, pdf: false },
        interleaved: { field: "reasoning_content" },
      },
      cost: { input: 0.001, output: 0.002, cache: { read: 0.0001, write: 0.0002 } },
      limit: { context: 128000, output: 8192 },
      status: "active",
      options: {},
      headers: {},
    } as any

    const msgs = [
      {
        role: "assistant",
        content: [
          { type: "reasoning", text: "" },
          { type: "text", text: "Hello" },
        ],
      },
      { role: "user", content: [{ type: "text", text: "next" }] },
    ] as any[]

    const result = ProviderTransform.message(msgs, deepseekModel, {})

    expect(result[0].content).toEqual([{ type: "text", text: "Hello" }])
    // The field MUST be set even when reasoningText is empty
    expect(result[0].providerOptions?.openaiCompatible?.reasoning_content).toBe("")
  })
})
