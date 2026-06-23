export const meta = {
  name: "compose",
  description:
    "Autonomous compose pipeline — brainstorms context, designs (spec/plan), implements via parallel per-task worktrees with TDD, verifies, reviews, reports, and merges. Bounded retry, never-ask mode.",
  whenToUse:
    "Use to drive a feature, bugfix, refactor, or review-feedback task through the full compose flow without user prompting. Pass args.task = the user's request. Optionally args.type to skip classification, args.feature_name for the report filename, args.skip_brainstorm / args.skip_report to drop those phases, args.maxConcurrent to bound per-batch parallelism.",
  phases: [
    { title: "Brainstorm", detail: "Context recon (never-ask): conventions, recent changes, relevant files" },
    { title: "Classify", detail: "Decide task type (feature/bugfix/refactor/feedback)" },
    { title: "Design", detail: "Apply compose:plan, compose:debug, or compose:feedback; emit task list with deps" },
    { title: "Implement", detail: "Topo-sorted batches, each task in its own worktree (compose:tdd), then integrate" },
    { title: "Verify", detail: "Run project verify commands; structured pass/fail" },
    { title: "Review", detail: "compose:review for critical/important/minor issues" },
    { title: "Report", detail: "compose:report per-iteration + final consolidated report" },
    { title: "Merge", detail: "compose:merge to commit (and optionally push/PR)" },
  ],
}

const MAX_TDD_ATTEMPTS = 3
const MAX_REVIEW_FIX_ATTEMPTS = 2
const DEFAULT_MAX_CONCURRENT = 8

const BRAINSTORM_SHAPE = {
  type: "object",
  required: ["context"],
  properties: {
    context: {
      type: "object",
      required: ["projectType", "conventions", "recentChanges", "relevantFiles"],
      properties: {
        projectType: { type: "string" },
        conventions: { type: "array", items: { type: "string" } },
        recentChanges: { type: "array", items: { type: "string" } },
        relevantFiles: { type: "array", items: { type: "string" } },
      },
    },
    assumptions: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
  },
}

const CLASSIFY_SHAPE = {
  type: "object",
  required: ["type", "confidence", "reasoning"],
  properties: {
    type: { enum: ["feature", "bugfix", "refactor", "feedback"] },
    confidence: { enum: ["high", "medium", "low"] },
    reasoning: { type: "string" },
  },
}

const DESIGN_SHAPE = {
  type: "object",
  required: ["tasks"],
  properties: {
    tasks: {
      type: "array",
      minItems: 1,
      items: {
        type: "object",
        required: ["id", "description", "acceptance"],
        properties: {
          id: { type: "string" },
          description: { type: "string" },
          acceptance: { type: "string" },
          files: { type: "array", items: { type: "string" } },
          dependsOn: { type: "array", items: { type: "string" } },
        },
      },
    },
    notes: { type: "string" },
  },
}

const INTEGRATE_SHAPE = {
  type: "object",
  required: ["merged", "conflicts", "skipped_pristine"],
  properties: {
    merged: {
      type: "array",
      items: { type: "object", properties: { taskId: { type: "string" }, branch: { type: "string" }, sha: { type: "string" } } },
    },
    conflicts: {
      type: "array",
      items: { type: "object", properties: { taskId: { type: "string" }, branch: { type: "string" }, error: { type: "string" } } },
    },
    skipped_pristine: { type: "array", items: { type: "string" } },
  },
}

const VERIFY_SHAPE = {
  type: "object",
  required: ["typecheck", "tests", "build", "allPassed"],
  properties: {
    typecheck: { enum: ["ok", "fail", "skipped"] },
    tests: {
      type: "object",
      required: ["passed", "failed"],
      properties: {
        passed: { type: "number" },
        failed: { type: "number" },
        output: { type: "string" },
      },
    },
    build: { enum: ["ok", "fail", "skipped"] },
    allPassed: { type: "boolean" },
    failures: { type: "string" },
  },
}

const REVIEW_SHAPE = {
  type: "object",
  required: ["critical", "important", "minor", "readyToMerge"],
  properties: {
    critical: { type: "array", items: { type: "string" } },
    important: { type: "array", items: { type: "string" } },
    minor: { type: "array", items: { type: "string" } },
    readyToMerge: { type: "boolean" },
  },
}

const ITERATION_REPORT_SHAPE = {
  type: "object",
  required: ["iteration", "what_changed"],
  properties: {
    iteration: { type: "number" },
    what_changed: { type: "string" },
    files_added: { type: "array", items: { type: "string" } },
    files_modified: { type: "array", items: { type: "string" } },
    tests_passed: { type: "number" },
    tests_failed: { type: "number" },
    notes: { type: "string" },
  },
}

const FINAL_REPORT_SHAPE = {
  type: "object",
  required: ["path"],
  properties: {
    path: { type: "string" },
    sha: { type: "string" },
    summary: { type: "string" },
  },
}

const MERGE_SHAPE = {
  type: "object",
  required: ["committed", "action"],
  properties: {
    committed: { type: "boolean" },
    sha: { type: "string" },
    prUrl: { type: "string" },
    action: { enum: ["commit", "commit+push", "commit+pr", "none"] },
  },
}

// Accept args as either an object {task,type?,...} OR a JSON string OR a bare task
// string, because the AI-SDK tool boundary often serializes nested args as strings.
let _argsObj
if (typeof args === "object" && args !== null) {
  _argsObj = args
} else if (typeof args === "string") {
  try { _argsObj = JSON.parse(args) } catch (_) { _argsObj = { task: args } }
  if (typeof _argsObj !== "object" || _argsObj === null) _argsObj = { task: args }
} else {
  _argsObj = {}
}
const TASK = typeof _argsObj.task === "string" ? _argsObj.task : ""
if (!TASK) {
  return { error: "no-task", message: "Pass args.task = '<request>'." }
}

const VALID_TYPES = ["feature", "bugfix", "refactor", "feedback"]
const argType = typeof _argsObj.type === "string" ? _argsObj.type : ""
const SKIP_BRAINSTORM = _argsObj.skip_brainstorm === true
const SKIP_REPORT = _argsObj.skip_report === true
const MAX_CONCURRENT =
  typeof _argsObj.maxConcurrent === "number" && _argsObj.maxConcurrent > 0 ? _argsObj.maxConcurrent : DEFAULT_MAX_CONCURRENT

// Docs dir injected by the host (workflow.ts) from ConfigCompose.resolveDocsDir,
// mirroring the <compose_docs_dir> block prompt.ts gives the interactive compose
// agent. Default keeps the workflow self-sufficient if the host didn't inject.
const DOCS_DIR = typeof _argsObj._composeDocsDir === "string" && _argsObj._composeDocsDir ? _argsObj._composeDocsDir : "docs/compose"
const SPECS_DIR = DOCS_DIR + "/specs"
const PLANS_DIR = DOCS_DIR + "/plans"
const REPORTS_DIR = DOCS_DIR + "/reports"
const docsBlock =
  "<compose_docs_dir>\n" +
  "Save compose skill outputs: specs in `" + SPECS_DIR + "`, plans in `" + PLANS_DIR + "`, reports in `" + REPORTS_DIR + "`.\n" +
  "</compose_docs_dir>"

// Slug for the per-run report filename. feature_name overrides; else slugify task.
const FEATURE_NAME =
  (typeof _argsObj.feature_name === "string" && _argsObj.feature_name ? _argsObj.feature_name : TASK)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60) || "compose-run"
const REPORT_PATH = REPORTS_DIR + "/" + FEATURE_NAME + ".md"

// ---------------------------------------------------------------------------
// Phase 0 — Brainstorm (autonomous-mode contract: context recon only, never-ask)
// ---------------------------------------------------------------------------
phase("Brainstorm")
const SYNTHETIC_CONTEXT = { projectType: "unknown", conventions: [], recentChanges: [], relevantFiles: [] }
let brainstorm
if (SKIP_BRAINSTORM) {
  brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
} else {
  brainstorm = await agent(
    "Apply the `compose:brainstorm` skill in AUTONOMOUS mode — no user is available. Use the `skill` tool to load it first.\n\n" +
    "Per the skill's autonomous override: do STEP 1 ONLY (context recon). Do NOT present a design, ask questions, write a spec, or wait for approval.\n\n" +
    "## Task\n" + TASK + "\n\n" +
    "## What to gather\n" +
    "- Read AGENTS.md / CLAUDE.md / README.md if present\n" +
    "- Skim recent commits (`git log --oneline -20`)\n" +
    "- Map top-level directory layout\n" +
    "- Identify files clearly relevant to the task\n" +
    "- Note any reasonable assumptions you are making (so Design sees them)\n\n" +
    "Return structured output only.",
    { label: "brainstorm", phase: "Brainstorm", schema: BRAINSTORM_SHAPE, model: "lite" }
  )
  if (!brainstorm || !brainstorm.context) brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
}
const contextDigest =
  "Project: " + brainstorm.context.projectType + "\n" +
  "Conventions:\n" + (brainstorm.context.conventions || []).map((c) => "- " + c).join("\n") + "\n" +
  "Recent changes:\n" + (brainstorm.context.recentChanges || []).map((c) => "- " + c).join("\n") + "\n" +
  "Relevant files:\n" + (brainstorm.context.relevantFiles || []).map((f) => "- " + f).join("\n") +
  ((brainstorm.assumptions && brainstorm.assumptions.length) ? "\nAssumptions:\n" + brainstorm.assumptions.map((a) => "- " + a).join("\n") : "")

// ---------------------------------------------------------------------------
// Phase 1 — Classify
// ---------------------------------------------------------------------------
phase("Classify")
let classification = null
let type
if (VALID_TYPES.indexOf(argType) >= 0) {
  type = argType
} else {
  classification = await agent(
    "Classify the task below into exactly one of: feature, bugfix, refactor, feedback.\n\n" +
    "## Task\n" + TASK + "\n\n" +
    "## Definitions\n" +
    "- feature: net-new capability or user-visible behavior\n" +
    "- bugfix: existing behavior is broken; root-cause + fix\n" +
    "- refactor: restructure without behavior change\n" +
    "- feedback: address PR review or user-reported issues against an existing change\n\n" +
    "Return structured output only.",
    { label: "classify", phase: "Classify", schema: CLASSIFY_SHAPE, model: "lite" }
  )
  type = classification && classification.type ? classification.type : "feature"
  log("Classified as " + type + (classification ? " (" + classification.confidence + ")" : " (default)"))
}

const SKILL_BY_TYPE = {
  feature: "compose:plan",
  refactor: "compose:plan",
  bugfix: "compose:debug",
  feedback: "compose:feedback",
}

// ---------------------------------------------------------------------------
// Phase 2 — Design (spec/plan, context-grounded, dependency-aware)
// ---------------------------------------------------------------------------
phase("Design")
const designSkill = SKILL_BY_TYPE[type] || "compose:plan"
const design = await agent(
  "Apply the `" + designSkill + "` skill to the task below. Use the `skill` tool to load the skill before working.\n\n" +
  docsBlock + "\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## Project context (from brainstorm)\n" + contextDigest + "\n\n" +
  "## What to produce\n" +
  "Write the spec/plan to the docs dirs above per the skill, then return a task list of bite-sized work items, " +
  "each with id, description, and acceptance criteria. Optionally list the files each task touches.\n" +
  "Mark independent tasks with empty `dependsOn`. Mark a task that needs another committed first with that task's id in `dependsOn`. " +
  "No cycles in dependsOn.\n\n" +
  "Return structured output only.",
  { label: "design:" + type, phase: "Design", schema: DESIGN_SHAPE }
)
if (!design) {
  return { error: "design-failed", type, classification, brainstorm }
}
log("Designed " + design.tasks.length + " task(s) using " + designSkill)

// Topo-sort (Kahn) over design.tasks by dependsOn → ordered batches.
const topoSort = (tasks) => {
  const byId = Object.create(null)
  for (const t of tasks) byId[t.id] = t
  const indeg = Object.create(null)
  const deps = Object.create(null)
  for (const t of tasks) {
    deps[t.id] = (t.dependsOn || []).filter((d) => byId[d])
    indeg[t.id] = deps[t.id].length
  }
  const batches = []
  let remaining = tasks.map((t) => t.id)
  while (remaining.length) {
    const ready = remaining.filter((id) => indeg[id] === 0)
    if (!ready.length) return { error: "design-cycle", cycleNodes: remaining }
    batches.push(ready)
    const readySet = Object.create(null)
    for (const id of ready) readySet[id] = true
    remaining = remaining.filter((id) => !readySet[id])
    for (const id of remaining) {
      indeg[id] = deps[id].filter((d) => !readySet[d] && remaining.indexOf(d) >= 0).length
    }
  }
  return { batches }
}
const topo = topoSort(design.tasks)
if (topo.error) {
  return { error: "design-cycle", cycleNodes: topo.cycleNodes, type, classification, brainstorm, design }
}
const batches = topo.batches
const taskById = Object.create(null)
for (const t of design.tasks) taskById[t.id] = t

const TASKS_DIGEST = design.tasks.map((t, i) => (i + 1) + ". " + t.id + ": " + t.description + " — " + t.acceptance).join("\n")

// ---------------------------------------------------------------------------
// Helpers: implement (per-task, worktree), integrate, verify, debug, report
// ---------------------------------------------------------------------------
const runImplementTask = (task, failuresOrEmpty) => agent(
  "Apply the `compose:tdd` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Overall task\n" + TASK + "\n\n" +
  "## Your work item (" + task.id + ")\n" + task.description + "\nAcceptance: " + task.acceptance +
  (task.files && task.files.length ? "\nFiles: " + task.files.join(", ") : "") + "\n\n" +
  (failuresOrEmpty ? "## Verify failures from previous attempt — focus on these\n" + failuresOrEmpty + "\n\n" : "") +
  "Write the failing test first, then the minimal code to pass, then refactor. Commit your work inside this worktree.",
  { label: "implement:" + task.id, phase: "Implement", isolation: "worktree" }
)

const runIntegrate = (kept) => agent(
  "Integrate the per-task worktrees below into the main workspace.\n\n" +
  "## Worktrees to merge\n" + JSON.stringify(kept) + "\n\n" +
  "For each `_worktree`, fetch its branch into the main workspace and merge (or fast-forward) it onto current HEAD. " +
  "Resolve trivial conflicts (whitespace, import order, formatting) automatically. Surface real conflicts unmodified. " +
  "Then `git worktree remove` each integrated worktree.\n\n" +
  "Return structured output only.",
  { label: "integrate", phase: "Implement", schema: INTEGRATE_SHAPE }
)

const runVerify = () => agent(
  "Run the project's verification commands and report the outcome.\n\n" +
  "## Steps\n" +
  "1. Inspect AGENTS.md / CLAUDE.md / package.json for the project's verify commands (typecheck, test, build).\n" +
  "2. Run them via the Bash tool, in the right directory (e.g. `packages/<x>/` not the repo root if AGENTS.md says so).\n" +
  "3. Capture passed/failed test counts. Summarize failures concisely if any.\n\n" +
  "Return structured output only.",
  { label: "verify", phase: "Verify", schema: VERIFY_SHAPE }
)

const runDebug = (failures) => agent(
  "Apply the `compose:debug` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Verify failures / integrate conflicts\n" + failures + "\n\n" +
  "Identify the root cause and fix it. Do not paper over symptoms.",
  { label: "debug", phase: "Implement" }
)

const runIterationReport = (iteration, verifyResult) => {
  if (SKIP_REPORT) return Promise.resolve(null)
  return agent(
    "Apply the `compose:report` skill in per-iteration mode. Use the `skill` tool to load it first.\n\n" +
    docsBlock + "\n\n" +
    "## Report file (overwrite-in-place, accumulate Journey Log)\n" + REPORT_PATH + "\n\n" +
    "## Iteration\n" + iteration + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Verify result\n" + JSON.stringify(verifyResult) + "\n\n" +
    "Read the existing report if present, update sections, append a Journey Log entry for this iteration, and overwrite the file. " +
    "Keep it brief.\n\n" +
    "Return structured output only.",
    { label: "iteration-report:" + iteration, phase: "Report", schema: ITERATION_REPORT_SHAPE }
  )
}

// Dispatch a batch of tasks in parallel, each isolated in its own worktree, then
// integrate the kept worktrees. Returns { perTaskResults, integrate }.
const runBatch = async (batchIds, failuresOrEmpty) => {
  const tasks = batchIds.map((id) => taskById[id])
  const limit = Math.min(MAX_CONCURRENT, tasks.length)
  // Soft per-batch cap: chunk so no more than `limit` run at once.
  const perTaskResults = []
  const kept = []
  for (let i = 0; i < tasks.length; i += limit) {
    const chunk = tasks.slice(i, i + limit)
    const results = await parallel(chunk.map((t) => () => runImplementTask(t, failuresOrEmpty)))
    for (let j = 0; j < chunk.length; j++) {
      const t = chunk[j]
      const r = results[j]
      const wt = r && typeof r === "object" ? r._worktree : null
      if (wt && wt.changed) {
        kept.push({ taskId: t.id, _worktree: wt })
        perTaskResults.push({ taskId: t.id, status: "ok", branch: wt.branch })
      } else if (r === null) {
        perTaskResults.push({ taskId: t.id, status: "failed" })
      } else {
        perTaskResults.push({ taskId: t.id, status: "pristine" })
      }
    }
  }
  const integrate = kept.length
    ? await runIntegrate(kept)
    : { merged: [], conflicts: [], skipped_pristine: perTaskResults.filter((r) => r.status !== "ok").map((r) => r.taskId) }
  return { perTaskResults, integrate: integrate || { merged: [], conflicts: [], skipped_pristine: [] } }
}

// ---------------------------------------------------------------------------
// Phase 3 — Implement (TDD outer loop, ≤3 attempts)
// ---------------------------------------------------------------------------
phase("Implement")
const verifyHistory = []
const implementHistory = []
let verify = null
let tddAttempts = 0
for (let attempt = 0; attempt < MAX_TDD_ATTEMPTS; attempt++) {
  tddAttempts = attempt + 1
  const failures = attempt === 0 ? "" : (verify && verify.failures ? verify.failures : "")
  let attemptConflicts = []
  const perTaskResults = []
  const integrateHistory = []
  for (const batchIds of batches) {
    const batchOut = await runBatch(batchIds, failures)
    for (const r of batchOut.perTaskResults) perTaskResults.push(r)
    integrateHistory.push(batchOut.integrate)
    if (batchOut.integrate.conflicts && batchOut.integrate.conflicts.length) {
      attemptConflicts = attemptConflicts.concat(batchOut.integrate.conflicts)
    }
  }

  phase("Verify")
  verify = await runVerify()
  if (verify) verifyHistory.push(verify)
  const conflictText = attemptConflicts.length ? "\nIntegrate conflicts: " + JSON.stringify(attemptConflicts) : ""
  const passed = verify && verify.allPassed && attemptConflicts.length === 0

  implementHistory.push({
    attempt: tddAttempts,
    perTaskResults,
    integrate: { batches: integrateHistory },
    verify: verify || null,
  })

  if (passed) {
    log("Verify passed on attempt " + tddAttempts)
    phase("Report")
    await runIterationReport(tddAttempts, verify)
    break
  }
  if (attempt + 1 === MAX_TDD_ATTEMPTS) {
    return { error: "verify-exhausted", type, classification, brainstorm, design, batches, verifyHistory, implementHistory, attempts: MAX_TDD_ATTEMPTS }
  }
  phase("Implement")
  await runDebug((verify ? (verify.failures || "verify returned no detail") : "verify agent failed (null)") + conflictText)
}

// ---------------------------------------------------------------------------
// Phase 4 — Review  +  Phase 5 — Fix loop (≤2 attempts)
// ---------------------------------------------------------------------------
const runReview = () => agent(
  "Apply the `compose:review` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Task context\n" + TASK + "\n\n" +
  "## What to produce\n" +
  "Triage findings into critical (must fix before merge), important (should fix), and minor (nits). " +
  "Set readyToMerge=true only if critical is empty.\n\n" +
  "Return structured output only.",
  { label: "review", phase: "Review", schema: REVIEW_SHAPE }
)

const runFixTask = (finding, i) => agent(
  "Address the CRITICAL review finding below. Apply the `compose:tdd` skill to fix it with tests where possible. " +
  "Use the `skill` tool to load it first.\n\n" +
  "## Critical finding (" + (i + 1) + ")\n" + finding + "\n\n" +
  "Fix it and commit inside this worktree.",
  { label: "fix:" + i, phase: "Fix", isolation: "worktree" }
)

phase("Review")
let review = await runReview()
if (!review) review = { critical: [], important: [], minor: [], readyToMerge: true }
let reviewFixAttempts = 0
const fixHistory = []

if (review.critical && review.critical.length > 0) {
  phase("Fix")
  for (let attempt = 0; attempt < MAX_REVIEW_FIX_ATTEMPTS; attempt++) {
    reviewFixAttempts = attempt + 1
    const limit = Math.min(MAX_CONCURRENT, review.critical.length)
    const perTaskResults = []
    const kept = []
    const criticals = review.critical
    for (let i = 0; i < criticals.length; i += limit) {
      const chunk = criticals.slice(i, i + limit)
      const results = await parallel(chunk.map((finding, k) => () => runFixTask(finding, i + k)))
      for (let j = 0; j < chunk.length; j++) {
        const r = results[j]
        const wt = r && typeof r === "object" ? r._worktree : null
        if (wt && wt.changed) {
          kept.push({ taskId: "fix-" + (i + j), _worktree: wt })
          perTaskResults.push({ taskId: "fix-" + (i + j), status: "ok", branch: wt.branch })
        } else {
          perTaskResults.push({ taskId: "fix-" + (i + j), status: r === null ? "failed" : "pristine" })
        }
      }
    }
    const integrate = kept.length ? (await runIntegrate(kept)) || { merged: [], conflicts: [], skipped_pristine: [] } : { merged: [], conflicts: [], skipped_pristine: [] }

    phase("Verify")
    const reverify = await runVerify()
    if (reverify) verifyHistory.push(reverify)

    phase("Review")
    review = await runReview()
    if (!review) review = { critical: [], important: [], minor: [], readyToMerge: false }

    fixHistory.push({ attempt: reviewFixAttempts, perTaskResults, integrate, verify: reverify || null, review })

    phase("Report")
    await runIterationReport(MAX_TDD_ATTEMPTS + reviewFixAttempts, reverify)

    if (!review.critical || review.critical.length === 0) {
      log("Critical issues cleared on fix attempt " + reviewFixAttempts)
      break
    }
  }
  if (review.critical && review.critical.length > 0) {
    return {
      readyToMerge: false,
      type, classification, brainstorm, design, batches, verifyHistory, implementHistory, fixHistory, review,
      attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
    }
  }
}

// ---------------------------------------------------------------------------
// Phase 6 — Final Report (consolidate, committed before merge)
// ---------------------------------------------------------------------------
let finalReport = null
if (!SKIP_REPORT) {
  phase("Report")
  finalReport = await agent(
    "Apply the `compose:report` skill in FINAL consolidation mode. Use the `skill` tool to load it first.\n\n" +
    docsBlock + "\n\n" +
    "## Report file (read the in-progress per-iteration file, overwrite with canonical final state)\n" + REPORT_PATH + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Run history\n" +
    "verifyHistory: " + JSON.stringify(verifyHistory) + "\n" +
    "implementHistory: " + JSON.stringify(implementHistory) + "\n" +
    "reviewFixAttempts: " + reviewFixAttempts + "\n\n" +
    "Produce the final-state report (What Was Built / Architecture / Design Decisions / Usage / Verification / Journey Log / Source Materials). " +
    "Distill the Journey Log to at most 5 entries. Commit the report file.\n\n" +
    "Return structured output only.",
    { label: "final-report", phase: "Report", schema: FINAL_REPORT_SHAPE }
  )
}

// ---------------------------------------------------------------------------
// Phase 7 — Merge
// ---------------------------------------------------------------------------
phase("Merge")
const merge = await agent(
  "Apply the `compose:merge` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "Commit the changes. If the branch tracks a remote and a PR is appropriate, push and open one.\n" +
  "Pick the smallest action that satisfies the goal:\n" +
  "- `commit`: just record locally\n" +
  "- `commit+push`: also push to the existing remote branch\n" +
  "- `commit+pr`: push and open a PR\n\n" +
  "Return structured output only.",
  { label: "merge", phase: "Merge", schema: MERGE_SHAPE }
)
if (!merge || !merge.committed) {
  return {
    error: "merge-failed",
    type, classification, brainstorm, design, batches, verifyHistory, implementHistory, review, finalReport,
    merge: merge || { committed: false, action: "none" },
    attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
  }
}

return {
  brainstorm,
  type,
  classification,
  design,
  batches,
  implementHistory,
  verifyHistory,
  review,
  fixHistory: fixHistory.length ? fixHistory : undefined,
  reviewFixes: reviewFixAttempts,
  finalReport,
  merge,
  stats: {
    agents: verifyHistory.length + tddAttempts + reviewFixAttempts + 4, // brainstorm + classify + design + review + merge
    phases: 8,
    parallelBatches: batches.length,
    durationMs: 0, // QuickJS guest has no Date; host can compute from journal if needed
  },
}
