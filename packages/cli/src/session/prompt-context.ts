import z from "zod"
import type { PromptConfig } from "./session"

/** An explicit base prevents migration from retaining legacy mixed-in instructions. */
export const PromptContext = z.object({
  system: z.string(),
  systemMode: z.enum(["append", "replace-agent"]),
  instructions: z.string(),
}).strict().meta({ ref: "PromptContext" })
export type PromptContext = z.infer<typeof PromptContext>

export const PROMPT_CONTEXT_VERSION = 1

/** Message-owned context never changes the session's legacy first-user configuration. */
export function promptForUser(prompt: PromptConfig, user: { promptContext?: PromptContext }): PromptConfig {
  return user.promptContext
    ? { ...prompt, system: user.promptContext.system, systemMode: user.promptContext.systemMode }
    : prompt
}
