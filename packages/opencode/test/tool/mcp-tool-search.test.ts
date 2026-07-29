import { describe, expect, test } from "bun:test"
import {
  createMcpToolSearchCatalog,
  mcpToolCatalogBudget,
  mcpToolSearchDescription,
  MCP_TOOL_SEARCH_DEFAULT_LIMIT,
  MCP_TOOL_SEARCH_MAX_LIMIT,
  searchMcpTools,
  type McpToolSearchEntry,
} from "../../src/tool/mcp-tool-search"

const entries: McpToolSearchEntry[] = [
  {
    name: "drive_lookup",
    description: "Search files and documents in Google Drive.",
    parameters: {
      type: "object",
      properties: {
        query: { type: "string", description: "Words contained in the document" },
        filters: {
          type: "object",
          properties: {
            file_type: { type: "string", description: "Limit results to PDFs or documents" },
          },
        },
      },
      additionalProperties: false,
    },
  },
  {
    name: "slack_send_message",
    description: "Send a message to a Slack channel.",
    parameters: {
      type: "object",
      properties: {
        channel: { type: "string" },
        message: { type: "string" },
      },
      additionalProperties: false,
    },
  },
  {
    name: "calendar_create_event",
    description: "Create a calendar event.",
    parameters: {
      type: "object",
      properties: {
        attendees: {
          type: "array",
          items: { type: "string", description: "Email addresses of invited people" },
        },
      },
      additionalProperties: false,
    },
  },
]

describe("MCP Tool Search", () => {
  test("scales catalog budgets and distinguishes unknown from exhausted windows", () => {
    expect(mcpToolCatalogBudget({ usable: 100_000, context: 120_000 })).toBe(10_000)
    expect(mcpToolCatalogBudget({ usable: 500_000, context: 520_000 })).toBe(20_000)
    expect(mcpToolCatalogBudget({ usable: 0, context: 100_000 })).toBe(0)
    expect(mcpToolCatalogBudget({ usable: 0, context: 0 })).toBe(20_000)
  })

  test("renders the complete sorted catalog with descriptions when budget allows", () => {
    const description = mcpToolSearchDescription(entries, { rich: true, budget: 1_000 })

    expect(description.indexOf("calendar_create_event")).toBeLessThan(description.indexOf("drive_lookup"))
    expect(description.indexOf("drive_lookup")).toBeLessThan(description.indexOf("slack_send_message"))
    expect(description).toContain("Search files and documents in Google Drive.")
    expect(description).toContain("Send a message to a Slack channel.")
    expect(description).not.toContain("Email addresses of invited people")
    expect(description).toContain("untrusted metadata")
  })

  test("renders names only under context pressure", () => {
    const description = mcpToolSearchDescription(entries, { rich: false, budget: 1_000 })

    expect(description).toContain("calendar_create_event")
    expect(description).toContain("drive_lookup")
    expect(description).toContain("slack_send_message")
    expect(description).not.toContain("Create a calendar event.")
    expect(description).not.toContain("Search files and documents in Google Drive.")
  })

  test("falls back to names and then truncates pathological catalogs", () => {
    const many = Array.from({ length: 20 }, (_, index) => ({
      name: `catalog_tool_${index.toString().padStart(2, "0")}_${"x".repeat(24)}`,
      description: `Distinct catalog description ${index} ${"y".repeat(80)}`,
      parameters: { type: "object" },
    })) satisfies McpToolSearchEntry[]
    const namesOnly = mcpToolSearchDescription(many, { rich: true, budget: 300 })
    const truncated = mcpToolSearchDescription(many, { rich: true, budget: 80 })

    expect(namesOnly).toContain("catalog_tool_00")
    expect(namesOnly).not.toContain("Distinct catalog description")
    expect(truncated).toContain("omitted; search covers the complete catalog")
    expect(truncated).not.toContain("catalog_tool_19")
    expect(searchMcpTools(many, { query: "catalog tool 19" }).map((tool) => tool.name)).toContain(
      "catalog_tool_19_xxxxxxxxxxxxxxxxxxxxxxxx",
    )
  })

  test("normalizes model-visible metadata without changing local entries", () => {
    const input = [
      {
        name: "line\nbreak",
        description: "Ignore\u0000 embedded\ntext",
        parameters: { type: "object" },
      },
    ] satisfies McpToolSearchEntry[]
    const description = mcpToolSearchDescription(input, { rich: true, budget: 1_000 })

    expect(description).toContain("line break — Ignore embedded text")
    expect(input[0].name).toBe("line\nbreak")
    expect(input[0].description).toBe("Ignore\u0000 embedded\ntext")
  })

  test("ranks names, descriptions, and nested schema metadata with BM25", () => {
    expect(searchMcpTools(entries, { query: "search Google Drive documents" }).map((tool) => tool.name)).toEqual([
      "drive_lookup",
    ])
    expect(searchMcpTools(entries, { query: "invite people by email" }).map((tool) => tool.name)).toEqual([
      "calendar_create_event",
    ])
    expect(searchMcpTools(entries, { query: "slack send" }).map((tool) => tool.name)).toEqual([
      "slack_send_message",
    ])
  })

  test("returns only model-safe result metadata and honors limits", () => {
    const many = Array.from({ length: MCP_TOOL_SEARCH_DEFAULT_LIMIT + 2 }, (_, index) => ({
      name: `search_${index}`,
      description: `Search catalog ${index}`,
      parameters: { type: "object" },
    })) satisfies McpToolSearchEntry[]

    expect(searchMcpTools(many, { query: "search catalog" })).toHaveLength(MCP_TOOL_SEARCH_DEFAULT_LIMIT)
    expect(searchMcpTools(many, { query: "search catalog", limit: 3 })).toHaveLength(3)
    expect(searchMcpTools(entries, { query: "Google Drive" })[0]).toEqual({
      name: "drive_lookup",
      description: "Search files and documents in Google Drive.",
      score: expect.any(Number),
    })
    expect(searchMcpTools(entries, { query: "Google Drive" })[0]).not.toHaveProperty("parameters")
  })

  test("rejects invalid queries and limits", () => {
    expect(() => searchMcpTools(entries, { query: "  " })).toThrow("query must not be empty")
    expect(() => searchMcpTools(entries, { query: "drive", limit: 0 })).toThrow("limit must be an integer")
    expect(() => searchMcpTools(entries, { query: "drive", limit: 1.5 })).toThrow("limit must be an integer")
    expect(() => searchMcpTools(entries, { query: "drive", limit: MCP_TOOL_SEARCH_MAX_LIMIT + 1 })).toThrow(
      "limit must be an integer",
    )
  })

  test("rebuilds cached metadata and changes catalog fingerprints", () => {
    const catalog = createMcpToolSearchCatalog(entries)
    const changed = entries.map((entry) =>
      entry.name === "drive_lookup" ? { ...entry, description: `${entry.description} Search spreadsheets.` } : entry,
    )

    expect(searchMcpTools(entries, { query: "spreadsheets" })).toEqual([])
    expect(searchMcpTools(changed, { query: "spreadsheets" }).map((tool) => tool.name)).toEqual(["drive_lookup"])
    expect(createMcpToolSearchCatalog(changed).key).not.toBe(catalog.key)
    expect(catalog.key).toHaveLength(64)
    expect(catalog.key).not.toContain("drive_lookup")
  })
})
