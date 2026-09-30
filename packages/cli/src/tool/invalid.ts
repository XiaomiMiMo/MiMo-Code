import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { RecoverableError } from "./recoverable"

export const InvalidTool = Tool.define(
  "invalid",
  Effect.succeed({
    description: "Do not use",
    parameters: z.object({
      tool: z.string(),
      error: z.string(),
    }),
    execute: (params: { tool: string; error: string }) =>
      Effect.die(new RecoverableError(`The tool call is invalid: ${params.error}`)),
  }),
)
