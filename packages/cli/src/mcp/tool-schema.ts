import Ajv from "ajv"
import Ajv2019 from "ajv/dist/2019.js"
import Ajv2020 from "ajv/dist/2020.js"
import addFormats from "ajv-formats"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaType } from "@modelcontextprotocol/sdk/validation"

/** MCP defaults to Draft 2020-12; explicitly declared older dialects retain their semantics. */
export function toolInputValidator(schema: JsonSchemaType) {
  const options = { strict: false, allErrors: true }
  const dialect = schema.$schema
  const ajv = dialect?.includes("draft-07")
    ? new Ajv(options)
    : dialect?.includes("2019-09")
      ? new Ajv2019(options)
      : new Ajv2020(options)
  addFormats(ajv)
  // A validator belongs to one tool, so another server cannot reuse its $id.
  return new AjvJsonSchemaValidator(ajv).getValidator<Record<string, unknown>>(schema)
}
