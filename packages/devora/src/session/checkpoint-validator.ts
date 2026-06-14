import { Token } from "../util"

export type ValidationRule =
  | "topic-missing"
  | "topic-too-long"
  | "topic-anti-pattern-checkpoint-header"
  | "subsection-missing"
  | "subsection-out-of-order"
  | "discovered-duplicate-title"
  | "discovered-missing-why"
  | "discovered-missing-how-to-apply"
  | "next-filler"
  | "directive-not-revised"
  | "meta-malformed-json"
  | "budget-exceeded"
  | "section-budget-exceeded"

export type Violation = {
  file: string
  rule: ValidationRule
  severity: "warn" | "error" | "extract-required"
  detail: string
}

export const TOPIC_MAX_CHARS = 80

export const SNAPSHOT_REQUIRED_SECTIONS = [
  "### Execution context",
  "### Live resources",
  "### Session metadata",
] as const

export const LEARNING_REQUIRED_SECTIONS = [
  "### Discovered",
  "### Dead ends",
] as const

function checkTopicAndSections(
  body: string,
  filename: string,
  requiredSections: readonly string[],
): Violation[] {
  const violations: Violation[] = []
  const firstNonEmptyLine = body.split("\n").find((l) => l.trim().length > 0) ?? ""

  if (/^# Checkpoint #\d+/.test(firstNonEmptyLine)) {
    violations.push({
      file: filename,
      rule: "topic-anti-pattern-checkpoint-header",
      severity: "error",
      detail: `First line is "${firstNonEmptyLine}". Replace with "Topic: <≤80-char one-line summary>" with NO leading "#".`,
    })
  }

  const topicMatch = body.match(/^Topic:\s*(.+?)$/m)
  if (!topicMatch) {
    violations.push({
      file: filename,
      rule: "topic-missing",
      severity: "error",
      detail: `Missing required first-line "Topic: <summary>". Add it as the first non-blank line.`,
    })
  } else {
    const topic = topicMatch[1].trim()
    if (topic.length > TOPIC_MAX_CHARS) {
      violations.push({
        file: filename,
        rule: "topic-too-long",
        severity: "warn",
        detail: `Topic line is ${topic.length} chars (limit ${TOPIC_MAX_CHARS}). Rewrite shorter.`,
      })
    }
  }

  const sectionPositions = requiredSections.map((s) => ({ section: s, idx: body.indexOf(s) }))
  for (const pos of sectionPositions) {
    if (pos.idx === -1) {
      violations.push({
        file: filename,
        rule: "subsection-missing",
        severity: "error",
        detail: `Missing "${pos.section}" sub-section. Add the header (use "(none)" placeholder if no entries).`,
      })
    }
  }
  const presentInOrder = sectionPositions.filter((p) => p.idx !== -1)
  for (let i = 1; i < presentInOrder.length; i++) {
    if (presentInOrder[i].idx < presentInOrder[i - 1].idx) {
      violations.push({
        file: filename,
        rule: "subsection-out-of-order",
        severity: "error",
        detail: `Sub-sections must appear in order: ${requiredSections.join(", ")}.`,
      })
      break
    }
  }
  return violations
}

export function validateSnapshot(body: string, filename: string): Violation[] {
  return checkTopicAndSections(body, filename, SNAPSHOT_REQUIRED_SECTIONS)
}

export function extractDiscoveredEntries(body: string): { title: string; block: string }[] {
  const match = body.match(/^(?:Topic:.*\n+)?### discovered\s*\n([\s\S]*?)(?=\n### |$)/i)
  if (!match) return []
  const block = match[1]
  const entries: { title: string; block: string }[] = []
  const lines = block.split("\n")
  let current: { title: string; lines: string[] } | undefined
  for (const line of lines) {
    const titleMatch = line.match(/^- (.+)$/)
    if (titleMatch) {
      if (current) entries.push({ title: current.title, block: current.lines.join("\n") })
      current = { title: titleMatch[1].trim(), lines: [line] }
    } else if (current) {
      current.lines.push(line)
    }
  }
  if (current) entries.push({ title: current.title, block: current.lines.join("\n") })
  return entries
}

/**
 * Extract the title lines (first line of each top-level bullet) from a
 * Learning markdown's `### Discovered` sub-section. Used by section 8
 * ("learning titles index") of the rebuild context. Mirrors the writer
 * prompt's expectation that every Discovered bullet begins with a
 * grep-friendly ≤80-char title line.
 */
export function extractTitlesFromLearning(md: string): string[] {
  return extractDiscoveredEntries(md).map((e) => e.title)
}

export function validateLearning(
  body: string,
  filename: string,
  priorDiscoveredTitles: Set<string>,
): Violation[] {
  const violations = checkTopicAndSections(body, filename, LEARNING_REQUIRED_SECTIONS)
  const entries = extractDiscoveredEntries(body)
  for (const entry of entries) {
    if (priorDiscoveredTitles.has(entry.title)) {
      violations.push({
        file: filename,
        rule: "discovered-duplicate-title",
        severity: "error",
        detail: `Discovered title "${entry.title}" duplicates a prior checkpoint's title verbatim. Remove this entry or rephrase.`,
      })
    }
    if (!/^\s*Why:/m.test(entry.block)) {
      violations.push({
        file: filename,
        rule: "discovered-missing-why",
        severity: "warn",
        detail: `Discovered entry "${entry.title}" is missing a "Why:" line.`,
      })
    }
    if (!/^\s*How to apply:/m.test(entry.block)) {
      violations.push({
        file: filename,
        rule: "discovered-missing-how-to-apply",
        severity: "warn",
        detail: `Discovered entry "${entry.title}" is missing a "How to apply:" line.`,
      })
    }
  }
  return violations
}

export const NEXT_FILLER_PATTERNS = [
  /^\s*continue\s*$/i,
  /^\s*resume\s*$/i,
  /^\s*keep\s+going\s*$/i,
  /^\s*finish\s+up\s*$/i,
] as const

export function validateMemory(
  body: string,
  expectedRevisions: ReadonlyArray<{ id: string; expectedText: string }>,
): Violation[] {
  const violations: Violation[] = []
  for (const rev of expectedRevisions) {
    if (!body.includes(rev.expectedText)) {
      violations.push({
        file: "MEMORY.md",
        rule: "directive-not-revised",
        severity: "error",
        detail: `Directive ${rev.id} should mention "${rev.expectedText}" per a recent user instruction, but MEMORY.md does not contain that text.`,
      })
    }
  }
  return violations
}

export function validateProgress(body: string, filename: string): Violation[] {
  const violations: Violation[] = []
  const nextLines = body.match(/^\s*-?\s*Next:\s*(.+)$/gm) ?? []
  for (const line of nextLines) {
    const value = line.replace(/^\s*-?\s*Next:\s*/, "")
    if (NEXT_FILLER_PATTERNS.some((re) => re.test(value))) {
      violations.push({
        file: filename,
        rule: "next-filler",
        severity: "warn",
        detail: `"Next: ${value.trim()}" is filler. Replace with a concrete action (function name, file:line, exact command).`,
      })
    }
  }
  return violations
}

export function validateBudget(content: string, budget: number, filename: string): Violation[] {
  const tokens = Token.estimate(content)
  if (tokens <= budget) return []
  return [
    {
      file: filename,
      rule: "budget-exceeded",
      severity: "extract-required",
      detail: `${tokens} tokens > ${budget} budget`,
    },
  ]
}

export function validateBudgetSections(
  content: string,
  budgets: Record<string, number>,
  filename: string,
): Violation[] {
  const violations: Violation[] = []
  // Parse sections by "## " header
  const sectionRe = /^## (.+)$/gm
  const matches: { title: string; index: number }[] = []
  let m: RegExpExecArray | null
  while ((m = sectionRe.exec(content)) !== null) {
    matches.push({ title: m[1].trim(), index: m.index })
  }

  for (let i = 0; i < matches.length; i++) {
    const start = matches[i].index
    const end = i + 1 < matches.length ? matches[i + 1].index : content.length
    const sectionText = content.slice(start, end)
    const sectionTitle = matches[i].title
    const budget = budgets[sectionTitle]
    if (budget == null) continue
    const tokens = Token.estimate(sectionText)
    if (tokens > budget) {
      violations.push({
        file: filename,
        rule: "section-budget-exceeded",
        severity: "extract-required",
        detail: `section "${sectionTitle}" is ${tokens} tokens (budget ${budget})`,
      })
    }
  }
  return violations
}
