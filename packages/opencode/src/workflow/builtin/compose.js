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
return { ok: true, todo: "implement phases" }
