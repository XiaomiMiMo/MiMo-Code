# Mode: Paper writing + citation audit / 写论文 & 引用校验

Use when the user asks to write, polish, or verify the bibliography of an academic paper — "write a paper on X", "polish this draft", "check every citation", "查引用", "citation audit". Also usable standalone on an existing PDF/tex whose citations you don't trust.

The failure mode this mode is designed against: fabricated references, and (worse) real papers cited for claims they don't actually make. A polished draft with a hallucinated bibliography looks perfect until a reviewer opens one of the papers you cited — then everything collapses. **Every citation in the final draft must trace to an API-returned record.**

This mode has two parts. They can run together (writing a new paper) or independently (auditing someone else's).

## Part A: Writing

### Contract fields (writing)

1. **Inputs on hand**: prior draft (path), experiment logs / `results.tsv` (path — this may be the output of an experiment-loop run), figures, target venue + template, page limit.
2. **Claim spine**: The 3–7 empirical claims the paper will make. Written before drafting. Every claim maps to (a) a specific `results.tsv` row / figure, or (b) a cited paper. If a claim maps to neither, it gets cut or hedged NOW — not discovered by a reviewer.
3. **Outline**: Section structure with 1–2 sentence purpose + the key claim per section. Confirm with user before drafting.
4. **Bibliography source**: The `refs.bib` is built from `scripts/paper_search.py` results as you write. Every entry originates from an API record — metadata copied from JSON, never recalled from memory.
5. **Working directory**: `paper/<tag>/` — draft.tex or draft.md, `refs.bib`, `claims.tsv`, `citation_audit.json`, revision `LOG.md`.

### Baseline — the claim map

Before drafting: write `claims.tsv`, one row per empirical claim, each mapped to its evidence source. This is your baseline artifact.

```
id	claim	evidence_kind	evidence_ref	confidence	notes
K1	our method reduces val-loss by 12% at 200M params	own experiment	results.tsv row 47 (commit c3d4e5f)	high	
K2	prior work uses AdamW as default optimizer for LMs	cited paper	@vaswani2017,@brown2020	medium	need one more citation for "default"
K3	Muon has been shown to outperform AdamW at small scale	cited paper	@karpathy2024	low — single blog source	replace with peer-reviewed source or hedge
K4	our approach is "significantly better"	???	—	—	CUT — no evidence source, drop or hedge
```

Rows with no evidence get cut or hedged before drafting. Every remaining row must survive Part B's audit.

### The revision log

`LOG.md` (append-only), one entry per drafting or revision pass:

```
2026-07-07T14:30  outline confirmed with user (3 sections, 6 pages)
2026-07-07T15:10  drafted §2 (related work) — refs added: karpathy2024, vaswani2017, brown2020
2026-07-07T16:00  ran citation audit v1 — 2 NOT_FOUND, 1 MISMATCH; fixed metadata, replaced fabricated ref
2026-07-07T17:20  reviewer subagent pass — flagged §4 overclaims "significantly"; softened to "consistently"
```

### The drafting loop

For each section in the outline:

1. Draft it, section by section. Numbers come from `results.tsv` and figures — never rounded, never eyeballed.
2. Every citation is inserted at the point the claim is made. As you insert `\cite{key}`, ensure `key` exists in `refs.bib` and came from a `paper_search.py` result. If it doesn't yet, run the search now, add the entry, then cite.
3. After each section, re-read: does every non-trivial sentence carry a citation or a `results.tsv` reference? Empty citations are anti-patterns.
4. After the full draft: run Part B (citation audit) before the review pass — you don't want a reviewer to find fabrications you could have caught mechanically.
5. **Reviewer subagent pass** — spawn a fresh subagent with only the draft path (not your `claims.tsv`, not your confidence). Ask it for the strongest rejection argument: weakest claim, missing baseline, overclaiming. Address in text or explicitly concede. 1–3 rounds; stop when new findings become cosmetic.
6. **Refinement tightens, never inflates.** If a revision pass ends with claims stronger than the baseline, revert — you drifted into overclaiming.

## Part B: Citation audit

Run on any paper/draft with a bibliography. Standalone-usable ("查引用" on an existing PDF/tex).

### Contract fields (audit-only)

1. **Bib source**: Path to `refs.bib` (or the paper's PDF/tex from which to extract a bib).
2. **Draft source**: Path to the tex/md draft (needed for Part B step 2 — the context audit).
3. **Deliverables**: `citation_audit.json` (per-entry verdict), `audit_report.md` (summary + repairs).
4. **Repair authority**: What the auditor may auto-do vs must ask (see repair matrix below).

### Baseline — the mechanical audit

Before any context analysis, run the metadata check on the full bib:

```bash
python3 scripts/verify_citation.py --bib refs.bib --out citation_audit.json
```

Per-entry mechanical verdicts:

| Verdict | Meaning |
|---|---|
| `VERIFIED` | title/author/year match a real record in Crossref / S2 / OpenAlex / arXiv |
| `MISMATCH` | a record found but metadata disagrees (wrong year, wrong venue, wrong first author) |
| `NOT_FOUND` | nothing found across all 4 APIs — possible fabrication |
| `UNCERTAIN` | multiple weak matches, ambiguous |

`citation_audit.json` becomes the audit log for this run. Every entry must have a verdict; nothing silently skipped.

### The context audit — the failure mode that matters

A real paper cited for a claim it doesn't make is worse than an obviously fabricated citation, because it survives mechanical checks. For every citation in the draft:

1. Extract the sentence containing `\cite{key}` and identify the specific claim it supports.
2. Fetch the cited paper's abstract (from `citation_audit.json`'s `matched` field, or `scripts/fetch_paper.py <arxiv_id>`).
3. Judge one of: `SUPPORTS` / `WEAK` (abstract hints but doesn't say so directly) / `WRONG` (abstract does not contain this claim) / `UNKNOWN` (needs full-text fetch — flag for later).
4. For **load-bearing citations** (a claim the paper's contribution depends on) read more than the abstract — spend the fetch budget there.

Batch this with subagents for long bibliographies. Each subagent gets the sentence + abstract + the citation key — NOT your expectation of the verdict. Fresh eyes prevent confirmation bias.

Append the context verdict to each entry in `citation_audit.json`.

### The repair matrix — four verdicts, four actions

| Combined verdict | Action | Automatic? |
|---|---|---|
| VERIFIED + SUPPORTS | KEEP | yes |
| VERIFIED + WEAK | REVIEW (hedge the claim in text if needed) | ask user |
| MISMATCH + SUPPORTS | FIX metadata from `matched` fields | yes |
| MISMATCH + WRONG | REPLACE | ask user |
| NOT_FOUND | REPLACE (search for a real substitute) or REMOVE | ask user |
| any + WRONG | REPLACE (find a paper that actually supports the claim) or REMOVE + hedge | ask user |
| UNCERTAIN / UNKNOWN | leave marked; do NOT guess a verdict | — |

**Never leave a dangling `\cite` after a REMOVE.** Deleting a `.bib` entry AND deleting the `\cite` are one operation. If a claim only stood on a removed citation, that claim is now unsupported — hedge it or cut it.

**Fixes come from API-returned records, never from memory.** If the API says the year is 2023 and the bib says 2022, the API wins. Never edit metadata from what you think the paper's year is.

### The audit report

`audit_report.md`:

```
Total entries: 47
VERIFIED + SUPPORTS: 39 (kept)
MISMATCH (fixed):    5   → metadata corrected from API records
NOT_FOUND:           2   → 1 replaced (Muon → @jordan2024muon), 1 removed + claim hedged
WRONG context:       1   → replaced (@brown2020 cited for a claim only @wei2022 makes)
UNCERTAIN:           0   remaining after review
```

## Anti-patterns (both parts)

- Rounding a number favorably.
- Using "significantly" without a statistical test.
- Citing a paper for a claim its abstract doesn't contain (checked in Part B step 2).
- Expanding claims during refinement (refinement tightens, never inflates).
- Filling in bib metadata from memory instead of an API result.
- Marking a load-bearing citation `VERIFIED` from title match alone, without reading the abstract.

## Final report

See "Reporting" in SKILL.md. Mode-specific body:

- **What was written / audited** — one paragraph.
- **Claim map summary** — how many claims total, how many backed by own experiments vs cited work, how many cut/hedged during writing.
- **Audit outcome** — entry counts by verdict, actions taken, unresolved `UNCERTAIN` entries.
- **Residual risks** — any WEAK or UNKNOWN citations that survived into the final draft with a hedge, and why.
- **Where to look**: `claims.tsv`, `refs.bib`, `citation_audit.json`, `audit_report.md`, the draft, `paper/<tag>/`.
