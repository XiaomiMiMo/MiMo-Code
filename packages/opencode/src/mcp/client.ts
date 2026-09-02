import { Client } from "@modelcontextprotocol/sdk/client/index.js"
import { AjvJsonSchemaValidator } from "@modelcontextprotocol/sdk/validation/ajv"
import type { JsonSchemaType, JsonSchemaValidator, jsonSchemaValidator } from "@modelcontextprotocol/sdk/validation"
import { InstallationVersion } from "../installation/version"
import { Log } from "../util"

const log = Log.create({ service: "mcp" })

// The MCP SDK pre-compiles an ajv validator for every tool's outputSchema right
// after tools/list (Client.cacheToolMetadata). Some servers — e.g. Google Stitch
// — ship a tool whose outputSchema has a $ref ajv can't resolve (a #/$defs/…
// entry the schema never defines), so ajv throws a MissingRefError and the whole
// tools/list rejects, dropping every tool from that server (#1652).
//
// Fail open per tool: keep ajv's strict validation for the schemas it can
// compile, and skip validation for the ones it can't, so a single exotic schema
// no longer wipes out an entire server's tool list.
export class ResilientSchemaValidator implements jsonSchemaValidator {
  private readonly inner = new AjvJsonSchemaValidator()

  getValidator<T>(schema: JsonSchemaType): JsonSchemaValidator<T> {
    // ajv compiles synchronously and throws on a reference it can't resolve, so
    // a sync try/catch is the only way to intercept it before it reaches the SDK.
    try {
      return this.inner.getValidator<T>(schema)
    } catch (error) {
      log.debug("skipping output validation for a tool whose schema could not be compiled", { error })
      // Fall back to an always-true schema so the tool still loads and callable.
      return this.inner.getValidator<T>({})
    }
  }
}

export function createClient(name = "mimocode") {
  // A fresh validator per client keeps each server's ajv schema cache isolated,
  // matching the SDK's own default of one AjvJsonSchemaValidator per Client.
  return new Client({ name, version: InstallationVersion }, { jsonSchemaValidator: new ResilientSchemaValidator() })
}
