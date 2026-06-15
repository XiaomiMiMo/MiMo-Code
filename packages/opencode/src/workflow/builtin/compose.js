export const meta = {
  name: "compose",
  description: "Autonomous compose pipeline — classifies a task and runs plan→tdd→verify→review→merge with bounded retry, all in never-ask mode.",
  whenToUse: "Use to drive a feature, bugfix, refactor, or review-feedback task through the full compose flow without user prompting. Pass args.task = the user's request. Optionally pass args.type to skip classification.",
  phases: [
    { title: "Classify", detail: "Decide task type (feature/bugfix/refactor/feedback)" },
    { title: "Design", detail: "Apply compose:plan, compose:debug, or compose:feedback by type" },
    { title: "Implement", detail: "compose:tdd loop, retry on verify failure (≤3)" },
    { title: "Verify", detail: "Run project verify commands; structured pass/fail" },
    { title: "Review", detail: "compose:review for critical/important/minor issues" },
    { title: "Merge", detail: "compose:merge to commit (and optionally push/PR)" },
  ],
}

const MAX_TDD_ATTEMPTS = 3
const MAX_REVIEW_FIX_ATTEMPTS = 2

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
        },
      },
    },
    notes: { type: "string" },
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

// Placeholder body — replaced in subsequent tasks.
const TASK = (typeof args === "object" && args && typeof args.task === "string") ? args.task : ""
if (!TASK) {
  return { error: "no-task", message: "Pass args.task = '<request>'." }
}

const VALID_TYPES = ["feature", "bugfix", "refactor", "feedback"]
const argType = (typeof args === "object" && args && typeof args.type === "string") ? args.type : ""

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

phase("Design")
const designSkill = SKILL_BY_TYPE[type] || "compose:plan"
const design = await agent(
  "Apply the `" + designSkill + "` skill to the task below. Use the `skill` tool to load the skill before working.\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## What to produce\n" +
  "A task list of bite-sized work items, each with id, description, and acceptance criteria. " +
  "Optionally list the files each task touches.\n\n" +
  "Return structured output only.",
  { label: "design:" + type, phase: "Design", schema: DESIGN_SHAPE }
)
if (!design) {
  return { error: "design-failed", type, classification }
}
log("Designed " + design.tasks.length + " task(s) using " + designSkill)

const TASKS_DIGEST = design.tasks.map((t, i) => (i + 1) + ". " + t.id + ": " + t.description + " — " + t.acceptance).join("\n")

const runVerify = () => agent(
  "Run the project's verification commands and report the outcome.\n\n" +
  "## Steps\n" +
  "1. Inspect AGENTS.md / CLAUDE.md / package.json for the project's verify commands (typecheck, test, build).\n" +
  "2. Run them via the Bash tool, in the right directory (e.g. `packages/<x>/` not the repo root if AGENTS.md says so).\n" +
  "3. Capture passed/failed test counts. Summarize failures concisely if any.\n\n" +
  "Return structured output only.",
  { label: "verify", phase: "Verify", schema: VERIFY_SHAPE }
)

const runImplement = (failuresOrEmpty) => agent(
  "Apply the `compose:tdd` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Task\n" + TASK + "\n\n" +
  "## Plan\n" + TASKS_DIGEST + "\n\n" +
  (failuresOrEmpty ? "## Verify failures from previous attempt — focus on these\n" + failuresOrEmpty + "\n\n" : "") +
  "Implement the plan. Write the failing test first, then the minimal code to pass, then refactor. " +
  "Commit each task as you complete it.",
  { label: "implement", phase: "Implement" }
)

const runDebug = (failures) => agent(
  "Apply the `compose:debug` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Verify failures\n" + failures + "\n\n" +
  "Identify the root cause and fix it. Do not paper over symptoms.",
  { label: "debug", phase: "Implement" }
)

phase("Implement")
const verifyHistory = []
let verify = null
let tddAttempts = 0
for (let attempt = 0; attempt < MAX_TDD_ATTEMPTS; attempt++) {
  tddAttempts = attempt + 1
  await runImplement(attempt === 0 ? "" : (verify && verify.failures ? verify.failures : ""))
  verify = await runVerify()
  if (verify) verifyHistory.push(verify)
  if (verify && verify.allPassed) {
    log("Verify passed on attempt " + tddAttempts)
    break
  }
  if (attempt + 1 === MAX_TDD_ATTEMPTS) {
    return { error: "verify-exhausted", type, classification, design, verifyHistory, attempts: MAX_TDD_ATTEMPTS }
  }
  await runDebug(verify ? (verify.failures || "verify returned no detail") : "verify agent failed (null)")
}

const runReview = () => agent(
  "Apply the `compose:review` skill. Use the `skill` tool to load it before working.\n\n" +
  "## Task context\n" + TASK + "\n\n" +
  "## What to produce\n" +
  "Triage findings into critical (must fix before merge), important (should fix), and minor (nits). " +
  "Set readyToMerge=true only if critical is empty.\n\n" +
  "Return structured output only.",
  { label: "review", phase: "Review", schema: REVIEW_SHAPE }
)

const runFix = (criticalList) => agent(
  "Address the CRITICAL review findings below. Apply the `compose:tdd` skill to fix them with tests where possible.\n\n" +
  "## Critical findings\n" + criticalList.map((c, i) => (i + 1) + ". " + c).join("\n") + "\n\n" +
  "Fix each, then commit.",
  { label: "fix", phase: "Review" }
)

phase("Review")
let review = await runReview()
if (!review) review = { critical: [], important: [], minor: [], readyToMerge: true }
let reviewFixAttempts = 0

if (review.critical && review.critical.length > 0) {
  phase("Fix")
  for (let attempt = 0; attempt < MAX_REVIEW_FIX_ATTEMPTS; attempt++) {
    reviewFixAttempts = attempt + 1
    await runFix(review.critical)
    const reverify = await runVerify()
    if (reverify) verifyHistory.push(reverify)
    review = await runReview()
    if (!review) review = { critical: [], important: [], minor: [], readyToMerge: false }
    if (!review.critical || review.critical.length === 0) {
      log("Critical issues cleared on fix attempt " + reviewFixAttempts)
      break
    }
  }
  if (review.critical && review.critical.length > 0) {
    return {
      readyToMerge: false,
      type, classification, design, verifyHistory, review,
      attempts: { tdd: tddAttempts, reviewFix: reviewFixAttempts },
    }
  }
}

// Placeholder return — replaced in next task.
return { type, classification, design, verifyHistory, review, todo: "merge" }
