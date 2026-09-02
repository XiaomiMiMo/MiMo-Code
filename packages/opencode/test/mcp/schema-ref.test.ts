import { describe, expect, test } from "bun:test"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation"
import { ResilientSchemaValidator } from "../../src/mcp/client"

// An output schema whose $ref points at a $defs entry it never defines — the
// dangling reference Google Stitch's upload_design_md ships, which made ajv throw
// while the SDK compiled the schema and dropped every tool on the server (#1652).
const danglingOutputSchema: JsonSchemaType = {
  type: "object",
  properties: { screens: { type: "array", items: { $ref: "#/$defs/ScreenInstance" } } },
}

describe("MCP tool-schema validation tolerates an unresolvable $ref (#1652)", () => {
  test("the SDK's default validator throws on a dangling $ref (root cause)", () => {
    expect(() => new AjvJsonSchemaValidator().getValidator(danglingOutputSchema)).toThrow(/resolve reference/)
  })

  test("ResilientSchemaValidator turns the throw into a skipped (accept-all) validation", () => {
    const validate = new ResilientSchemaValidator().getValidator(danglingOutputSchema)
    expect(validate({ screens: [] }).valid).toBe(true)
  })

  test("ResilientSchemaValidator keeps strict validation for schemas ajv can compile", () => {
    const validate = new ResilientSchemaValidator().getValidator({
      type: "object",
      $defs: { Screen: { type: "object", properties: { id: { type: "string" } } } },
      properties: { screen: { $ref: "#/$defs/Screen" } },
      required: ["screen"],
    })
    expect(validate({ screen: { id: "x" } }).valid).toBe(true)
    expect(validate({ screen: "not-an-object" }).valid).toBe(false)
  })

  test("separate validators keep isolated ajv caches (createClient builds one per client)", () => {
    // Two schemas reusing the same $id but different shapes. createClient() gives
    // each client its own ResilientSchemaValidator; a shared ajv would let the
    // second reuse the first's cached $id and mis-validate, so the per-client
    // instances must stay independent.
    const schemaA: JsonSchemaType = {
      $id: "urn:mimo:test:result",
      type: "object",
      properties: { a: { type: "number" } },
      required: ["a"],
    }
    const schemaB: JsonSchemaType = {
      $id: "urn:mimo:test:result",
      type: "object",
      properties: { b: { type: "string" } },
      required: ["b"],
    }
    const validateA = new ResilientSchemaValidator().getValidator(schemaA)
    const validateB = new ResilientSchemaValidator().getValidator(schemaB)
    expect(validateA({ a: 1 }).valid).toBe(true)
    expect(validateB({ b: "x" }).valid).toBe(true)
    expect(validateB({ a: 1 }).valid).toBe(false)
  })
})
