import { Schema } from "effect"
import { zod } from "@/util/effect-zod"

/**
 * Defaults for `mimo llm-server` token lifetimes.
 *
 * Durations are strings (`30m`, `1d`, `none`) rather than numbers because the unit
 * is the interesting part and a bare `86400000` in a config file is unreadable.
 * `none` means no limit and is spelled out so that "unlimited" is a deliberate
 * choice rather than the result of omitting a field.
 */
export class LLMServer extends Schema.Class<LLMServer>("LLMServerConfig")({
  ttl: Schema.optional(Schema.String).annotate({
    description:
      "Default sliding lifetime for issued tokens, measured from last use (e.g. '30m', '12h', '1d', or 'none'). Default '1d'.",
  }),
  maxAge: Schema.optional(Schema.String).annotate({
    description:
      "Absolute ceiling from issue, regardless of activity (e.g. '7d', or 'none'). Default 'none', so an actively used token is not cut off.",
  }),
}) {
  static readonly zod = zod(this)
}

export * as ConfigLLMServer from "./llm-server"
