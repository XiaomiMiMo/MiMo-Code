import { describe, expect, test } from "bun:test"
import { APICallError } from "ai"
import { parseAPICallError } from "../../src/provider/error"
import { ProviderID } from "../../src/provider/schema"

const xiaomi = ProviderID.make("xiaomi")
const mimo = ProviderID.make("mimo")
const openai = ProviderID.make("openai")

function apiError(opts: { message: string; statusCode?: number; responseBody?: string }) {
  return new APICallError({
    message: opts.message,
    url: "https://api.example.com/v1/messages",
    requestBodyValues: {},
    statusCode: opts.statusCode,
    responseHeaders: { "content-type": "application/json" },
    responseBody: opts.responseBody,
    isRetryable: false,
  })
}

describe("provider error message", () => {
  test("maps MiMo 421 moderation block (HTTP 400) to a friendly message with param detail", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Moderation Block",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { code: "421", message: "Moderation Block", param: "敏感内容", type: "content_filter" },
          request_id: "req-1",
        }),
      }),
    })
    expect(parsed.type).toBe("api_error")
    expect(parsed.message).toBe("Request blocked by content moderation: 敏感内容")
  })

  test("maps MiMo 441 risk control to a friendly message", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Severe Violation",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "441", message: "Severe Violation", type: "risk_control" } }),
      }),
    })
    expect(parsed.message).toBe("Request blocked by risk control")
  })

  test("applies friendly gateway mapping for the free mimo provider too", () => {
    const parsed = parseAPICallError({
      providerID: mimo,
      error: apiError({
        message: "Moderation Block",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "421", message: "Moderation Block", type: "content_filter" } }),
      }),
    })
    expect(parsed.message).toBe("Request blocked by content moderation")
  })

  test("appends param detail when message is generic (Param Incorrect)", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Param Incorrect",
        statusCode: 400,
        responseBody: JSON.stringify({
          error: { code: "400", message: "Param Incorrect", param: "Not supported model xxx" },
        }),
      }),
    })
    expect(parsed.message).toBe("Param Incorrect: Not supported model xxx")
  })

  test("does not duplicate when param equals message", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Invalid Token",
        statusCode: 401,
        responseBody: JSON.stringify({ error: { code: "401", message: "Invalid Token", param: "Invalid Token" } }),
      }),
    })
    expect(parsed.message).toBe("Invalid Token")
  })

  test("leaves other providers' error flow completely untouched (robustness)", () => {
    const parsed = parseAPICallError({
      providerID: openai,
      error: apiError({
        message: "Moderation Block",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "421", message: "Moderation Block", param: "x" } }),
      }),
    })
    // gateway-specific code mapping and param enrichment are scoped to MiMo
    expect(parsed.message).toBe("Moderation Block")
  })

  test("handles Anthropic-style body without code/param without crashing", () => {
    const parsed = parseAPICallError({
      providerID: ProviderID.make("anthropic"),
      error: apiError({
        message: "Overloaded",
        statusCode: 529,
        responseBody: JSON.stringify({ error: { type: "overloaded_error", message: "Overloaded" } }),
      }),
    })
    expect(parsed.message).toBe("Overloaded")
  })

  test("non-JSON response body does not corrupt a distinct SDK message", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({ message: "Connection failed", statusCode: 500, responseBody: "upstream timeout" }),
    })
    expect(parsed.type).toBe("api_error")
    expect(parsed.message).toBe("Connection failed")
  })

  test("uses the body message + param when SDK message is the generic status text", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Bad Request",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "400", message: "Invalid request", param: "field x" } }),
      }),
    })
    expect(parsed.message).toBe("Invalid request: field x")
  })

  test("still detects context overflow from error.code", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "Request failed",
        statusCode: 400,
        responseBody: JSON.stringify({ error: { code: "context_length_exceeded", message: "too long" } }),
      }),
    })
    expect(parsed.type).toBe("context_overflow")
  })

  test("empty SDK message falls back to structured body message", () => {
    const parsed = parseAPICallError({
      providerID: xiaomi,
      error: apiError({
        message: "",
        statusCode: 402,
        responseBody: JSON.stringify({
          error: { code: "402", message: "Insufficient account balance", type: "insufficient_balance" },
        }),
      }),
    })
    expect(parsed.message).toBe("Insufficient account balance")
  })
})
