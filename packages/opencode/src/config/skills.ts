import { Schema } from "effect"
import { zod } from "@/util/effect-zod"
import { withStatics } from "@/util/schema"

export const Sources = Schema.Struct({
  builtin: Schema.optional(Schema.Boolean).annotate({
    description: "Load skills bundled with the mimocode binary. Defaults to true.",
  }),
  compose: Schema.optional(Schema.Boolean).annotate({
    description: "Load MiMoCode Compose skills bundled with the mimocode binary. Defaults to true.",
  }),
  claude: Schema.optional(Schema.Boolean).annotate({
    description: "Scan .claude/skills in the home directory and the project tree. Defaults to true.",
  }),
  agents: Schema.optional(Schema.Boolean).annotate({
    description: "Scan .agents/skills in the home directory and the project tree. Defaults to true.",
  }),
  codex: Schema.optional(Schema.Boolean).annotate({
    description: "Scan .codex/skills in the home directory and the project tree. Defaults to true.",
  }),
  opencode: Schema.optional(Schema.Boolean).annotate({
    description: "Scan .opencode/skills in the home directory and the project tree. Defaults to true.",
  }),
})
export type Sources = Schema.Schema.Type<typeof Sources>

export const Info = Schema.Struct({
  sources: Schema.optional(Sources).annotate({
    description: "Enable or disable the default skill sources scanned on startup",
  }),
  paths: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "Additional paths to skill folders",
  }),
  urls: Schema.optional(Schema.Array(Schema.String)).annotate({
    description: "URLs to fetch skills from (e.g., https://example.com/.well-known/skills/)",
  }),
}).pipe(withStatics((s) => ({ zod: zod(s) })))

export type Info = Schema.Schema.Type<typeof Info>

export * as ConfigSkills from "./skills"
