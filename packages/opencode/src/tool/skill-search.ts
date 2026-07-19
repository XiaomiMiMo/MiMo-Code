import z from "zod"
import { Effect } from "effect"
import { Ripgrep } from "../file/ripgrep"
import { Flag } from "../flag/flag"
import { Skill } from "../skill"
import { searchSkills } from "../skill/search"
import * as Tool from "./tool"
import { renderSkillContent } from "./skill-content"

const Parameters = z.object({
  query: z
    .string()
    .describe(
      "Rewritten skill query containing the action, input, desired output, and audience when those details are available.",
    ),
})

export const SkillSearchTool = Tool.define(
  "skill_search",
  Effect.gen(function* () {
    const skill = yield* Skill.Service
    const rg = yield* Ripgrep.Service

    return {
      description: [
        "Search the available non-Compose skills using exact ID/name/alias matching and BM25 relevance.",
        "On the user's first query, call this tool when the task might benefit from a specialized workflow.",
        "Include: action, input, desired output, and audience. Omit dimensions the user did not provide.",
        "An exact high-confidence match is loaded automatically; uncertain matches are returned for you to assess.",
      ].join("\n"),
      parameters: Parameters,
      execute: (params: z.infer<typeof Parameters>, ctx: Tool.Context) =>
        Effect.gen(function* () {
          const all = yield* skill.all()
          const results = searchSkills(params.query, all)
          if (results.length === 0) {
            return {
              title: "No matching skill",
              output: JSON.stringify({ status: "no_match", results: [], loaded_skill_id: null }, null, 2),
              metadata: { status: "no_match", loadedSkillID: null as string | null },
            }
          }
          const loaded =
            results[0].score >= Flag.MIMOCODE_SKILL_SEARCH_AUTO_LOAD_THRESHOLD
              ? all.find((item) => item.name === results[0].skill_id)
              : undefined
          const payload = {
            status: "matched",
            results,
            loaded_skill_id: loaded?.name ?? null,
          }
          if (!loaded) {
            return {
              title: `Found ${results.length} skill${results.length === 1 ? "" : "s"}`,
              output: JSON.stringify(payload, null, 2),
              metadata: { status: "matched", loadedSkillID: null as string | null },
            }
          }
          yield* ctx.ask({
            permission: "skill",
            patterns: [loaded.name],
            always: [loaded.name],
            metadata: {},
          })
          const rendered = yield* renderSkillContent(loaded, rg, ctx.abort)

          return {
            title: `Loaded skill: ${loaded.name}`,
            output: [JSON.stringify(payload, null, 2), "", rendered.output].join("\n"),
            metadata: { status: "matched", loadedSkillID: loaded.name },
          }
        }).pipe(Effect.orDie),
    }
  }),
)
