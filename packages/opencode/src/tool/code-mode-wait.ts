import z from "zod"
import { Effect } from "effect"
import * as Tool from "./tool"
import { waitCell } from "./code-mode-cell"

const Parameters = z.object({
  cell_id: z.string().describe("Identifier of the running exec cell."),
  yield_time_ms: z.number().optional().describe("Wait before yielding more output. Defaults to 10000 ms."),
  max_tokens: z.number().optional().describe("Output token budget for this wait call. Defaults to 10000 tokens."),
  terminate: z.boolean().optional().describe("True stops the running exec cell; false or omitted waits for output."),
})

export const CODE_MODE_WAIT_DESCRIPTION = `Waits on a yielded \`exec\` cell and returns new output or completion.
- Use \`wait\` only after \`exec\` returns \`Script running with cell ID ...\`.
- \`cell_id\` identifies the running \`exec\` cell to resume.
- \`yield_time_ms\` controls how long to wait for more output before yielding again. Defaults to 10000 ms.
- \`max_tokens\` limits how much new output this wait call returns. Defaults to 10000 tokens.
- \`terminate: true\` stops the running cell; false or omitted waits for output.
- \`wait\` returns only the new output since the last yield, or the final completion or termination result for that cell.
- If the cell is still running, \`wait\` may yield again with the same \`cell_id\`.
- If the cell has already finished, \`wait\` returns the remaining output and closes the cell.`

export const CodeModeWaitTool = Tool.define(
  "wait",
  Effect.succeed({
    description: CODE_MODE_WAIT_DESCRIPTION,
    parameters: Parameters,
    execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
      Effect.tryPromise({
        try: () =>
          waitCell({
            sessionID: ctx.sessionID,
            cellID: params.cell_id,
            yieldTimeMs: params.yield_time_ms,
            maxTokens: params.max_tokens,
            terminate: params.terminate,
          }),
        catch: (error) => (error instanceof Error ? error : new Error(String(error))),
      }).pipe(Effect.orDie),
  }),
)
