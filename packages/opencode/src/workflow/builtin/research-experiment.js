export const meta = {
  name: "research-experiment",
  description:
    "Autonomous experiment loop — establishes a baseline, then runs stateless iterations (hypothesize → implement → run → dual-gate) with a JS-enforced escalation ladder, a cheating audit by fresh eyes, and a report where every number traces to results.tsv.",
  whenToUse:
    "Use when the user wants to autonomously improve a mechanically-verifiable metric of a codebase (training loss, benchmark score, latency, solver quality) without supervision. Requires up-front: an eval command with a fixed budget that prints the metric, and an explicit editable-file scope. Not for tasks whose success cannot be reduced to one number.",
  phases: [
    { title: "Baseline", detail: "Record PLAN.md, git-commit current state, run the eval once, seed results.tsv" },
    { title: "Loop", detail: "Stateless iterations; keep/revert decided by the script, not the agent; 3-fail REFINE / 5-fail PIVOT / 3-pivot STOP ladder" },
    { title: "Audit", detail: "Independent agent checks kept diffs for metric gaming (eval tampering, hardcoded outputs, leakage)" },
    { title: "Report", detail: "Baseline vs best, per-change delta table, dead ends, reproduce command" },
  ],
}

// args (JSON object):
//   dir            absolute path of the experiment repo (pass the same value as the run's `workspace`)
//   goal           one-line goal, e.g. "reduce val loss of train.py"
//   metric         how to mechanically extract the number, e.g. "line matching /val_loss=([0-9.]+)/ in eval output"
//   evalCmd        exact shell command with a FIXED budget that prints the metric
//   editable       comma-separated files/globs the loop may modify; everything else is read-only
//   guardCmd?      regression command that must keep exit code 0
//   lowerIsBetter? default true
//   maxIters?      default 15
//   targetValue?   stop early when best passes this value
const A = typeof args === "string" ? JSON.parse(args) : args
const dir = A.dir
for (const k of ["dir", "goal", "metric", "evalCmd", "editable"])
  if (!A[k]) throw new Error(`args.${k} is required`)
const lowerIsBetter = A.lowerIsBetter ?? true
const maxIters = A.maxIters ?? 15
const guardCmd = A.guardCmd || null

// Subagents locate the auto-research skill themselves — its extraction path is
// version-dependent, so prompts must not hardcode it.
const SKILL_HINT =
  'Load the "auto-research" skill (skill tool) if you need its scripts (paper_search.py etc.) or its references/experiment-loop.md.'

const better = (a, b) => (lowerIsBetter ? a < b : a > b)
const runSchema = {
  type: "object",
  properties: {
    metricValue: { type: ["number", "null"], description: "extracted metric, null if run failed" },
    guardPass: { type: "boolean" },
    hypothesis: { type: "string", description: "one line: what was tried and why" },
    error: { type: ["string", "null"] },
  },
  required: ["metricValue", "guardPass", "hypothesis"],
}

// ---------- Phase 1: Baseline ----------
phase("Baseline")
let state = (await exists("artifacts/state.json")) ? JSON.parse(await readFile("artifacts/state.json")) : null
if (!state) {
  const r = await agent(
    `You are setting up an autonomous experiment loop. ${SKILL_HINT}
Repo: ${dir}. Goal: ${A.goal}.
1. Write ${dir}/PLAN.md recording: metric (${A.metric}), eval command (${A.evalCmd}), editable scope (${A.editable}), guard (${guardCmd ?? "none"}), stop (${maxIters} iters${A.targetValue !== undefined ? `, target ${A.targetValue}` : ""}).
2. git init if needed; commit current state as baseline.
3. Run the eval command EXACTLY as given, redirecting: (${A.evalCmd}) > ${dir}/artifacts/run_0.log 2>&1 (mkdir -p artifacts). Extract the metric per: ${A.metric}.
4. ${guardCmd ? `Run guard: ${guardCmd}; report exit status.` : "No guard configured; report guardPass=true."}
5. Create ${dir}/artifacts/results.tsv with header "iter\\tcommit\\tmetric\\tdelta\\tverdict\\tdescription" and the baseline row.
Do NOT modify any source file in this step.`,
    { schema: runSchema },
  )
  if (!r || r.metricValue === null)
    throw new Error(`baseline failed: ${r ? r.error : "agent failed"} — fix the eval command and rerun`)
  state = { best: r.metricValue, baseline: r.metricValue, iter: 0, fails: 0, pivots: 0, mode: "NORMAL", history: [] }
  await writeFile("artifacts/state.json", JSON.stringify(state, null, 2))
  log(`baseline metric: ${r.metricValue}`)
} else {
  log(`resuming at iter ${state.iter}, best=${state.best}, mode=${state.mode}`)
}

// ---------- Phase 2: Loop (stateless iterations; the ladder lives HERE, not in prompts) ----------
phase("Loop")
let stopReason = "max iterations"
while (state.iter < maxIters) {
  state.iter++

  // escalation ladder — deterministic, the agent cannot drift it
  if (state.mode === "NORMAL" && state.fails >= 3) state.mode = "REFINE"
  if (state.fails >= 5) {
    state.pivots++
    state.fails = 0
    state.mode = state.pivots >= 2 ? "RESEARCH" : "PIVOT-NEW"
    if (state.pivots >= 3) {
      stopReason = "3 pivots without progress"
      break
    }
  }

  const modeInstr = {
    NORMAL: "Propose ONE new hypothesis. Check LOG.md/results.tsv — never retry a logged dead end.",
    REFINE:
      "3 consecutive fails: do NOT pick a random new idea. Re-read the last failing run logs in artifacts/ and VARY the current hypothesis based on what the logs show.",
    "PIVOT-NEW":
      "5 consecutive fails: abandon this direction entirely. Pick a hypothesis from an ORTHOGONAL family (different mechanism, not a variation).",
    RESEARCH:
      "2 pivots without progress: first search literature with the auto-research skill's scripts/paper_search.py — mine abstracts for an approach not yet tried, then implement it.",
  }[state.mode]

  const r = await agent(
    `You are ONE iteration of an autonomous experiment loop. You have no memory of prior iterations — the files are the state. ${SKILL_HINT}
Read in order: ${dir}/PLAN.md, ${dir}/artifacts/results.tsv, tail of ${dir}/LOG.md.
Goal: ${A.goal}. Current best metric: ${state.best} (${lowerIsBetter ? "lower" : "higher"} is better). Iteration ${state.iter}/${maxIters}. Mode: ${state.mode}.
${modeInstr}
Then:
1. IMPLEMENT the smallest change testing the hypothesis. You may ONLY modify: ${A.editable}. NEVER touch the eval command, eval data, or metric extraction — if the metric can only improve by changing those, stop and report error "eval conflict".
2. git add -A && git commit -m "trial iter ${state.iter}: <hypothesis>"
3. RUN: (${A.evalCmd}) > ${dir}/artifacts/run_${state.iter}.log 2>&1 — never dump raw output to your context; grep the metric per: ${A.metric}.
4. ${guardCmd ? `GUARD: run ${guardCmd}; guardPass = (exit code 0).` : "guardPass=true."}
5. Append one line describing hypothesis + raw outcome to ${dir}/LOG.md.
Report the extracted metric (null if the run crashed), guardPass, and the one-line hypothesis. Do NOT decide keep/revert — that is not your job.`,
    { schema: runSchema, timeout_ms: 1000 * 60 * 30 },
  )

  // verdict — decided by the script, not by the agent
  const m = r ? r.metricValue : null
  const prevBest = state.best
  const improved = m !== null && better(m, state.best)
  const pass = improved && r.guardPass !== false
  const verdict =
    r === null ? "AGENT_FAIL" : m === null ? "RUN_FAIL" : !r.guardPass ? "GUARD_FAIL" : improved ? "KEPT" : "NO_GAIN"

  if (pass) {
    state.best = m
    state.fails = 0
    state.mode = "NORMAL"
  } else {
    state.fails++
    await agent(
      `In repo ${dir}: the last trial commit failed its gate (${verdict}). Revert with "git reset --hard HEAD~1" ONLY IF the latest commit message starts with "trial iter ${state.iter}:". Otherwise do nothing and report what you see. ${dir}/artifacts and ${dir}/LOG.md must survive (they should be gitignored; if tracked, use git checkout on source files instead).`,
    )
  }

  const row = `${state.iter}\t${verdict === "KEPT" ? "kept" : "reverted"}\t${m ?? "NA"}\t${m !== null ? (m - prevBest).toFixed(6) : "NA"}\t${verdict}\t${r ? r.hypothesis : "agent failure"}`
  const tsv = (await readFile("artifacts/results.tsv")) || ""
  await writeFile("artifacts/results.tsv", tsv.trimEnd() + "\n" + row + "\n")
  state.history.push({ iter: state.iter, metric: m, verdict })
  await writeFile("artifacts/state.json", JSON.stringify(state, null, 2))
  log(`iter ${state.iter}: ${verdict} metric=${m ?? "NA"} best=${state.best} fails=${state.fails} pivots=${state.pivots}`)

  if (A.targetValue !== undefined && better(state.best, A.targetValue)) {
    stopReason = "target reached"
    break
  }
}

// ---------- Phase 3: Cheating audit (fresh eyes, diff only) ----------
phase("Audit")
const audit = await agent(
  `You are an independent auditor with no context on this project. In repo ${dir}:
Run "git log --oneline" and "git diff <baseline-commit> HEAD -- ." to see all KEPT changes (baseline is the first commit). Read ${dir}/PLAN.md for the eval command and ${dir}/artifacts/results.tsv.
Question: does any kept change game the metric instead of genuinely improving it? Check for: eval/data tampering, hardcoded or memorized outputs, metric-extraction manipulation, test-set leakage, self-normalized scores.
Write findings to ${dir}/artifacts/AUDIT.md.`,
  {
    schema: {
      type: "object",
      properties: { clean: { type: "boolean" }, findings: { type: "string" } },
      required: ["clean", "findings"],
    },
  },
)
log(`audit: ${audit ? (audit.clean ? "clean" : "FINDINGS: " + audit.findings) : "auditor failed"}`)

// ---------- Phase 4: Report ----------
phase("Report")
await agent(
  `Write ${dir}/REPORT.md for this experiment run. Sources of truth: ${dir}/PLAN.md, ${dir}/artifacts/results.tsv, ${dir}/LOG.md, ${dir}/artifacts/AUDIT.md, git log.
Contents: baseline vs final metric; table of KEPT changes with per-change delta (from results.tsv only — never narrate numbers not in the tsv); dead ends and why they failed; audit outcome; exact reproduce command. Stop reason: ${stopReason}.`,
)

return {
  baseline: state.baseline,
  best: state.best,
  iterations: state.iter,
  stopReason,
  auditClean: audit ? audit.clean : null,
  report: `${dir}/REPORT.md`,
}
