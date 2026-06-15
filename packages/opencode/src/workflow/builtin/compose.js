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

// Placeholder body — replaced in subsequent tasks.
return { ok: true, todo: "implement phases" }
