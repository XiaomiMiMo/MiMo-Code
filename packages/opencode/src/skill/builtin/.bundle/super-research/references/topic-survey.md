# Mode: Topic survey / 主题调研

Use when the user wants a research question answered by gathering and synthesizing external sources — "survey the literature", "调研 X", "state of the art in Y", "gather evidence about Z".

The failure mode this mode is designed against: producing a plausible-sounding synthesis with no verifiable trail back to the sources. Every claim must be traceable to a specific row in `sources.tsv`.

## Contract fields

1. **Research question**: One question, sharp enough to have an answer. If the user asks "what's the state of RL" — negotiate to "what are the top-3 open problems in offline RL as of mid-2026" or similar. Vague questions produce vague surveys.
2. **Scope boundaries**: Time window (e.g. "papers since 2024"), source types (peer-reviewed / blog posts / benchmarks / code repos — be explicit), languages, and any explicit inclusions/exclusions the user cares about.
3. **Depth**: How many sources at minimum before you stop? Default is 15 for a short survey, 30 for a thorough one. Also: saturation criterion — stop when the last 5 sources add no new claims to your synthesis.
4. **Deliverable**: Markdown report + `sources.tsv` (evidence table) + optionally a `claims.tsv` (claim ↔ sources mapping). Length target (usually 1–3 pages of report body).
5. **Working directory**: A dedicated `survey/<tag>/` folder. Everything — the log, the sources, notes, drafts — goes there.

## Baseline

Your baseline is a **structured question decomposition** before any searching:

- Write `question.md` with: the question, sub-questions, what an ideal answer would look like, and 5–10 keyword variations / synonym clusters you'll search for. This forces you to think before you Google.
- Then do one "cold" pass — 3 searches with the most obvious query — and record what you find in `sources.tsv`. This is your baseline pass. It tells you (and the human, later) what a naive search returns.

## The evidence log

`sources.tsv` (tab-separated), one row per source encountered:

```
id	url_or_id	kind	year	title	relevance	credibility	claim_ids	notes
S001	arxiv.org/abs/2405.12345	paper	2024	Attention Is All You Need V2	high	high	C1,C3	primary reference on X
S002	nitter.net/andrejkarpathy/status/…	tweet	2026	Thread on Y	medium	low	C2	anecdotal but from primary author
S003	dead-link	404	—	—	dead	dead	—	referenced by S001 but 404
```

- **id** — `S001`, `S002`… monotonic. This is what your report cites.
- **url_or_id** — enough to re-find the source.
- **kind** — `paper` / `preprint` / `blog` / `docs` / `code` / `tweet` / `book` / `talk` / `podcast` / `other`. Explicit so a reviewer can weight it.
- **year** — for recency filtering.
- **title** — short.
- **relevance** — `high` / `medium` / `low` — how much this source moves your synthesis.
- **credibility** — `high` (peer-reviewed, primary author, official docs), `medium` (well-cited preprint, reputable blog), `low` (anon blog, uncorroborated), `dead` (404, retracted). Do not upgrade credibility because the source agrees with your thesis.
- **claim_ids** — IDs of the claims this source supports (see `claims.tsv` below). Empty is OK for context-only sources.
- **notes** — one line, machine-parseable if useful ("supersedes S001", "contradicts C3").

**Log every source you look at, including dead ends and duplicates.** The point of the log isn't to be a bibliography — it's to be an audit trail. A source that turned out to be a 404, or a paper that turned out to be off-topic after reading the abstract, is real work worth recording. Silently discarding sources is how surveys get accused of cherry-picking.

## The claims log (optional but recommended)

`claims.tsv`, one row per distinct claim your synthesis will rest on:

```
id	claim	support_sources	contradict_sources	confidence
C1	Muon optimizer outperforms AdamW on small-scale LM training by 5-15% val loss reduction	S001,S004,S007	S012	high
C2	SwiGLU activation is universally better than GeLU	S002,S008	S015,S016	medium — two credible contradicting sources
C3	Byte-level tokenization is competitive with BPE below 1B params	S001	—	low — single source
```

If a claim has zero contradicting sources, that's suspicious — either everyone agrees (common in mature areas) or you haven't looked hard enough for pushback. Note it in confidence.

## The loop

LOOP UNTIL saturation OR the depth minimum is hit AND the last 5 sources added no new claims:

1. Pick the sub-question with the weakest coverage. Pick a query — vary keywords, sites, time windows across iterations.
2. Fetch results. For each, read enough (abstract, first section, key figure) to decide relevance.
3. Record in `sources.tsv` — every source you looked at, not just the useful ones.
4. If it supports or contradicts an existing claim, update `claims.tsv`. If it introduces a new distinct claim, add a row.
5. Every ~5 sources, re-read `claims.tsv` in full — this is where synthesis happens. Are claims sharpening? Is a claim collapsing under new evidence? Is a new sub-question emerging?
6. Loop.

## Scholarly / paper-heavy surveys — use the toolbox

When the sources you care about are peer-reviewed papers or arXiv preprints (not blog posts / tweets / docs), prefer the shared scripts over ad-hoc WebFetch. They query multiple free APIs in one call and dedup for you:

```bash
# Multi-source paper search — arXiv + S2 + OpenAlex + Crossref
python3 scripts/paper_search.py "<query>" --sources arxiv,s2,openalex --limit 20 --year-from 2022 --out papers.json

# Snowball from a central paper (S2's citation graph)
# → see references/api-cheatsheet.md § Semantic Scholar for `/paper/<id>/citations` and `/references`

# Fetch a paper's full text or LaTeX for close reading
python3 scripts/fetch_paper.py <arxiv_id> --out papers/<slug>.txt
python3 scripts/fetch_paper.py <arxiv_id> --latex --out-dir papers/<slug>/src/
```

Tactics that pay off for paper surveys:

- Run 2–4 query variants (synonyms, subfield terms), then merge — keyword search misses adjacent literatures.
- Snowball: for the 2–3 most central papers, walk S2's citations/references (see `references/api-cheatsheet.md`). One good snowball beats another keyword sweep.
- Also WebFetch survey papers' related-work sections and awesome-lists — they surface what keyword search doesn't rank.
- **Every URL in the eventual report must come from a `papers.json` row or a fetch you actually made.** URLs recalled from memory are hallucinations; do not write them.
- For parallel extraction across 10–25 papers, spawn subagents in batches of 3–5, each with the fetched text file paths (not summaries) and the field schema from `question.md`.

## Judgment

**Depth first, breadth second.** Reading one paper carefully often moves the synthesis more than skimming ten. Prefer following citations from a high-quality source to searching keywords again.

**Contradictions are gold — flag them, don't reconcile away.** If two credible sources disagree, that IS the finding for that sub-question. Your job is to surface it, not to pick a winner unless the evidence is clearly asymmetric.

**Update claims aggressively.** A new high-credibility contradiction should force you to lower a claim's confidence even if you'd already written the section. If you find yourself defending an earlier position instead of updating it, you're doing it wrong.

**Never fabricate a citation.** If you can't find a source for a claim you want to make, don't invent one. Weaken the claim ("appears to be common practice, though we couldn't identify a peer-reviewed source") and note it.

## Final report

See "Reporting" in SKILL.md. Mode-specific structure for the body:

- **Answer to the research question** — 2–3 sentences up top. If it's genuinely open, say so.
- **Sub-question findings** — one paragraph each. Every non-trivial sentence cites `S00N` inline.
- **Contradictions and open questions** — where sources disagree, and what's not settled.
- **Methodology note** — sources examined, saturation reached at N, exclusions and why.
- **Where to look**: `sources.tsv`, `claims.tsv`, the `survey/<tag>/` folder.
