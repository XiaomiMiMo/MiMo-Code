import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Info = Schema.Struct({
  docs: Schema.optional(Schema.String).annotate({
    description: "Directory where compose skills save specs, plans, and reports. Relative paths resolve against the project root. Defaults to docs/compose.",
  }),
  docs_absolute: Schema.optional(Schema.Boolean).annotate({
    description:
      "Whether the docs directory injected into the compose prompt is an absolute path. When true (default), a relative `docs` is resolved against the active worktree root so it is unambiguous regardless of the agent's working directory. When false, the relative `docs` value is passed through verbatim. Ignored when `docs` is already absolute.",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export const DEFAULT_DOCS_DIR = "docs/compose"

export * as ConfigCompose from "./compose"
