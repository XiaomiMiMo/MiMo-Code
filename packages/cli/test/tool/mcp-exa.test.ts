import { describe, expect, test } from "bun:test"
import { Effect } from "effect"
import { parseSse } from "../../src/tool/mcp-exa"

const run = (body: string) => Effect.runPromise(parseSse(body))

describe("mcp-exa parseSse", () => {
  test("returns the first text content from SSE data lines", async () => {
    const body = [
      "event: message",
      'data: {"result":{"content":[{"type":"text","text":"Title: Example\\nURL: https://example.com"}]}}',
      "",
    ].join("\n")
    expect(await run(body)).toBe("Title: Example\nURL: https://example.com")
  })

  test("returns an error message for a bare JSON-RPC error body", async () => {
    const body =
      '{"jsonrpc":"2.0","error":{"code":-32602,"message":"Unknown tool: get_code_context_exa","data":{"availableTools":["web_search_exa","web_fetch_exa","agent_run"]}},"id":1}'
    expect(await run(body)).toBe("Exa request failed: Unknown tool: get_code_context_exa (code -32602)")
  })

  test("returns an error message from an SSE data line carrying a JSON-RPC error", async () => {
    const body = 'event: message\ndata: {"error":{"code":-32602,"message":"Unknown tool: get_code_context_exa"}}\n'
    expect(await run(body)).toBe("Exa request failed: Unknown tool: get_code_context_exa (code -32602)")
  })

  test("returns undefined for an unparseable body without data lines", async () => {
    expect(await run("gateway timeout")).toBeUndefined()
  })

  test("returns undefined when no data line carries text content", async () => {
    const body = 'data: {"result":{"content":[]}}\n'
    expect(await run(body)).toBeUndefined()
  })
})
