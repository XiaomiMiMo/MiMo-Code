import { describe, expect, test } from "bun:test"
import type { JSONSchema7 } from "@ai-sdk/provider"
import {
  canonical,
  normalizeInput,
  repairToolCall,
  resolveName,
} from "../../src/util/tool-compat"

describe("util.tool-compat", () => {
  describe("canonical", () => {
    test("collapses naming conventions", () => {
      expect(canonical("file_path")).toBe("filepath")
      expect(canonical("filePath")).toBe("filepath")
      expect(canonical("FilePath")).toBe("filepath")
      expect(canonical("apply_patch")).toBe("applypatch")
      expect(canonical("ApplyPatch")).toBe("applypatch")
      expect(canonical("read")).toBe("read")
      expect(canonical("Read")).toBe("read")
    })
  })

  describe("resolveName", () => {
    const tools = ["read", "write", "apply_patch", "multi_edit"] as const

    test("returns exact matches unchanged", () => {
      expect(resolveName("read", tools)).toBe("read")
      expect(resolveName("apply_patch", tools)).toBe("apply_patch")
    })

    test("matches PascalCase and camelCase tool names", () => {
      expect(resolveName("Read", tools)).toBe("read")
      expect(resolveName("ApplyPatch", tools)).toBe("apply_patch")
      expect(resolveName("MultiEdit", tools)).toBe("multi_edit")
    })

    test("returns undefined for unknown tools", () => {
      expect(resolveName("grep", tools)).toBeUndefined()
    })
  })

  describe("normalizeInput", () => {
    const readSchema = {
      type: "object",
      properties: {
        file_path: { type: "string" },
        offset: { type: "number" },
        limit: { type: "number" },
      },
    } satisfies JSONSchema7

    test("maps camelCase and PascalCase keys to snake_case schema keys", () => {
      expect(normalizeInput({ filePath: "/tmp/a.ts" }, readSchema)).toEqual({ file_path: "/tmp/a.ts" })
      expect(normalizeInput({ FilePath: "/tmp/a.ts", Offset: 3 }, readSchema)).toEqual({
        file_path: "/tmp/a.ts",
        offset: 3,
      })
    })

    test("preserves exact schema keys", () => {
      expect(normalizeInput({ file_path: "/tmp/a.ts", limit: 10 }, readSchema)).toEqual({
        file_path: "/tmp/a.ts",
        limit: 10,
      })
    })

    test("prefers exact keys when both variants are present", () => {
      expect(normalizeInput({ file_path: "/exact", filePath: "/alias" }, readSchema)).toEqual({
        file_path: "/exact",
      })
    })

    test("prefers exact keys regardless of iteration order", () => {
      expect(normalizeInput({ filePath: "/alias", file_path: "/exact" }, readSchema)).toEqual({
        file_path: "/exact",
      })
    })

    test("recursively normalizes nested object properties", () => {
      const schema = {
        type: "object",
        properties: {
          file_path: { type: "string" },
          edits: {
            type: "array",
            items: {
              type: "object",
              properties: {
                old_string: { type: "string" },
                new_string: { type: "string" },
                replace_all: { type: "boolean" },
              },
            },
          },
        },
      } satisfies JSONSchema7

      expect(
        normalizeInput(
          {
            filePath: "/tmp/a.ts",
            edits: [
              { oldString: "a", newString: "b" },
              { OldString: "c", NewString: "d", replaceAll: true },
            ],
          },
          schema,
        ),
      ).toEqual({
        file_path: "/tmp/a.ts",
        edits: [
          { old_string: "a", new_string: "b" },
          { old_string: "c", new_string: "d", replace_all: true },
        ],
      })
    })

    test("normalizes through allOf branches", () => {
      const schema: JSONSchema7 = {
        type: "object",
        allOf: [
          {
            type: "object",
            properties: {
              file_path: { type: "string" },
            },
          },
          {
            type: "object",
            properties: {
              line_count: { type: "number" },
            },
          },
        ],
      }

      expect(normalizeInput({ filePath: "/tmp/a.ts", lineCount: 42 }, schema)).toEqual({
        file_path: "/tmp/a.ts",
        line_count: 42,
      })
    })

    test("leaves nested values untouched when no child schema is defined", () => {
      const schema = {
        type: "object",
        properties: {
          payload: {},
        },
      } satisfies JSONSchema7

      const payload = { someField: "value" }
      expect(normalizeInput({ payload }, schema)).toEqual({ payload })
    })
  })

  describe("repairToolCall", () => {
    const readSchema = {
      type: "object",
      properties: {
        file_path: { type: "string" },
      },
    } satisfies JSONSchema7

    test("repairs tool name and input keys together", async () => {
      const repaired = await repairToolCall({
        toolName: "Read",
        input: JSON.stringify({ filePath: "/tmp/a.ts" }),
        toolNames: ["read", "write"],
        getSchema: () => readSchema,
      })

      expect(repaired).toEqual({
        toolName: "read",
        input: JSON.stringify({ file_path: "/tmp/a.ts" }),
      })
    })

    test("returns undefined when nothing changed", async () => {
      const repaired = await repairToolCall({
        toolName: "read",
        input: JSON.stringify({ file_path: "/tmp/a.ts" }),
        toolNames: ["read"],
        getSchema: () => readSchema,
      })

      expect(repaired).toBeUndefined()
    })
  })
})
