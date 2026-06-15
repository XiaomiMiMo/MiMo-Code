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

// Placeholder return — replaced in subsequent tasks.
return { type, classification, design, todo: "impl+review+merge" }
