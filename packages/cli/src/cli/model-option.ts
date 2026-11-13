// yargs turns a repeated string option into an array despite `type: "string"`,
// e.g. a shell alias that already passes `-m` plus an explicit one. Every caller
// treats the model as a single `provider/model` string, so the last occurrence
// wins, matching the usual CLI override semantics.
function lastValue(value: string | string[] | undefined) {
  return Array.isArray(value) ? value.at(-1) : value
}

export const modelOption = {
  type: "string",
  alias: ["m"],
  describe: "model to use in the format of provider/model",
  coerce: lastValue,
} as const
