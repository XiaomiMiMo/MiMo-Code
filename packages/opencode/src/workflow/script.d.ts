// Built-in workflow scripts are function bodies imported as raw text; see builtin.ts.
// Declaring the extension is what lets those imports carry a real type instead of a
// per-line `@ts-expect-error`.
declare module "*.js.fn" {
  const source: string
  export default source
}
