export * as ConfigHistory from "./history"

import { Schema } from "effect"

export const Kind = Schema.Literals([
  "user_text",
  "assistant_text",
  "tool_input",
  "tool_error",
  "reasoning",
  "tool_output",
])

export const Info = Schema.Struct({
  kinds: Schema.optional(Schema.Array(Kind)).annotate({
    description:
      "Which part kinds the history FTS index should cover. Defaults to text (user/assistant) + tool input + tool errors. Add 'reasoning' or 'tool_output' to grow recall at the cost of database size. Note: enabling 'tool_output' reclassifies completed tools from kind='tool_input' to kind='tool_output' (input remains searchable in the body, but kind:['tool_input'] filter will then only match pending/error tools).",
  }),
})

export type Info = Schema.Schema.Type<typeof Info>
