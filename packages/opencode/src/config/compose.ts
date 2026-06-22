import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Info = Schema.Struct({
  docs: Schema.optional(Schema.String).annotate({
    description: "Directory where compose skills save specs, plans, and reports. Relative paths resolve against the project root. Defaults to docs/compose.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_DOCS_DIR = "docs/compose"

export * as ConfigCompose from "./compose"
