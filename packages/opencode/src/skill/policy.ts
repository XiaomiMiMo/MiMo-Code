import z from "zod"
import type { Info } from "."

export const VisibilityPolicy = z.object({
  includeMimocodeBundled: z.literal(true),
  allowedDesktopSkillNames: z.array(z.string()),
  explicitlySelectedSkillNames: z.array(z.string()),
})
export type VisibilityPolicy = z.infer<typeof VisibilityPolicy>

export function applyVisibilityPolicy(skills: Info[], policy?: VisibilityPolicy) {
  if (!policy) return skills
  const desktop = new Set(policy.allowedDesktopSkillNames)
  const explicit = new Set(policy.explicitlySelectedSkillNames)
  return skills.filter((skill) => {
    if (explicit.has(skill.name)) return true
    if (skill.disable_model_invocation) return false
    if (policy.includeMimocodeBundled && skill.bundled) return true
    return desktop.has(skill.name)
  })
}
