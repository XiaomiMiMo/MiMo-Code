import fs from "fs/promises"
import path from "path"
import { SessionID } from "./schema"
import { ProjectID } from "@/project/schema"
import {
  metaDir,
  checkpointPath,
  memoryPath,
} from "./checkpoint-paths"
import {
  validateSnapshot,
  validateLearning,
  validateMemory,
  validateProgress,
  validateBudget,
  validateBudgetSections,
  extractTitlesFromLearning,
  type Violation,
} from "./checkpoint-validator"
import { CHECKPOINT_SECTION_BUDGETS, MEMORY_SECTION_BUDGETS } from "./checkpoint-templates"

/**
 * Returns the set of every Discovered-section title currently present in
 * the single `checkpoint.md` file. In v5, checkpoints are not numbered —
 * the writer overwrites `checkpoint.md` each pass (carrying forward prior
 * entries), so all titles in the file represent "prior" knowledge the
 * validator can use for de-duplication.
 */
export async function loadPriorDiscoveredTitles(
  sessionID: SessionID,
): Promise<Set<string>> {
  const text = await Bun.file(checkpointPath(sessionID)).text().catch(() => "")
  if (!text) return new Set()
  return new Set(extractTitlesFromLearning(text))
}

/**
 * Read the single-file checkpoint artifacts and run their validators.
 * Caller passes pre-computed `priorTitles` and `expectedRevisions` so they
 * are not re-read on each retry attempt.
 *
 * Used by `tryStartCheckpointWriter`'s validate-retry loop.
 */
export async function runValidatorsForCkpt(
  sessionID: SessionID,
  injected: {
    priorTitles: Set<string>
    expectedRevisions: { id: string; expectedText: string }[]
    projectID: ProjectID
    budgets?: { checkpoint: number; memory: number; progress_per_task: number }
  },
): Promise<Violation[]> {
  const checkpointContent = await Bun.file(checkpointPath(sessionID)).text().catch(() => "")
  const memoryContent = await Bun.file(memoryPath(injected.projectID)).text().catch(() => "")

  const violations: Violation[] = []

  if (checkpointContent) {
    violations.push(...validateSnapshot(checkpointContent, "checkpoint.md"))
    violations.push(...validateLearning(checkpointContent, "checkpoint.md", injected.priorTitles))
  } else {
    violations.push({
      file: "checkpoint.md",
      rule: "topic-missing",
      severity: "error",
      detail: `checkpoint file did not exist after writer finished`,
    })
  }

  if (memoryContent && injected.expectedRevisions.length > 0) {
    violations.push(...validateMemory(memoryContent, injected.expectedRevisions))
  }

  // Budget validation (v5)
  const budgets = injected.budgets ?? { checkpoint: 11_000, memory: 10_000, progress_per_task: 6_000 }

  if (checkpointContent) {
    violations.push(...validateBudget(checkpointContent, budgets.checkpoint, "checkpoint.md"))
  }

  if (memoryContent) {
    violations.push(...validateBudget(memoryContent, budgets.memory, "MEMORY.md"))
  }

  // Per-section budget validation (v5)
  if (checkpointContent) {
    violations.push(...validateBudgetSections(checkpointContent, CHECKPOINT_SECTION_BUDGETS, "checkpoint.md"))
  }
  if (memoryContent) {
    violations.push(...validateBudgetSections(memoryContent, MEMORY_SECTION_BUDGETS, "MEMORY.md"))
  }

  return violations
}

/**
 * Validate every present `tasks/<id>/progress.md` once. Hoisted out of the
 * retry loop because progress.md doesn't change between retry attempts
 * (the writer is busy fixing checkpoint/memory at that point) and
 * `next-filler` warnings on stale unrelated tasks are noise the writer
 * can't fix on retry anyway.
 *
 * TODO: filter by mtime > interval-start so we don't surface stale warnings
 * for tasks not touched in this interval at all.
 */
export async function runTaskProgressValidators(sessionID: SessionID): Promise<Violation[]> {
  const violations: Violation[] = []
  const taskMemRoot = path.join(metaDir(sessionID), "tasks")
  const taskDirs = await fs.readdir(taskMemRoot).catch(() => [] as string[])
  for (const tid of taskDirs) {
    const progPath = path.join(taskMemRoot, tid, "progress.md")
    const prog = await fs.readFile(progPath, "utf-8").catch(() => "")
    if (prog) {
      violations.push(...validateProgress(prog, `tasks/${tid}/progress.md`))
    }
  }
  return violations
}

/**
 * Rename `checkpoint.md` to `checkpoint.invalid.md` to mark it as
 * failed-validation. File persists on disk for post-mortem inspection.
 */
export async function quarantineCheckpoint(
  sessionID: SessionID,
): Promise<void> {
  const dir = metaDir(sessionID)
  const from = path.join(dir, `checkpoint.md`)
  const to = path.join(dir, `checkpoint.invalid.md`)
  await fs.rename(from, to).catch(() => {}) // tolerate writer never produced one
}

/**
 * Build the system-reminder body that the writer subagent receives on a
 * validation-failure retry. Errors are grouped by file; each error's
 * `detail` becomes a bullet under the file's heading. Followed by the
 * absolute paths the writer must Edit/Read.
 *
 * Used by the validate-retry loop in `tryStartCheckpointWriter` (Task 13).
 */
export function buildReflectionMessage(
  errors: Violation[],
  paths: { checkpoint: string; memory: string },
): string {
  const grouped = new Map<string, string[]>()
  for (const e of errors) {
    const list = grouped.get(e.file) ?? []
    list.push(`- ${e.detail}`)
    grouped.set(e.file, list)
  }
  const sections = [...grouped.entries()].map(
    ([file, lines]) => `${file}:\n${lines.join("\n")}`,
  )
  return [
    "<system-reminder>",
    "The previous attempt at this checkpoint had validation errors. Read your output at the absolute paths below, fix ONLY the issues listed, and write again. Other content may stay the same.",
    "",
    sections.join("\n\n"),
    "",
    `CHECKPOINT_PATH = ${paths.checkpoint}`,
    `MEMORY_PATH     = ${paths.memory}`,
    "</system-reminder>",
  ].join("\n")
}

/**
 * Build a reflection prompt for extract-required budget violations. Instructs
 * the writer to split over-budget files into spillover files rather than
 * fixing structural errors.
 */
export function buildExtractionReflection(violations: Violation[]): string {
  const overBudget = violations.filter((v) => v.severity === "extract-required")
  const files = overBudget.map((v) => `${v.file} (${v.detail})`).join(", ")
  return `EXTRACTION REQUIRED: The following files exceed their token budget: ${files}.

Extract the LESS-IMPORTANT topic cluster from the over-budget file into a new spillover file:
  - Checkpoint spillover: checkpoint-<topic>.md (sibling of checkpoint.md)
  - Memory spillover: MEMORY-<topic>.md (sibling of MEMORY.md)

Selection criteria for "less important" (extract THESE first):
  - Already-stable decisions unlikely to be revisited
  - Dead ends before Discovered entries
  - Historical / completed steps before recent / in-progress
  - Topics not directly relevant to the current focus task

After extraction, edit the main file to:
  - REMOVE the extracted lines
  - INSERT an index line near the bottom:
    "- See <spillover-filename>.md (N entries) — short summary"

Re-validation will run after this single extraction.`
}
