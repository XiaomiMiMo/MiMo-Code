import type { Skill } from "."
import { Flag } from "../flag/flag"
import { localizedAliases } from "./localized-alias"

export type SearchResult = {
  skill_id: string
  name: string
  score: number
  reason: string
}

function normalize(value: string) {
  return value.toLocaleLowerCase().trim()
}

function explicitlyMentions(query: string, value: string) {
  const normalizedQuery = normalize(query)
  const normalized = normalize(value)
  if (normalizedQuery === normalized) return true
  if (/\p{Script=Han}/u.test(normalized)) return normalizedQuery.includes(normalized)
  return new RegExp(
    `(^|[^\\p{L}\\p{N}])${normalized.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}($|[^\\p{L}\\p{N}])`,
    "u",
  ).test(normalizedQuery)
}

// The four query-structure labels are stripped alongside stopwords so the
// action/input/output/audience template does not dilute domain-term relevance.
const STOP_WORDS = new Set([
  "a",
  "action",
  "an",
  "and",
  "audience",
  "for",
  "from",
  "input",
  "of",
  "output",
  "the",
  "to",
  "with",
])

function tokenize(value: string) {
  return normalize(value)
    .replace(/([\p{Script=Han}]+)/gu, " $1 ")
    .split(/[^\p{L}\p{N}]+/u)
    .filter((token) => token && !STOP_WORDS.has(token))
    .flatMap((token) => {
      if (!/^\p{Script=Han}+$/u.test(token)) {
        return token.length > Flag.MIMOCODE_SKILL_SEARCH_STEM_MIN_LENGTH &&
          token.endsWith("s") &&
          !token.endsWith("ss")
          ? token.slice(0, -1)
          : token
      }
      const chars = [...token]
      if (chars.length === 1) return chars
      return chars.slice(0, -1).map((char, index) => char + chars[index + 1])
    })
}

export function searchSkills(query: string, skills: Skill.Info[]): SearchResult[] {
  const searchable = skills.filter((skill) => !skill.name.startsWith("compose:"))
  const exact = searchable
    .filter((skill) =>
      [skill.name, ...(skill.aliases ?? []), ...localizedAliases(skill)].some((value) =>
        explicitlyMentions(query, value),
      ),
    )
    .map((skill) => ({
      skill_id: skill.name,
      name: skill.name,
      score: Flag.MIMOCODE_SKILL_SEARCH_EXACT_SCORE,
      reason: `The query explicitly mentions the skill ID, name, or alias for ${skill.name}.`,
    }))
  const queryTokens = [...new Set(tokenize(query))]
  const documents = searchable.map((skill) =>
    tokenize([skill.name, ...(skill.aliases ?? []), ...localizedAliases(skill), skill.description].join(" ")),
  )
  // Keep BM25 finite for an empty or entirely non-tokenizable manifest.
  const averageLength = documents.reduce((sum, document) => sum + document.length, 0) / documents.length || 1
  const scores = documents.map((document) =>
    queryTokens.reduce((score, token) => {
      const frequency = document.filter((word) => word === token).length
      if (frequency === 0) return score
      const documentFrequency = documents.filter((words) => words.includes(token)).length
      const inverseDocumentFrequency = Math.log(
        1 +
          (documents.length - documentFrequency + Flag.MIMOCODE_SKILL_SEARCH_BM25_IDF_SMOOTHING) /
            (documentFrequency + Flag.MIMOCODE_SKILL_SEARCH_BM25_IDF_SMOOTHING),
      )
      return (
        score +
        inverseDocumentFrequency *
          ((frequency * (Flag.MIMOCODE_SKILL_SEARCH_BM25_K1 + 1)) /
            (frequency +
              Flag.MIMOCODE_SKILL_SEARCH_BM25_K1 *
                (1 -
                  Flag.MIMOCODE_SKILL_SEARCH_BM25_LENGTH_NORMALIZATION +
                  Flag.MIMOCODE_SKILL_SEARCH_BM25_LENGTH_NORMALIZATION * (document.length / averageLength))))
      )
    }, 0),
  )
  const maximum = Math.max(...scores, 0)
  const bm25 = searchable
    .map((skill, index) => ({
      skill,
      score: scores[index],
      coverage: queryTokens.filter((token) => documents[index].includes(token)).length / (queryTokens.length || 1),
    }))
    .filter((item) => item.score > 0)
    .toSorted((a, b) => b.score - a.score || a.skill.name.localeCompare(b.skill.name))
    .map((item) => ({
      skill_id: item.skill.name,
      name: item.skill.name,
      score: Number(
        (
          (item.score / maximum) * Flag.MIMOCODE_SKILL_SEARCH_BM25_SCORE_WEIGHT +
          item.coverage * Flag.MIMOCODE_SKILL_SEARCH_QUERY_COVERAGE_WEIGHT
        ).toFixed(Flag.MIMOCODE_SKILL_SEARCH_SCORE_PRECISION),
      ),
      reason: `The skill description matches these query terms: ${queryTokens
        .filter((token) => tokenize(item.skill.description).includes(token))
        .join(", ")}.`,
    }))
  const exactIDs = new Set(exact.map((result) => result.skill_id))
  return [...exact, ...bm25.filter((result) => !exactIDs.has(result.skill_id))].slice(
    0,
    Flag.MIMOCODE_SKILL_SEARCH_MAX_RESULTS,
  )
}
