import { describe, expect, test } from "bun:test"
import { CallToolResultSchema, type CallToolResult } from "@modelcontextprotocol/sdk/types.js"
import { normalizeToolResult } from "../../src/mcp/tool-result"

function parseResult(result: CallToolResult) {
  return CallToolResultSchema.parse(result)
}

describe("MCP tool result normalization", () => {
  test("preserves standard fields and classifies tool execution errors", () => {
    const result: CallToolResult = {
      content: [
        { type: "text", text: "Message was not sent" },
        { type: "image", data: "Zm9v", mimeType: "image/png" },
      ],
      structuredContent: { sent: false, reason: "composer rejected the request" },
      isError: true,
      _meta: { traceId: "private-trace-id" },
    }

    const received = parseResult(result)
    const normalized = normalizeToolResult(received)

    expect(received).toEqual(result)
    expect(normalized.isError).toBe(true)
    expect(normalized.content).toEqual(result.content)
    expect(normalized.output).toBe(
      'Message was not sent\n\nStructured content:\n{"sent":false,"reason":"composer rejected the request"}',
    )
    expect(normalized.attachments).toEqual([
      {
        mime: "image/png",
        url: "data:image/png;base64,Zm9v",
      },
    ])
    expect(normalized.metadata.mcp).toEqual({
      structuredContent: result.structuredContent,
      isError: true,
      _meta: result._meta,
    })
    expect(normalized.output).not.toContain("private-trace-id")
  })

  test("uses structured content as a fallback without exposing _meta", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "   " }],
      structuredContent: { changed: true, windowID: 42 },
      _meta: { privateToken: "do-not-send-to-model" },
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.isError).toBe(false)
    expect(normalized.output).toBe('{"changed":true,"windowID":42}')
    expect(normalized.output).not.toContain("do-not-send-to-model")
    expect(normalized.metadata.mcp).toEqual({
      structuredContent: result.structuredContent,
      isError: false,
      _meta: result._meta,
    })
  })

  test("converts inline media and resource links while retaining raw content", () => {
    const png = "iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNk+M9QDwADhgGAWjR9awAAAABJRU5ErkJggg=="
    const result: CallToolResult = {
      content: [
        { type: "audio", data: "YXVkaW8=", mimeType: "audio/wav" },
        {
          type: "resource",
          resource: {
            uri: "mcp://diagnostic.txt",
            text: "Resource diagnostic",
            mimeType: "text/plain",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "mcp://screenshot.png",
            blob: png,
            mimeType: "image/png",
          },
        },
        {
          type: "resource",
          resource: {
            uri: "mcp://diagnostic.bin",
            blob: "AAE=",
          },
        },
        { type: "resource_link", uri: "file:///tmp/report.txt", name: "report" },
      ],
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe("Resource diagnostic\n\nreport: file:///tmp/report.txt")
    expect(normalized.attachments).toEqual([
      {
        mime: "audio/wav",
        url: "data:audio/wav;base64,YXVkaW8=",
      },
      {
        mime: "image/png",
        url: `data:image/png;base64,${png}`,
        filename: "mcp://screenshot.png",
      },
      {
        mime: "application/octet-stream",
        url: "data:application/octet-stream;base64,AAE=",
        filename: "mcp://diagnostic.bin",
      },
    ])
    expect(normalized.output).not.toContain(png)
    expect(normalized.output).not.toContain("AAE=")
    expect(normalized.content).toEqual(result.content)
  })

  test("does not duplicate structured content already serialized by the server", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: 'Result:\n{\n  "changed": true\n}' }],
      structuredContent: { changed: true },
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe('Result:\n{\n  "changed": true\n}')
  })

  test("extracts base64 data resource links without exposing their payload as text", () => {
    const payload = "AQIDBAUGBwgJ"
    const result: CallToolResult = {
      content: [
        {
          type: "resource_link",
          uri: `data:application/octet-stream;base64,${payload}`,
          name: "binary",
        },
        {
          type: "resource_link",
          uri: "data:text/plain,secret-payload",
          name: "inline text",
        },
      ],
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe(
      "binary: [inline application/octet-stream resource]\n\ninline text: [data URI omitted]",
    )
    expect(normalized.output).not.toContain(payload)
    expect(normalized.output).not.toContain("secret-payload")
    expect(normalized.attachments).toEqual([
      {
        mime: "application/octet-stream",
        url: `data:application/octet-stream;base64,${payload}`,
        filename: "binary",
      },
    ])
  })

  test("does not mistake a short JSON substring for serialized structured content", () => {
    const result: CallToolResult = {
      content: [{ type: "text", text: "Processed an empty {} template" }],
      structuredContent: {},
    }

    const normalized = normalizeToolResult(parseResult(result))

    expect(normalized.output).toBe("Processed an empty {} template\n\nStructured content:\n{}")
  })
})
