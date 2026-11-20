import { createHash } from "node:crypto"

// Legacy catalog text: the system-tail block and older user-side snapshots both
// start with this marker. New catalogs are user-turn reminders identified by
// metadata, never by text.
export const SKILL_CATALOG_REMINDER_MARKER = "Skills available in this session:"

export const SKILL_REMINDER_KEY = "skills"
export const SKILL_REMINDER_METADATA_KEY = "skillReminder"

/** Latest announced catalog after this reminder: skill name -> fingerprint. */
export type SkillReminderMeta = {
  kind: "entry" | "delta"
  skills: Record<string, string>
}

export type CatalogSkill = { name: string; description: string; location: string }

export function isSkillCatalogReminder(text: string) {
  return text.includes(SKILL_CATALOG_REMINDER_MARKER)
}

/** A user-side catalog persisted by an older engine (no reminder metadata). */
export function isLegacySkillCatalogPart(part: {
  synthetic?: boolean
  text: string
  metadata?: Record<string, unknown>
}) {
  return !!part.synthetic && !part.metadata?.[SKILL_REMINDER_METADATA_KEY] && isSkillCatalogReminder(part.text)
}

function sha256(value: unknown) {
  return createHash("sha256").update(JSON.stringify(value)).digest("hex")
}

// Only what the model sees in a catalog entry. Body edits are read at load
// time, so they do not need a reminder.
export function skillFingerprint(skill: CatalogSkill) {
  return sha256([skill.name, skill.description, skill.location]).slice(0, 16)
}

export function catalogState(skills: readonly CatalogSkill[]): Record<string, string> {
  return Object.fromEntries(
    skills.map((skill) => [skill.name, skillFingerprint(skill)]).toSorted(([a], [b]) => a.localeCompare(b)),
  )
}

export function skillReminderRev(meta: SkillReminderMeta) {
  return `skills:${meta.kind}:${sha256(Object.entries(meta.skills).toSorted(([a], [b]) => a.localeCompare(b)))}`
}

export function readSkillReminderMeta(value: unknown): SkillReminderMeta | undefined {
  if (!value || typeof value !== "object") return undefined
  if (!("kind" in value) || (value.kind !== "entry" && value.kind !== "delta")) return undefined
  if (!("skills" in value) || !value.skills || typeof value.skills !== "object") return undefined
  const skills: Record<string, string> = {}
  for (const [name, fingerprint] of Object.entries(value.skills)) {
    if (typeof fingerprint !== "string") return undefined
    skills[name] = fingerprint
  }
  return { kind: value.kind, skills }
}

export type SkillCatalogChange =
  | { kind: "entry"; skills: CatalogSkill[]; meta: SkillReminderMeta }
  | { kind: "delta"; changed: CatalogSkill[]; removed: string[]; meta: SkillReminderMeta }

/**
 * Compare the current catalog with the latest announced state. Without an
 * announced state, a non-empty catalog needs an entry; with one, any added,
 * changed, or removed skill needs a delta. Undefined means nothing to inject.
 */
export function diffSkillCatalog(input: {
  announced: Record<string, string> | undefined
  current: readonly CatalogSkill[]
}): SkillCatalogChange | undefined {
  const skills = input.current.toSorted((a, b) => a.name.localeCompare(b.name))
  const state = catalogState(skills)
  if (!input.announced) {
    if (skills.length === 0) return undefined
    return { kind: "entry", skills, meta: { kind: "entry", skills: state } }
  }
  const announced = input.announced
  const changed = skills.filter((skill) => announced[skill.name] !== state[skill.name])
  const removed = Object.keys(announced)
    .filter((name) => !(name in state))
    .toSorted()
  if (changed.length === 0 && removed.length === 0) return undefined
  return { kind: "delta", changed, removed, meta: { kind: "delta", skills: state } }
}

// The legacy system tail held one block: the marker line, then either the
// verbose catalog or the empty-catalog sentence. buildSystemArray joins parts
// with a blank line, so the separator goes with the block.
const LEGACY_SYSTEM_CATALOG =
  /(?:\n\n)?Skills available in this session:\n(?:<available_skills>[\s\S]*?<\/available_skills>|No skills are currently available\.)/

/**
 * Remove a legacy catalog block from a frozen system prompt. A block that the
 * host-supplied system itself contains is host content and stays.
 */
export function stripLegacySkillCatalog(system: readonly string[], hostSystem = ""): string[] {
  return system.map((part) =>
    part.replace(LEGACY_SYSTEM_CATALOG, (block) => (hostSystem.includes(block.trimStart()) ? block : "")),
  )
}
