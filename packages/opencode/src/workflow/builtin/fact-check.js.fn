export const meta = {
  name: 'fact-check',
  description: 'Fact-check orchestrator — runs parallel web searches, reads the strongest sources, cross-checks each fact with an adversarial jury, and returns verified findings.',
  whenToUse: 'Use when the user wants to verify specific claims or get a fact-checked answer to a precise question. Searches multiple sources, extracts checkable facts, then runs an adversarial jury that votes to keep or reject each one. Best for: "Is X true?", "Verify this claim", "What does the evidence actually say about Y?".',
  phases: [
    { title: "Plan", detail: "Break the question (from args) into several complementary search lines" },
    { title: "Search", detail: "One web-search agent per line, in parallel" },
    { title: "Extract", detail: "De-duplicate URLs, read the top sources, pull out checkable facts" },
    { title: "Group", detail: "Fold facts that assert the same thing into one so each is checked once" },
    { title: "Crosscheck", detail: "Adversarial jury per fact — a majority of reject votes drops it" },
    { title: "Report", detail: "Rank survivors by certainty, merge, and cite" },
  ],
}

// Tunables.
const JURY_SIZE = 3        // crosscheck voters per fact
const REJECT_QUORUM = 2    // reject votes that kill a fact AND the min valid votes needed to keep one
const SOURCE_BUDGET = 15   // hard cap on how many URLs we actually read
const FACT_CAP = 25        // hard cap on facts that reach crosscheck

// ─── Structured-output shapes ───
const PLAN_SHAPE = {
  type: "object", required: ["question", "lines"],
  properties: {
    question: { type: "string" },
    strategy: { type: "string" },
    lines: { type: "array", minItems: 3, maxItems: 6, items: {
      type: "object", required: ["topic", "query"],
      properties: {
        topic: { type: "string" },
        query: { type: "string" },
        why: { type: "string" },
      },
    }},
  },
}
const HITS_SHAPE = {
  type: "object", required: ["hits"],
  properties: {
    hits: { type: "array", maxItems: 6, items: {
      type: "object", required: ["url", "title", "fit"],
      properties: {
        url: { type: "string" },
        title: { type: "string" },
        note: { type: "string" },
        fit: { enum: ["high", "medium", "low"] },
      },
    }},
  },
}
const READ_SHAPE = {
  type: "object", required: ["facts", "tier"],
  properties: {
    tier: { enum: ["primary", "secondary", "blog", "forum", "weak"] },
    published: { type: "string" },
    facts: { type: "array", maxItems: 5, items: {
      type: "object", required: ["statement", "excerpt", "weight"],
      properties: {
        statement: { type: "string" },
        excerpt: { type: "string" },
        weight: { enum: ["key", "support", "aside"] },
      },
    }},
  },
}
const RULING_SHAPE = {
  type: "object", required: ["reject", "reason", "certainty"],
  properties: {
    reject: { type: "boolean" },
    reason: { type: "string" },
    certainty: { enum: ["high", "medium", "low"] },
    counter: { type: "string" },
  },
}
const GROUP_SHAPE = {
  type: "object", required: ["groups"],
  properties: {
    groups: { type: "array", items: {
      type: "object", required: ["canonical", "members"],
      properties: {
        canonical: { type: "string" },
        members: { type: "array", items: { type: "number" } },
        urls: { type: "array", items: { type: "string" } },
      },
    }},
  },
}
const REPORT_SHAPE = {
  type: "object", required: ["answer", "findings", "limits"],
  properties: {
    answer: { type: "string" },
    findings: { type: "array", items: {
      type: "object", required: ["point", "certainty", "sources", "basis"],
      properties: {
        point: { type: "string" },
        certainty: { enum: ["high", "medium", "low"] },
        sources: { type: "array", items: { type: "string" } },
        basis: { type: "string" },
        tally: { type: "string" },
      },
    }},
    limits: { type: "string" },
    followups: { type: "array", items: { type: "string" } },
  },
}

// ─── Plan: split the question into search lines ───
phase("Plan")
const TOPIC = (typeof args === "string" && args.trim()) || ""
if (!TOPIC) {
  return { error: "No research question provided. Pass the question as args." }
}
const plan = await agent(
  "You are planning a research sweep. Turn the question below into complementary web searches.\n\n" +
  "## Question\n" + TOPIC + "\n\n" +
  "## What to produce\n" +
  "Five web-search queries that, together, approach the question from different directions. Choose directions that fit the subject. A few patterns to draw on:\n" +
  "- general overview · technical/academic depth · latest developments · skeptical/opposing takes · hands-on/practitioner notes\n" +
  "- a clinical question might split into: mechanism · frequent causes · dangerous look-alikes · guideline sources · warning signs\n" +
  "- a software question might split into: current best practice · measured benchmarks · known limits · who actually ships it · cost & trade-offs\n\n" +
  "Keep each query tight enough to surface high-signal pages. Don't let two queries overlap.\n" +
  "Return the question (as given or lightly cleaned up), a one-line plan, and the search lines.\n\nReturn structured output only.",
  { label: "plan", schema: PLAN_SHAPE }
)
if (!plan) {
  return { error: "Planning step produced nothing — cannot split the question into searches." }
}
log("Q: " + TOPIC.slice(0, 80) + (TOPIC.length > 80 ? "…" : ""))
log("Split into " + plan.lines.length + " lines: " + plan.lines.map(l => l.topic).join(", "))

// ─── URL bookkeeping, shared as searchers report in ───
const canonURL = u => {
  try {
    const parsed = new URL(u)
    return (parsed.hostname.replace(/^www\./, "") + parsed.pathname.replace(/\/$/, "")).toLowerCase()
  } catch { return u.toLowerCase() }
}
const taken = new Map()
const repeats = []
const overflow = []
const FIT_RANK = { high: 0, medium: 1, low: 2 }
let slotsLeft = SOURCE_BUDGET

// ─── Agent prompts ───
const searchPrompt = (line) =>
  "You are one of several researchers, each chasing a different line of inquiry.\n\n" +
  "Overall question: \"" + TOPIC + "\"\n\n" +
  "Your line: **" + line.topic + "**" + (line.why ? " — " + line.why : "") + "\n" +
  "Suggested query: `" + line.query + "`\n\n" +
  "Run WebSearch (refine the query if you can do better) and hand back the 4-6 most useful results.\n" +
  "Judge usefulness against the OVERALL question, not just your query. Drop content farms and SEO spam.\n" +
  "Give each result a one-line note on why it matters.\n\nReturn structured output only."

const readPrompt = (source, line) =>
  "Read one source and pull out checkable facts.\n\n" +
  "Overall question: \"" + TOPIC + "\"\n\n" +
  "**URL:** " + source.url + "\n**Title:** " + source.title + "\n**Surfaced by:** the \"" + line + "\" line\n\n" +
  "## Steps\n1. Fetch the page with WebFetch.\n" +
  "2. Judge the source tier: primary (research / the institution itself), secondary (reporting), blog/opinion, forum, or weak/unreliable.\n" +
  "3. Pull 2-5 FALSIFIABLE facts that bear on the question. Each fact must:\n" +
  "   - state something concrete and checkable (no vague hand-waving)\n" +
  "   - quote the source verbatim as backing\n" +
  "   - be tagged key / support / aside relative to the question\n" +
  "4. Record the publish date if you can find it.\n\n" +
  "If the page won't load, is paywalled, or is off-topic, return facts: [] with tier: \"weak\".\n\nReturn structured output only."

const groupPrompt = (facts) =>
  "Fold together the facts below that assert the SAME thing, so each assertion gets checked only once.\n\n" +
  "Overall question: \"" + TOPIC + "\"\n\n" +
  "Merge only facts that make the same claim (even if worded differently or from different sources). " +
  "If you're unsure, leave them apart — collapsing two distinct facts can let a shaky one ride on a solid one's coattails.\n\n" +
  "## Facts (index: statement — source)\n" +
  facts.map((f, i) => i + ": " + f.statement + " — " + f.sourceUrl + " (" + f.tier + ")").join("\n") + "\n\n" +
  "Per group, return a single canonical wording, the member indices, and the combined source URLs.\n\nReturn structured output only."

const crosscheckPrompt = (fact, n) =>
  "You are juror " + (n + 1) + " of " + JURY_SIZE + ", and your job is to try to KNOCK THIS DOWN.\n\n" +
  "Stay skeptical. " + REJECT_QUORUM + " of " + JURY_SIZE + " jurors voting reject will drop the fact.\n\n" +
  "## Question in scope\n" + TOPIC + "\n\n" +
  "## Fact on trial\n\"" + fact.statement + "\"\n\n" +
  "**Source:** " + fact.sourceUrl + " (" + fact.tier + ")\n" +
  "**Backing quote:** \"" + fact.excerpt + "\"\n\n" +
  "## Run through these\n" +
  "1. Does the quote actually back the fact, or is the fact reaching beyond it?\n" +
  "2. Search for contradicting evidence — does any trustworthy source disagree or add big caveats?\n" +
  "3. Is the source strong enough for how bold the fact is? (big claims need primary sources)\n" +
  "4. Has it gone stale? (check dates — old facts in fast-moving areas are suspect)\n" +
  "5. Is it really marketing copy, a press release, a cherry-picked number, or forum chatter?\n\n" +
  "Vote **reject=true** when: the quote doesn't support it / something contradicts it / the source is too weak for the claim / it's outdated / it's spin.\n" +
  "Vote **reject=false** only when the fact is well-backed, current, and the source matches its boldness.\n" +
  "When genuinely unsure, reject. Your reason MUST be concrete.\n\nReturn structured output only."

// ─── Search → de-dup → read, streamed (no barrier between stages) ───
const perLine = await pipeline(
  plan.lines,

  line => agent(searchPrompt(line), {
    label: "search:" + line.topic, phase: "Search", schema: HITS_SHAPE
  }).then(r => {
    if (!r) return null
    log(line.topic + ": " + r.hits.length + " hits")
    return { line: line.topic, hits: r.hits }
  }),

  found => {
    // Stage 1 returns null when the search agent failed (over-cap, schema
    // reject, no-deliverable, etc.). pipeline() pipes that null straight here,
    // so guard before touching .hits — otherwise a single search miss crashes
    // the whole run with `cannot read property 'hits' of null` at line 207.
    // Returning null here drops this line's slot; perLine.flat().filter(Boolean)
    // at line 251 already prunes nulls when collecting `sources`.
    if (!found) return null
    const byFit = [...found.hits].sort((a, b) => FIT_RANK[a.fit] - FIT_RANK[b.fit])
    const fresh = byFit.filter(h => {
      const key = canonURL(h.url)
      if (taken.has(key)) {
        repeats.push({ ...h, line: found.line, sameAs: taken.get(key) })
        return false
      }
      // Once the read budget is gone, only still-admit top-fit pages.
      if (slotsLeft <= 0 && FIT_RANK[h.fit] >= 1) {
        overflow.push({ ...h, line: found.line })
        return false
      }
      taken.set(key, { line: found.line, title: h.title })
      slotsLeft--
      return true
    })
    if (fresh.length < found.hits.length) {
      log(found.line + ": " + fresh.length + " fresh (" + (found.hits.length - fresh.length) + " dropped)")
    }
    return parallel(
      fresh.map(source => () => {
        let host = "unknown"
        try { host = new URL(source.url).hostname.replace(/^www\./, "") } catch {}
        return agent(readPrompt(source, found.line), {
          label: "read:" + host,
          phase: "Extract",
          schema: READ_SHAPE,
        }).then(out => {
          // A skipped agent returns null — drop the entry (the flat().filter(Boolean)
          // below clears it) instead of routing it through .catch and falsely tagging it weak.
          if (!out) return null
          return {
            url: source.url, title: source.title, line: found.line,
            tier: out.tier, published: out.published,
            facts: out.facts.map(f => ({ ...f, sourceUrl: source.url, tier: out.tier })),
          }
        }).catch(e => {
          log("read failed: " + source.url + " — " + (e.message || e))
          return { url: source.url, title: source.title, line: found.line, tier: "weak", facts: [] }
        })
      })
    )
  }
)

const sources = perLine.flat().filter(Boolean)
const facts = sources.flatMap(s => s.facts)
const WEIGHT_RANK = { key: 0, support: 1, aside: 2 }
const TIER_RANK = { primary: 0, secondary: 1, blog: 2, forum: 3, weak: 4 }

const topFacts = [...facts]
  .sort((a, b) => (WEIGHT_RANK[a.weight] - WEIGHT_RANK[b.weight]) || (TIER_RANK[a.tier] - TIER_RANK[b.tier]))
  .slice(0, FACT_CAP)

log("Read " + sources.length + " sources → " + facts.length + " facts → checking top " + topFacts.length)

if (topFacts.length === 0) {
  return {
    question: TOPIC,
    answer: "No facts could be extracted. " + sources.length + " sources read, all empty or failed. " + repeats.length + " repeat URLs, " + overflow.length + " past the read budget.",
    findings: [], rejected: [], sources: sources.map(s => ({ url: s.url, tier: s.tier })),
    stats: { lines: plan.lines.length, sources: sources.length, facts: 0, repeats: repeats.length },
  }
}

// ─── Group identical facts so each is checked once ───
phase("Group")
const grouped = await agent(groupPrompt(topFacts), { label: "group", phase: "Group", schema: GROUP_SHAPE })
const groups = grouped && grouped.groups && grouped.groups.length
  ? grouped.groups.map(g => {
      const idx = (g.members || []).filter(i => i >= 0 && i < topFacts.length)
      const head = topFacts[idx[0] != null ? idx[0] : 0]
      const urls = [...new Set((g.urls && g.urls.length ? g.urls : idx.map(i => topFacts[i].sourceUrl)))]
      return { ...head, statement: g.canonical || head.statement, urls }
    })
  : topFacts.map(f => ({ ...f, urls: [f.sourceUrl] }))
log("Folded " + topFacts.length + " facts → " + groups.length + " groups")

// ─── Crosscheck: adversarial jury per group ───
// Barrier on purpose — the full fact set must be gathered and ranked before any voting.
phase("Crosscheck")
const judged = (await parallel(
  groups.map(fact => () =>
    parallel(
      Array.from({ length: JURY_SIZE }, (_, n) => () =>
        agent(crosscheckPrompt(fact, n), {
          label: "j" + n + ":" + fact.statement.slice(0, 40),
          phase: "Crosscheck",
          schema: RULING_SHAPE,
          model: "lite",
        })
      )
    ).then(rulings => {
      // A null ruling (skip or agent error) counts as an abstention.
      const cast = rulings.filter(Boolean)
      const rejects = cast.filter(v => v.reject).length
      // A fact is kept only if it was genuinely adjudicated: a quorum of real
      // votes AND fewer than REJECT_QUORUM of them rejecting. Too many
      // abstentions means "unproven", which must not slip through as kept
      // (otherwise all-abstain → rejects=0 → false keep).
      const abstain = JURY_SIZE - cast.length
      const kept = cast.length >= REJECT_QUORUM && rejects < REJECT_QUORUM
      log("\"" + fact.statement.slice(0, 50) + "…\": " + (cast.length - rejects) + "-" + rejects + (abstain > 0 ? " (" + abstain + " abstain)" : "") + " " + (kept ? "✓" : "✗"))
      return { ...fact, rulings: cast, rejectCount: rejects, kept }
    })
  )
)).filter(Boolean)

const upheld = judged.filter(f => f.kept)
const dropped = judged.filter(f => !f.kept)
log("Crosscheck done: " + judged.length + " facts → " + upheld.length + " upheld, " + dropped.length + " dropped")

if (upheld.length === 0) {
  return {
    question: TOPIC,
    answer: "Every one of the " + judged.length + " facts was rejected on crosscheck. Inconclusive — sources were likely weak or the claims overstated.",
    findings: [],
    rejected: dropped.map(f => ({ statement: f.statement, tally: (f.rulings.length - f.rejectCount) + "-" + f.rejectCount, source: f.sourceUrl })),
    sources: sources.map(s => ({ url: s.url, tier: s.tier, factCount: s.facts.length })),
    stats: { lines: plan.lines.length, sources: sources.length, facts: facts.length, checked: judged.length, upheld: 0, dropped: dropped.length },
  }
}

// ─── Report ───
phase("Report")
const CERTAINTY_RANK = { high: 0, medium: 1, low: 2 }
const digest = upheld.map((f, i) => {
  const top = f.rulings.filter(v => !v.reject).sort((a, b) => CERTAINTY_RANK[a.certainty] - CERTAINTY_RANK[b.certainty])[0]
  const cites = (f.urls && f.urls.length ? f.urls : [f.sourceUrl]).join(", ")
  return "### [" + i + "] " + f.statement + "\n" +
    "Tally: " + (f.rulings.length - f.rejectCount) + "-" + f.rejectCount + " · Sources: " + cites + " (" + f.tier + ")\n" +
    "Quote: \"" + f.excerpt + "\"\nJuror basis (" + top.certainty + "): " + top.reason + "\n"
}).join("\n")

const droppedDigest = dropped.length > 0
  ? "\n## Rejected on crosscheck (shown for transparency)\n" +
    dropped.map(f => "- \"" + f.statement + "\" (" + f.sourceUrl + ", tally " + (f.rulings.length - f.rejectCount) + "-" + f.rejectCount + ")").join("\n")
  : ""

const report = await agent(
  "## Write the research report\n\n" +
  "**Question:** " + TOPIC + "\n\n" +
  upheld.length + " facts came through a " + JURY_SIZE + "-juror crosscheck. Fold any remaining duplicates and write this up.\n\n" +
  "## Facts that held up\n" + digest + "\n" + droppedDigest + "\n\n" +
  "## How to write it\n" +
  "1. Merge facts that say the same thing and pool their sources.\n" +
  "2. Gather related facts into coherent findings, each one speaking to the question.\n" +
  "3. Rate each finding's certainty: high (several primary sources, jury unanimous), medium (secondary sources or a split jury), low (single source or blog-grade).\n" +
  "4. Open with a 3-5 sentence answer to the question.\n" +
  "5. Spell out the limits: what's shaky, which sources were thin, what may have gone stale.\n" +
  "6. End with 2-4 questions that surfaced but went unanswered.\n\nReturn structured output only.",
  { label: "report", schema: REPORT_SHAPE }
)

if (!report) {
  // Report agent skipped or failed — hand back the upheld facts raw rather than
  // throwing on report.findings and losing the whole run.
  return {
    question: TOPIC,
    answer: "Report step was skipped or failed — returning " + upheld.length + " checked facts unmerged.",
    findings: [],
    upheld: upheld.map(f => ({ statement: f.statement, source: f.sourceUrl, quote: f.excerpt, tally: (f.rulings.length - f.rejectCount) + "-" + f.rejectCount })),
    rejected: dropped.map(f => ({ statement: f.statement, tally: (f.rulings.length - f.rejectCount) + "-" + f.rejectCount, source: f.sourceUrl })),
    sources: sources.map(s => ({ url: s.url, tier: s.tier, factCount: s.facts.length })),
    stats: { lines: plan.lines.length, sources: sources.length, facts: facts.length, checked: judged.length, upheld: upheld.length, dropped: dropped.length, afterReport: 0 },
  }
}

return {
  question: TOPIC,
  ...report,
  rejected: dropped.map(f => ({ statement: f.statement, tally: (f.rulings.length - f.rejectCount) + "-" + f.rejectCount, source: f.sourceUrl })),
  sources: sources.map(s => ({ url: s.url, tier: s.tier, line: s.line, factCount: s.facts.length })),
  stats: {
    lines: plan.lines.length,
    sourcesRead: sources.length,
    factsFound: facts.length,
    factsChecked: judged.length,
    upheld: upheld.length,
    dropped: dropped.length,
    afterReport: report.findings.length,
    repeatUrls: repeats.length,
    overBudget: overflow.length,
    agentRuns: 1 + plan.lines.length + sources.length + 1 + (judged.length * JURY_SIZE) + 1,
  },
}
