export const meta = {
  name: "deep-research",
  description:
    "Deep research report generator — brief → plan angles → parallel sub-agents → reflect → single-writer cited report → cold review. Convergent (resumable via file checkpoints).",
  whenToUse:
    'Use when the user wants a comprehensive, multi-source investigation written as a cited Markdown report. Best for broad research questions ("survey X", "what are the recent advances in Y", "compare the options for Z"). NOT for simple lookups (single WebSearch suffices) and NOT for precise fact-checking (use fact-check workflow instead). If the request is broad, ask one narrowing question first, then pass the refined question as args.',
  phases: [
    { title: "Brief", detail: "Refine the question into an unambiguous research brief" },
    { title: "Plan", detail: "Decompose brief into independent research angles" },
    { title: "Research", detail: "One sub-agent per angle in parallel, writing structured findings to disk" },
    { title: "Reflect", detail: "Gap-check against brief; spawn delta sub-agents if budget allows" },
    { title: "Write", detail: "Single agent writes the full cited Markdown report" },
    { title: "Review", detail: "Independent reviewer spot-checks citations; fix pass if needed" },
  ],
};

// Sandbox exposes `args` as a JSON value — normalize bare strings gracefully.
const _a = (() => {
  if (args == null || args === undefined) return {};
  if (typeof args === "string") {
    try { const p = JSON.parse(args); return (typeof p === "object" && p !== null) ? p : { question: args }; }
    catch { return { question: args }; }
  }
  return typeof args === "object" ? args : {};
})();
const question = _a.question;
if (!question) throw new Error("args.question is required — pass {question: \"...\"} or a bare question string as args");
const dir = _a.dir ?? ".";
const today = _a.today;
if (!today) throw new Error("args.today (YYYY-MM-DD) is required — the host auto-injects this for built-in runs; if calling from a user script, pass it manually");

// Hard budgets per depth — enforced by script, not by LLM judgment.
const DEPTH = {
  quick: { angles: 3, queryBudget: 4, deltaAngles: 0, sources: 8 },
  standard: { angles: 5, queryBudget: 6, deltaAngles: 3, sources: 15 },
  deep: { angles: 8, queryBudget: 8, deltaAngles: 4, sources: 25 },
}[_a.depth ?? "standard"];
if (!DEPTH) throw new Error(`invalid depth: ${_a.depth}`);

// Locked sub-agent prompt template.
const subagentPrompt = (n, angle, briefContext) => `You are a research sub-agent. Today is ${today}.

Research context: ${briefContext}

Your ONLY task — research this single angle, nothing else:
${angle}

Rules:
1. Run up to ${DEPTH.queryBudget} web searches. Start with 2-3 differently-phrased queries in parallel; refine based on what comes back. Prefer primary sources (official docs, papers, original announcements) over aggregators and SEO farms. If the WebSearch tool is unavailable, use DuckDuckGo HTML as fallback: WebFetch https://html.duckduckgo.com/html/?q=<query> (decode uddg param for real URLs). Also try free APIs: arXiv, Semantic Scholar, GitHub search, HN Algolia.
2. WebFetch the 3-6 most promising results to read actual content. Do not cite a page you did not fetch.
3. Judge each source: official/primary > reputable media/peer-reviewed > forums/blogs > content farms. Discard low-quality sources rather than citing them.
4. Extract findings as information-dense claims: include exact entities, numbers, dates, versions. One claim per finding.
5. Write your findings to findings/F${n}.md in EXACTLY this format:

# F${n}: ${angle}

## Findings

### [1] <one-sentence claim>
- quote: "<short verbatim supporting quote>"
- url: <source URL>
- source_type: primary | secondary | community
- published: <date if known, else unknown>
- confidence: high | medium | low

### [2] ...

## Dead ends
- <queries or sources that yielded nothing useful, one line each>

## Suggested follow-ups
- <at most 3 narrower questions worth a deeper look, or "none">

6. Aim for 5-12 findings. Depth beats breadth: 6 solid sourced claims beat 15 vague ones.
7. If the angle turns out unanswerable or results are thin, still write the file with whatever you found and say so under Dead ends.

Return ONLY: a 3-5 line summary, the file path written, finding count, overall confidence. Do NOT return raw page content.`;

// ---------- Phase 1: Brief ----------
phase("Brief");
if (!(await exists("brief.md"))) {
  const ok = await agent(
    `You are the scoping step of a deep research run. Today is ${today}. No user is available — do NOT ask questions; write assumptions instead.
Research question (verbatim from user): "${question}"
${_a.context ? `Additional context from the requester: ${_a.context}` : ""}
Write brief.md with sections:
# Research Brief
**Date**: ${today} · **Depth**: ${_a.depth ?? "standard"}
## Question — the refined, unambiguous research question
## Scope — In: ... / Out: ... (explicit boundaries)
## Assumptions — audience, time frame, region, language; every guess you made goes here
Do nothing else. Do not plan angles yet.`
  );
  if (!ok || !(await exists("brief.md"))) throw new Error("brief step failed: brief.md not created");
}
log("brief.md ready");

// ---------- Phase 2: Plan angles ----------
phase("Plan");
const anglesSchema = {
  type: "object",
  properties: {
    briefContext: { type: "string", description: "2-3 line compression of the brief (topic, time frame, audience) to hand to sub-agents" },
    angles: { type: "array", items: { type: "string" }, description: "independent research angles, one sentence each" },
  },
  required: ["briefContext", "angles"],
};
let plan;
if (await exists("plan.json")) {
  plan = JSON.parse(await readFile("plan.json"));
} else {
  plan = await agent(
    `You are the planning step of a deep research run. Read brief.md.
Decompose it into 3-${DEPTH.angles} INDEPENDENT research angles (no overlap; each answerable alone). Draw from these lenses as applicable: core facts/definitions · recent developments · quantitative data/benchmarks · counter-arguments & failure cases · practitioner experience · academic work · key players/alternatives.
Also compress the brief into a 2-3 line briefContext for sub-agents.`,
    { schema: anglesSchema }
  );
  if (!plan || !plan.angles || plan.angles.length === 0) throw new Error("planning failed: no angles");
  plan.angles = plan.angles.slice(0, DEPTH.angles); // hard cap
  await writeFile("plan.json", JSON.stringify(plan, null, 2));
}
log(`${plan.angles.length} angles planned`);

// ---------- Phase 3: Parallel research (round 1) ----------
phase("Research");
const round1 = [];
for (let i = 0; i < plan.angles.length; i++) {
  const n = i + 1;
  if (!(await exists(`findings/F${n}.md`))) round1.push({ n, angle: plan.angles[i] });
}
log(`${plan.angles.length - round1.length} findings exist, ${round1.length} to research`);
if (round1.length > 0) {
  await parallel(round1.map(({ n, angle }) => () => agent(subagentPrompt(n, angle, plan.briefContext))));
}
let findingFiles = await glob("findings/F*.md");
if (findingFiles.length === 0) throw new Error("research round 1 produced no findings files");
log(`round 1 done: ${findingFiles.length} findings files`);

// ---------- Phase 4: Reflect (one round, hard-capped) ----------
phase("Reflect");
if (DEPTH.deltaAngles > 0 && !(await exists("reflect.json"))) {
  const reflect = await agent(
    `You are the reflection step of a deep research run. Read brief.md and EVERY file in findings/.
Against the brief, identify: (a) parts of the brief with no evidence; (b) major claims resting on a single source; (c) conflicts between sources worth resolving. Also consider the "Suggested follow-ups" sections in the findings.
Output at most ${DEPTH.deltaAngles} delta-angles — narrow, targeted research questions that would close the most important gaps. If coverage is already sufficient, output an empty array. Also list unresolved gaps that should surface in the report's "Open questions" section.`,
    {
      schema: {
        type: "object",
        properties: {
          deltaAngles: { type: "array", items: { type: "string" } },
          openQuestions: { type: "array", items: { type: "string" } },
        },
        required: ["deltaAngles", "openQuestions"],
      },
    }
  );
  const safe = reflect ?? { deltaAngles: [], openQuestions: [] };
  safe.deltaAngles = (safe.deltaAngles || []).slice(0, DEPTH.deltaAngles); // hard cap
  await writeFile("reflect.json", JSON.stringify(safe, null, 2));
}
const reflect = (await exists("reflect.json"))
  ? JSON.parse(await readFile("reflect.json"))
  : { deltaAngles: [], openQuestions: [] };

if (reflect.deltaAngles.length > 0) {
  phase("Research (delta)");
  const base = plan.angles.length;
  const round2 = [];
  for (let i = 0; i < reflect.deltaAngles.length; i++) {
    const n = base + i + 1;
    if (!(await exists(`findings/F${n}.md`))) round2.push({ n, angle: reflect.deltaAngles[i] });
  }
  if (round2.length > 0) {
    await parallel(round2.map(({ n, angle }) => () => agent(subagentPrompt(n, angle, plan.briefContext))));
  }
  log("delta round done");
}
findingFiles = await glob("findings/F*.md");

// ---------- Phase 5: Write (single-point) ----------
phase("Write");
if (!(await exists("REPORT.md"))) {
  await agent(
    `You are the SOLE writer of a deep research report. Read brief.md, reflect.json (openQuestions), and EVERY file in findings/.
Write REPORT.md in one pass. Header: "> Generated ${today} · depth: ${_a.depth ?? "standard"} · workspace: ${dir}".
Report structure: Executive summary (5-10 bullet conclusions with [n] citations) → Background & scope → Body sections organized by THEME (not by findings file) → Open questions (seeded from reflect.json) → Sources (numbered, dedup URLs, access date ${today}).
Hard rules: every non-obvious claim carries [n] resolving to a Sources entry whose URL appears in some findings file — never cite from memory; conflicts presented with both sides and dates; [single source] and [speculative] flags where applicable.
Do NOT re-search. If a gap blocks a section, state the gap.`
  );
  if (!(await exists("REPORT.md"))) throw new Error("write step failed: REPORT.md not created");
}
log("REPORT.md ready");

// ---------- Phase 6: Cold review ----------
phase("Review");
const review = await agent(
  `You are an independent reviewer with NO prior context — judge only from files.
Read REPORT.md and every file in findings/.
Check: (a) claims lacking citations that need one; (b) spot-check 5 random [n] citations — does the URL exist in some findings file and plausibly support the sentence?; (c) conclusions stronger than the evidence; (d) executive summary consistent with body.
Write findings to REVIEW.md.`,
  {
    schema: {
      type: "object",
      properties: {
        critical: { type: "number", description: "count of fabricated-citation or unsupported-claim findings" },
        summary: { type: "string" },
      },
      required: ["critical", "summary"],
    },
  }
);
log(`review: ${review ? review.summary : "reviewer failed"}`);

if (review && review.critical > 0) {
  phase("Fix");
  await agent(
    `Read REVIEW.md and fix REPORT.md accordingly: re-anchor citations to URLs actually present in findings/, otherwise weaken or remove unsupported claims. Never invent new sources.`
  );
}

return {
  angles: plan.angles.length,
  deltaAngles: reflect.deltaAngles.length,
  findingsFiles: findingFiles.length,
  reviewCritical: review ? review.critical : null,
  report: `${dir}/REPORT.md`,
};
