export const meta = {
  name: "compose",
  description:
    "Autonomous compose pipeline — brainstorms context, designs (spec/plan), implements via parallel per-task worktrees with TDD, verifies, reviews, reports, and merges. Bounded retry, never-ask mode.",
  whenToUse:
    "Use to drive a feature, bugfix, refactor, or review-feedback task through the full compose flow without user prompting. Pass args.task = the user's request. Optionally args.type to set the task type (feature/bugfix/refactor/feedback; otherwise inferred), args.feature_name for the report filename, args.skip_brainstorm / args.skip_report to drop those phases, args.maxConcurrent to bound per-batch parallelism. Independent tasks auto-run in parallel, each in its own worktree, then merge back; pass args.isolate_worktrees=false to force all-sequential or =true to force isolation.",
  phases: [
    { title: "Brainstorm", detail: "Context recon (never-ask): conventions, recent changes, relevant files" },
    { title: "Design", detail: "Apply compose:plan, compose:debug, or compose:feedback; emit task list with deps" },
    { title: "Implement", detail: "Topo-sorted batches; independent tasks parallelize in per-task worktrees, then integrate" },
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
    selfQA: { type: "array", items: { type: "object", properties: { question: { type: "string" }, answer: { type: "string" } } } },
    approaches: { type: "array", items: { type: "object", properties: { name: { type: "string" }, tradeoffs: { type: "string" } } } },
    chosenApproach: { type: "string" },
    chosenRationale: { type: "string" },
    openQuestions: { type: "array", items: { type: "string" } },
    amends: { type: "string" },
    existingDocs: { type: "array", items: { type: "string" } },
    notes: { type: "string" },
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
// Per-batch worktree isolation. Independent tasks that would run concurrently MUST
// be isolated (parallel writes to one workspace conflict) — the runtime creates a
// worktree per task, the agent works in it, and an integrate agent merges it back.
// Decision is per batch: auto-isolate a batch iff it runs >1 task; a single-task
// batch stays sequential in the main workspace. args.isolate_worktrees forces it:
// true = always isolate, false = never. (Runtime worktree path verified by
// test/workflow/runtime-worktree.test.ts; not opt-in-off anymore.)
const ISOLATE_OVERRIDE =
  _argsObj.isolate_worktrees === true ? true : _argsObj.isolate_worktrees === false ? false : undefined
const isolateBatch = (batchIds) =>
  ISOLATE_OVERRIDE === true ? true : ISOLATE_OVERRIDE === false ? false : batchIds.length > 1
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
// Strip trailing dashes AFTER the length cap too, so a 60-char cut that lands on a
// separator doesn't leave an ugly trailing "-" in the filename.
const FEATURE_NAME =
  ((typeof _argsObj.feature_name === "string" && _argsObj.feature_name ? _argsObj.feature_name : TASK)
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60)
    .replace(/-+$/, "")) || "compose-run"
const REPORT_PATH = REPORTS_DIR + "/" + FEATURE_NAME + ".md"

// ---------------------------------------------------------------------------
// Phase 0 — Brainstorm (autonomous-mode contract: context recon only, never-ask)
// ---------------------------------------------------------------------------
phase("Brainstorm")
const SYNTHETIC_CONTEXT = { projectType: "unknown", conventions: [], recentChanges: [], relevantFiles: [] }
// Surface any prior compose artifacts so brainstorm can detect an AMENDMENT (a
// change to an existing feature) vs new work — enabling incremental re-runs that
// reuse the existing spec/plan instead of regenerating everything. The workflow
// only lists the files; the agent reads + judges.
const _globArr = async (pat) => { const r = await glob(pat); return Array.isArray(r) ? r : [] }
const existingDocs = [
  ...(await _globArr(SPECS_DIR + "/*.md")),
  ...(await _globArr(PLANS_DIR + "/*.md")),
  ...(await _globArr(REPORTS_DIR + "/*.md")),
]
const existingDocsBlock = existingDocs.length
  ? "\n## Existing compose artifacts (this project has prior compose work)\n" +
    existingDocs.map((p) => "- " + p).join("\n") + "\n" +
    "If the task below is a CHANGE/ADDITION to a feature documented above, READ the relevant spec/plan (use the `read` tool) " +
    "and treat this as an AMENDMENT: set `amends` to that feature's name and list the docs you used in `existingDocs`. " +
    "If the task is unrelated/new, leave `amends` empty.\n"
  : ""
let brainstorm
if (SKIP_BRAINSTORM) {
  brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
} else {
  brainstorm = await agent(
    "Apply the `compose:brainstorm` skill in AUTONOMOUS mode — no user is available to answer. Use the `skill` tool to load it first.\n\n" +
    "## Autonomous brainstorming — self-conduct the dialogue (do NOT stop at context recon)\n" +
    "'No user' means you ask and answer the questions YOURSELF; it does NOT mean skip the thinking. Run the real brainstorm:\n" +
    "1. Explore project context (files, docs, recent commits, layout) and note assumptions.\n" +
    "2. Pose the clarifying questions you WOULD ask a user, and answer each from the context/your best judgment (record as selfQA).\n" +
    "3. Propose 2-3 distinct approaches with trade-offs (record as approaches).\n" +
    "4. Pick ONE and justify it (chosenApproach + chosenRationale). Note any unresolved openQuestions.\n" +
    "Do NOT present a design to a user, do NOT wait for approval, do NOT write a spec here — that is Design's job. " +
    "This reasoning is the KEY input Design consumes, so capture it fully in the structured output.\n\n" +
    "## Task\n" + TASK + "\n\n" +
    existingDocsBlock +
    "## Context to gather\n" +
    "- Read AGENTS.md / CLAUDE.md / README.md if present\n" +
    "- Skim recent commits (`git log --oneline -20`)\n" +
    "- Map top-level directory layout; identify files relevant to the task\n\n" +
    "Return structured output only.",
    { label: "brainstorm", phase: "Brainstorm", schema: BRAINSTORM_SHAPE }
  )
  if (!brainstorm || !brainstorm.context) brainstorm = { context: SYNTHETIC_CONTEXT, assumptions: [] }
}
const _arr = (v) => (Array.isArray(v) ? v : [])
const contextDigest =
  "Project: " + brainstorm.context.projectType + "\n" +
  "Conventions:\n" + _arr(brainstorm.context.conventions).map((c) => "- " + c).join("\n") + "\n" +
  "Recent changes:\n" + _arr(brainstorm.context.recentChanges).map((c) => "- " + c).join("\n") + "\n" +
  "Relevant files:\n" + _arr(brainstorm.context.relevantFiles).map((f) => "- " + f).join("\n") +
  (_arr(brainstorm.assumptions).length ? "\nAssumptions:\n" + _arr(brainstorm.assumptions).map((a) => "- " + a).join("\n") : "") +
  (_arr(brainstorm.selfQA).length ? "\nSelf-Q&A (brainstorm reasoning):\n" + _arr(brainstorm.selfQA).map((q) => "- Q: " + (q && q.question) + "\n  A: " + (q && q.answer)).join("\n") : "") +
  (_arr(brainstorm.approaches).length ? "\nApproaches considered:\n" + _arr(brainstorm.approaches).map((a) => "- " + (a && a.name) + " — " + (a && a.tradeoffs)).join("\n") : "") +
  ((brainstorm.chosenApproach && typeof brainstorm.chosenApproach === "string") ? "\nChosen approach: " + brainstorm.chosenApproach + (brainstorm.chosenRationale ? " (because: " + brainstorm.chosenRationale + ")" : "") : "") +
  (_arr(brainstorm.openQuestions).length ? "\nOpen questions:\n" + _arr(brainstorm.openQuestions).map((q) => "- " + q).join("\n") : "") +
  ((brainstorm.amends && typeof brainstorm.amends === "string") ? "\nAmends existing feature: " + brainstorm.amends : "")

// ---------------------------------------------------------------------------
// Type resolution (no separate Classify phase)
// ---------------------------------------------------------------------------
// First-principles: picking the design skill is a low-risk, reversible routing
// decision the later Design/Implement phases can self-correct — it does NOT
// warrant its own LLM phase (the original compose flow has no classifier; it goes
// brainstorm → compose:plan). So: honor an explicit args.type; otherwise default
// to "feature" (→ compose:plan) and let a cheap keyword heuristic divert obvious
// bugfix / PR-feedback tasks. The design agent re-judges with full context anyway.
let type
if (VALID_TYPES.indexOf(argType) >= 0) {
  type = argType
} else {
  const t = TASK.toLowerCase()
  if (/\b(pr|review)\b.*\b(feedback|comment|address)\b|address .*\bfeedback\b/.test(t)) type = "feedback"
  else if (/\b(bug|broken|regression|crash|fails?|incorrect|wrong|error)\b/.test(t)) type = "bugfix"
  else type = "feature"
  log("Task type: " + type)
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
const SPEC_PATH = SPECS_DIR + "/" + FEATURE_NAME + ".md"
const PLAN_PATH = PLANS_DIR + "/" + FEATURE_NAME + ".md"
// Amendment: brainstorm flagged this as a change to an existing feature. Design
// edits the existing spec/plan in place and re-runs only the affected tasks,
// instead of regenerating everything.
const AMENDS = brainstorm && typeof brainstorm.amends === "string" ? brainstorm.amends.trim() : ""

// Step 1 — the AGENT writes (or amends) the spec + plan files. The workflow does
// NOT write them; it only gates on existence and re-dispatches if skipped. No
// `schema` here so the agent is free to use its write/skill tools.
const runDesignWrite = (sharpen) => agent(
  "Apply the `" + designSkill + "` skill to the task below. Use the `skill` tool to load the skill FIRST, then follow it.\n\n" +
  docsBlock + "\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## Project context (from brainstorm)\n" + contextDigest + "\n\n" +
  (AMENDS
    ? "## This is an AMENDMENT to an existing feature: " + AMENDS + "\n" +
      "Use `glob`/`read` to find that feature's existing spec under `" + SPECS_DIR + "` and plan under `" + PLANS_DIR + "`. " +
      "EDIT them IN PLACE (write back to the SAME file paths) to reflect ONLY the change in the task above — do NOT rewrite from scratch. " +
      "In the plan, the task list must then contain ONLY the tasks that need to be (re-)implemented for this change, PLUS any tasks that " +
      "depend on them. Tasks unaffected by the change MUST be omitted from the actionable list — they are reused as-is.\n\n" +
      "## Scope the work to the actual change (CRITICAL)\n" +
      "First assess the MAGNITUDE of this change: small (one spot / a few lines), medium (a few related tasks), " +
      "or large (a foundational refactor touching many modules). Make the plan's actionable task list MATCH that magnitude:\n" +
      "- Small change → ONE task (or zero, if the code already satisfies it). Do NOT split one small change into multiple tasks.\n" +
      "- Medium → only the genuinely distinct tasks the change requires, plus their dependents.\n" +
      "- Large refactor → re-decompose into as many independent tasks as the work truly needs.\n" +
      "NEVER emit two near-identical or duplicate tasks for the same change. One distinct unit of work = exactly one task. " +
      "The number of tasks must reflect the real scope — it is not fixed.\n\n" +
      "Write the updated files with the `write` tool. Do not just describe them.\n"
    : "## Your deliverable (REQUIRED — this is the whole job)\n" +
      "Use the `write` tool to create BOTH of these files on disk:\n" +
      "1. Spec: `" + SPEC_PATH + "`\n" +
      "2. Plan: `" + PLAN_PATH + "` — a bite-sized task list per the skill, each task with id, description, acceptance, optional files, and `dependsOn` (empty for independent tasks; a prerequisite task id otherwise; no cycles).\n\n" +
      (sharpen ? "## You did NOT write the required files last time. Write them NOW with the write tool before finishing.\n\n" : "") +
      "Do the writes with the `write` tool. Do not just describe them."),
  { label: "design:" + type, phase: "Design" }
)
await runDesignWrite(false)
// Gate: the agent owns the writes; the workflow only verifies they happened and
// re-dispatches the agent once if not. The workflow itself never writes the files.
// Robustness: the agent may write under a slightly different leaf name than our
// computed slug (model-chosen filename, trailing-dash drift, etc.). So treat the
// gate as "did ANY .md land in the specs and plans dirs", not an exact-path match —
// this avoids a redundant, expensive re-dispatch when the files are actually there.
const docsPresent = async () => {
  const specs = await glob(SPECS_DIR + "/*.md")
  const plans = await glob(PLANS_DIR + "/*.md")
  return specs.length > 0 && plans.length > 0
}
if (!(await docsPresent())) {
  await runDesignWrite(true)
}
const specWritten = (await glob(SPECS_DIR + "/*.md")).length > 0
const planWritten = (await glob(PLANS_DIR + "/*.md")).length > 0

// Step 2 — structured extraction: a separate agent reads the plan the previous
// agent wrote and returns the machine-usable task list. Schema lives here, where
// JSON-only is exactly what we want — no file work expected in this call. The
// prompt FORCES a direct StructuredOutput tool call: the model otherwise tends to
// answer with prose/markdown/XML, which fails schema validation and triggers a
// slow retry loop (each round-trip is a full model call).
const design = await agent(
  "Read the implementation plan markdown in `" + PLANS_DIR + "` (use the `read` tool; if multiple files, read the most recent) and extract its task list.\n\n" +
  (planWritten ? "" : "## No plan file found — derive the task list from the task below instead.\n## Task\n" + TASK + "\n\n") +
  (AMENDS ? "## Amendment\nThis run amends the existing feature \"" + AMENDS + "\". Return the SMALLEST set of tasks that covers the actual change (plus their dependents). One distinct unit of work = exactly one task — do NOT return duplicate or near-identical tasks, and do NOT split a single small change across multiple tasks. OMIT every task unaffected by this change — they are reused as-is.\n\n" : "") +
  "## Output contract (STRICT)\n" +
  "Call the `StructuredOutput` tool EXACTLY ONCE with a JSON object matching the schema. " +
  "Do NOT reply with prose, markdown, XML, or a code block — those do not count and will be rejected. " +
  "The JSON has a `tasks` array; each task: id, description, acceptance, optional files[], and dependsOn[] " +
  "(empty for independent tasks; a prerequisite task id otherwise; no cycles).",
  { label: "design-extract:" + type, phase: "Design", schema: DESIGN_SHAPE }
)
if (!design || !Array.isArray(design.tasks) || design.tasks.length === 0) {
  return { error: "design-failed", type, brainstorm, docs: { specWritten, planWritten } }
}
// Normalize task ids: the extract agent sometimes returns tasks with a missing or
// blank `id` (schema validation can let an empty string through), which then shows
// up as "implement:undefined" in labels and breaks dependsOn wiring. Backfill any
// missing/duplicate id with a synthetic Tn so labels, topo-sort, and deps are stable.
{
  const seen = Object.create(null)
  let n = 0
  for (const t of design.tasks) {
    n++
    const raw = typeof t.id === "string" ? t.id.trim() : ""
    t.id = raw && !seen[raw] ? raw : "T" + n
    seen[t.id] = true
  }
}
log("Designed " + design.tasks.length + " task(s) using " + designSkill + " (spec=" + specWritten + " plan=" + planWritten + ")")

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
  return { error: "design-cycle", cycleNodes: topo.cycleNodes, type, brainstorm, design }
}
const batches = topo.batches
const taskById = Object.create(null)
for (const t of design.tasks) taskById[t.id] = t

// Intent carried from brainstorm/design into each implementer so it builds toward
// the CHOSEN approach, not its own re-derivation. Plan path lets it read the spec.
const intentBlock =
  ((brainstorm.chosenApproach && typeof brainstorm.chosenApproach === "string")
    ? "## Intent (from design — build toward THIS approach)\n" + brainstorm.chosenApproach +
      (brainstorm.chosenRationale ? "\nRationale: " + brainstorm.chosenRationale : "") + "\n" +
      "Spec/plan for the whole feature: `" + SPEC_PATH + "` / `" + PLAN_PATH + "` (read if you need fuller context).\n\n"
    : "")

// ---------------------------------------------------------------------------
// Helpers: implement (per-task, worktree), integrate, verify, debug, report
// ---------------------------------------------------------------------------
const runImplementTask = (task, failuresOrEmpty, isolate) => agent(
  "Apply the `compose:tdd` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Overall task\n" + TASK + "\n\n" +
  intentBlock +
  "## Your work item (" + task.id + ")\n" + task.description + "\nAcceptance: " + task.acceptance +
  (task.files && task.files.length ? "\nFiles: " + task.files.join(", ") : "") + "\n\n" +
  (failuresOrEmpty ? "## Verify failures from previous attempt — focus on these\n" + failuresOrEmpty + "\n\n" : "") +
  "Write the failing test first (use the `write` tool), then the minimal code to pass, then refactor. " +
  "Actually create the source and test files on disk with the `write` tool — do not just describe them. " +
  (isolate ? "Commit your work inside this worktree." : "Commit your work in the workspace."),
  isolate
    ? { label: "implement:" + task.id, phase: "Implement", isolation: "worktree" }
    : { label: "implement:" + task.id, phase: "Implement" }
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
  "Apply the `compose:verify` skill. Use the `skill` tool to load it FIRST, then follow its discipline " +
  "(the Iron Law: no completion claim without fresh verification evidence — run the real commands, read the full output, " +
  "never trust 'should pass' or an agent's self-report).\n\n" +
  "## Run the project's verification commands and report the outcome\n" +
  "1. First run `pwd` and `ls` to confirm your working directory and that the project's source/test files are actually present here. The implemented code lives in THIS workspace — verify from the workspace root (or the package subdir AGENTS.md specifies), never from a stale or temp cwd.\n" +
  "2. Inspect AGENTS.md / CLAUDE.md / package.json for the project's verify commands (typecheck, test, build).\n" +
  "3. Run them via the Bash tool from the correct directory. If a command reports 'file not found' or 0 tests, you are in the wrong directory — `cd` to where the files are and re-run before reporting.\n" +
  "4. Capture passed/failed test counts from the ACTUAL command output. Summarize failures concisely if any.\n\n" +
  "Return structured output only — and it must reflect the real command output, not an assumption.",
  { label: "verify", phase: "Verify", schema: VERIFY_SHAPE }
)

const runDebug = (failures) => agent(
  "Apply the `compose:debug` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Verify failures / integrate conflicts\n" + failures + "\n\n" +
  "Identify the root cause and fix it. Do not paper over symptoms.",
  { label: "debug", phase: "Implement" }
)

const runIterationReport = async (iteration, verifyResult) => {
  if (SKIP_REPORT) return null
  // The agent writes the markdown report file. No schema — a schema would bias the
  // agent into emitting JSON instead of doing the write. The workflow only verifies
  // the file exists afterward.
  await agent(
    "Apply the `compose:report` skill in per-iteration mode. Use the `skill` tool to load it first.\n\n" +
    docsBlock + "\n\n" +
    "## Report file you MUST write (overwrite-in-place, accumulate Journey Log)\n" + REPORT_PATH + "\n\n" +
    "## Iteration\n" + iteration + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Verify result\n" + JSON.stringify(verifyResult) + "\n\n" +
    "Read the existing report if present (use `read`), update sections, append a Journey Log entry for this iteration, " +
    "and write the file with the `write` tool. Keep it brief. Writing the file is the deliverable — do not just describe it.",
    { label: "iteration-report:" + iteration, phase: "Report" }
  )
  return { iteration, written: await exists(REPORT_PATH) }
}

// Dispatch a batch of tasks in parallel, each isolated in its own worktree, then
// integrate the kept worktrees. Returns { perTaskResults, integrate }.
const runBatch = async (batchIds, failuresOrEmpty) => {
  const tasks = batchIds.map((id) => taskById[id])
  const perTaskResults = []
  const kept = []
  // Per-batch isolation: a batch with >1 independent task auto-isolates (worktree
  // per task) so they can run CONCURRENTLY without clobbering the shared workspace;
  // a single-task batch stays sequential in the main workspace. args.isolate_worktrees
  // forces either way. parallel() is gated on ISOLATE for exactly this reason.
  const ISOLATE = isolateBatch(batchIds)
  const limit = ISOLATE ? Math.min(MAX_CONCURRENT, tasks.length) : 1
  for (let i = 0; i < tasks.length; i += limit) {
    const chunk = tasks.slice(i, i + limit)
    const results = await parallel(chunk.map((t) => () => runImplementTask(t, failuresOrEmpty, ISOLATE)))
    for (let j = 0; j < chunk.length; j++) {
      const t = chunk[j]
      const r = results[j]
      if (ISOLATE) {
        const wt = r && typeof r === "object" ? r._worktree : null
        if (wt && wt.changed) {
          kept.push({ taskId: t.id, _worktree: wt })
          perTaskResults.push({ taskId: t.id, status: "ok", branch: wt.branch })
        } else if (r === null) {
          perTaskResults.push({ taskId: t.id, status: "failed" })
        } else {
          perTaskResults.push({ taskId: t.id, status: "pristine" })
        }
      } else {
        // Non-isolated: the agent wrote directly into the main workspace. A non-null
        // result means it ran; failure surfaces as null. No worktree to integrate.
        perTaskResults.push({ taskId: t.id, status: r === null ? "failed" : "ok" })
      }
    }
  }
  // Integrate only when isolated worktrees were kept. In non-isolated mode the work
  // already lives in the main workspace, so there is nothing to merge.
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
    return { error: "verify-exhausted", type, brainstorm, design, batches, verifyHistory, implementHistory, attempts: MAX_TDD_ATTEMPTS }
  }
  phase("Implement")
  await runDebug((verify ? (verify.failures || "verify returned no detail") : "verify agent failed (null)") + conflictText)
}

// ---------------------------------------------------------------------------
// Phase 4 — Review  +  Phase 5 — Fix loop (≤2 attempts)
// ---------------------------------------------------------------------------
const IMPLEMENTED_DIGEST = design.tasks.map((t) => "- " + t.id + ": " + t.description + " (acceptance: " + t.acceptance + ")").join("\n")
const runReview = () => agent(
  "Apply the `compose:review` skill. Use the `skill` tool to load it FIRST, then follow it.\n\n" +
  "Review the implemented change in TWO STAGES, spec-compliance BEFORE code-quality (this mirrors compose:subagent's two-stage gate):\n" +
  "### Stage 1 — Spec compliance (evidence-gated)\n" +
  "Run `git diff` (e.g. `git diff HEAD~<n>..HEAD`, or against the run's base) to see EXACTLY what changed, and read the changed files. " +
  "For each acceptance criterion below, confirm with evidence from the diff/tests that it is met. Anything unmet or unverifiable is a CRITICAL finding. " +
  "Do this from the diff + spec ALONE first — do not assume the implementer's claims are correct.\n" +
  "### Stage 2 — Code quality\n" +
  "Only once spec compliance holds, review the diff for quality: correctness bugs, missing error handling at real boundaries, tests that don't test, dead code, simplification.\n\n" +
  "## Overall task\n" + TASK + "\n\n" +
  intentBlock +
  "## What was implemented (acceptance criteria to verify)\n" + IMPLEMENTED_DIGEST + "\n\n" +
  "## What to produce\n" +
  "Triage findings into critical (must fix before merge — includes ANY unmet spec/acceptance), important (should fix), and minor (nits). " +
  "Set readyToMerge=true ONLY if critical is empty AND every acceptance criterion is met with evidence.\n\n" +
  "Return structured output only.",
  { label: "review", phase: "Review", schema: REVIEW_SHAPE }
)

const runFixTask = (finding, i, isolate) => agent(
  "Address the CRITICAL review finding below. Apply the `compose:tdd` skill to fix it with tests where possible. " +
  "Use the `skill` tool to load it first.\n\n" +
  "## Critical finding (" + (i + 1) + ")\n" + finding + "\n\n" +
  "Fix it with the `write`/`edit` tools and commit " + (isolate ? "inside this worktree." : "in the workspace."),
  isolate ? { label: "fix:" + i, phase: "Fix", isolation: "worktree" } : { label: "fix:" + i, phase: "Fix" }
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
    // Same per-batch rule as implement: isolate (worktree per fix) when >1 critical
    // fix would run concurrently, or when forced; otherwise sequential in main workspace.
    const ISOLATE = isolateBatch(review.critical.map((_, i) => "fix-" + i))
    const limit = ISOLATE ? Math.min(MAX_CONCURRENT, review.critical.length) : 1
    const perTaskResults = []
    const kept = []
    const criticals = review.critical
    for (let i = 0; i < criticals.length; i += limit) {
      const chunk = criticals.slice(i, i + limit)
      const results = await parallel(chunk.map((finding, k) => () => runFixTask(finding, i + k, ISOLATE)))
      for (let j = 0; j < chunk.length; j++) {
        const r = results[j]
        if (ISOLATE) {
          const wt = r && typeof r === "object" ? r._worktree : null
          if (wt && wt.changed) {
            kept.push({ taskId: "fix-" + (i + j), _worktree: wt })
            perTaskResults.push({ taskId: "fix-" + (i + j), status: "ok", branch: wt.branch })
          } else {
            perTaskResults.push({ taskId: "fix-" + (i + j), status: r === null ? "failed" : "pristine" })
          }
        } else {
          perTaskResults.push({ taskId: "fix-" + (i + j), status: r === null ? "failed" : "ok" })
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
      type, brainstorm, design, batches, verifyHistory, implementHistory, fixHistory, review,
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
  // The agent writes the consolidated final report file; the workflow only gates
  // on existence. No schema — writing the markdown is the deliverable.
  await agent(
    "Apply the `compose:report` skill in FINAL consolidation mode. Use the `skill` tool to load it first.\n\n" +
    docsBlock + "\n\n" +
    "## Report file you MUST write (read the in-progress per-iteration file, overwrite with canonical final state)\n" + REPORT_PATH + "\n\n" +
    "## Overall task\n" + TASK + "\n\n" +
    "## Run history\n" +
    "verifyHistory: " + JSON.stringify(verifyHistory) + "\n" +
    "implementHistory: " + JSON.stringify(implementHistory) + "\n" +
    "reviewFixAttempts: " + reviewFixAttempts + "\n" +
    "review: " + JSON.stringify(review) + "\n\n" +
    "Produce the final-state report (What Was Built / Architecture / Design Decisions / Usage / Verification / Journey Log / Source Materials). " +
    "Distill the Journey Log to at most 5 entries. Write the file with the `write` tool, then commit it. " +
    "Writing the file is the deliverable — do not just describe it.",
    { label: "final-report", phase: "Report" }
  )
  // Re-dispatch once if the agent skipped the write.
  if (!(await exists(REPORT_PATH))) {
    await agent(
      "The final report file `" + REPORT_PATH + "` does not exist yet. Apply `compose:report` and WRITE it now with the `write` tool " +
      "(What Was Built / Architecture / Design Decisions / Usage / Verification / Journey Log / Source Materials) for the task: " + TASK,
      { label: "final-report-retry", phase: "Report" }
    )
  }
  finalReport = { path: REPORT_PATH, written: await exists(REPORT_PATH) }
}

// ---------------------------------------------------------------------------
// Phase 7 — Merge
// ---------------------------------------------------------------------------
phase("Merge")
const merge = await agent(
  "Apply the `compose:merge` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## What was built (use this for the commit/PR message)\n" + IMPLEMENTED_DIGEST + "\n\n" +
  ((review && (_arr(review.important).length || _arr(review.minor).length))
    ? "## Review outcome (critical cleared; note any deferred items)\n" +
      (_arr(review.important).length ? "Important (should follow up):\n" + _arr(review.important).map((x) => "- " + x).join("\n") + "\n" : "") +
      (_arr(review.minor).length ? "Minor (nits):\n" + _arr(review.minor).map((x) => "- " + x).join("\n") + "\n" : "") + "\n"
    : "") +
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
    type, brainstorm, design, batches, verifyHistory, implementHistory, review, finalReport,
    merge: merge || { committed: false, action: "none" },
    attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
  }
}

return {
  brainstorm,
  type,
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
    agents: verifyHistory.length + tddAttempts + reviewFixAttempts + 4, // brainstorm + design-write + design-extract + review + merge (approx)
    phases: 7,
    parallelBatches: batches.length,
    durationMs: 0, // QuickJS guest has no Date; host can compute from journal if needed
  },
}
