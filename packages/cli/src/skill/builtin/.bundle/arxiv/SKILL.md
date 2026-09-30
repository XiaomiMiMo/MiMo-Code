---
name: arxiv
description: "Use this skill whenever the user wants to find, read, cite, track, download, or analyze academic papers on arXiv. That includes: searching papers by topic, author, category, or arXiv ID; fetching abstracts or full metadata; generating BibTeX citations; downloading PDFs; listing the latest submissions in a field (e.g. cs.AI daily digest); checking a paper's citation impact; finding who cites a paper, what it references, or related-paper recommendations. Trigger on mentions of 'arXiv', an arXiv ID (e.g. 2601.02780 or hep-th/0601001), an arxiv.org URL, 'paper search', 'literature review', 'find papers about X', 'cite this paper', or 'what's new in cs.LG'."
version: 2.0.0
license: MIT
platforms: [linux, macos, windows]
---

# arXiv Research

Search, read, cite, and analyze academic papers using the free arXiv API and Semantic Scholar API. No API keys, no dependencies — the bundled script uses only the Python stdlib.

## Quick Start: the `arxiv.py` script

Prefer `scripts/arxiv.py` over raw `curl` — it handles Atom XML parsing, versioned IDs, withdrawn-paper detection, and produces clean readable (or `--json`) output.

| Goal | Command |
|------|---------|
| Search papers | `python scripts/arxiv.py search "GRPO reinforcement learning" --max 10 --sort date` |
| Filtered search | `python scripts/arxiv.py search "attention" --author vaswani --category cs.CL` |
| Full metadata + abstract | `python scripts/arxiv.py get 2601.02780,1706.03762` |
| BibTeX citation | `python scripts/arxiv.py bibtex 2601.02780` |
| Download PDF | `python scripts/arxiv.py download 2601.02780 --dest ./papers` |
| Latest in a category | `python scripts/arxiv.py new cs.CL --max 10` |
| Who cites this paper | `python scripts/arxiv.py cites 2601.02780 --max 20` |
| What this paper cites | `python scripts/arxiv.py refs 2601.02780` |
| Related-paper recommendations | `python scripts/arxiv.py similar 2601.02780` |
| Machine-readable output | append `--json` to any command |

Common flags: `--max N` (result count), `--sort relevance|date|updated`, `--start N` (pagination offset, search only), `--json`.

## Reading Paper Content

After finding a paper, read it with the `webfetch` tool:

- Abstract page (fast, metadata + abstract): `https://arxiv.org/abs/2601.02780`
- Full paper as HTML (best for reading, when available): `https://arxiv.org/html/2601.02780`
- PDF: `https://arxiv.org/pdf/2601.02780`

If HTML is unavailable and the PDF must be processed locally, `download` it first, then use a PDF-processing skill.

## Recommended Research Workflows

**Literature review on a topic**
1. `search "topic" --sort date --max 15` — recent work
2. `search "topic" --max 15` — seminal work (relevance-sorted)
3. Cross-check impact: `python scripts/arxiv.py get ID` then `cites ID --max 5` for citation counts
4. Read the top candidates via `webfetch` on the abs/html URLs
5. `bibtex ID1,ID2,...` for the papers you keep

**Deep-dive a single paper**
1. `get ID` — full abstract, versions, journal ref, DOI
2. `refs ID` — what it builds on
3. `cites ID` — follow-up work (sorted by citation count)
4. `similar ID` — related papers you might have missed
5. `webfetch` the HTML/PDF for full text

**Stay current in a field**
- `new cs.AI --max 20` — latest submissions in a category
- Category taxonomy: https://arxiv.org/category_taxonomy — common ones: `cs.AI`, `cs.CL` (NLP), `cs.CV`, `cs.LG`, `cs.CR`, `stat.ML`, `math.OC`

## Raw API Reference (when the script isn't enough)

The script covers most needs; use the raw APIs for advanced queries.

### arXiv API (Atom XML)

```bash
curl -s "https://export.arxiv.org/api/query?search_query=all:transformer&max_results=5"
```

Field prefixes: `all:` (everything), `ti:` (title), `au:` (author), `abs:` (abstract), `cat:` (category), `co:` (comment, e.g. `co:accepted+NeurIPS`).

Boolean syntax (URL-encode spaces as `+`):

```
all:GPT+OR+all:BERT              # OR
all:language+model+ANDNOT+all:vision   # AND NOT
ti:"chain+of+thought"            # exact phrase
au:hinton+AND+cat:cs.LG          # combined
```

Parameters: `sortBy` (`relevance`|`lastUpdatedDate`|`submittedDate`), `sortOrder`, `start`, `max_results`, `id_list` (comma-separated IDs).

### Semantic Scholar API (JSON)

arXiv has no citation data — Semantic Scholar fills that gap (free, ~1 req/sec unauthenticated).

```bash
# Paper details with citation counts
curl -s "https://api.semanticscholar.org/graph/v1/paper/arXiv:2601.02780?fields=title,citationCount,influentialCitationCount,tldr"

# Author profile
curl -s "https://api.semanticscholar.org/graph/v1/author/search?query=Yann+LeCun&fields=name,hIndex,citationCount,paperCount"

# Keyword search returning JSON (alternative to arXiv search)
curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=GRPO&limit=5&fields=title,year,citationCount,externalIds"
```

Useful fields: `title`, `authors`, `year`, `abstract`, `tldr` (AI summary), `citationCount`, `influentialCitationCount`, `isOpenAccess`, `openAccessPdf`, `fieldsOfStudy`, `publicationVenue`, `externalIds` (arXiv ID, DOI).

## Important Details

**Rate limits** — arXiv: ~1 request / 3 seconds; Semantic Scholar: ~1 request / second. Space out consecutive calls; the script exits with a clear message on HTTP 429.

**ID formats** — new style `2402.03300`, old style `hep-th/0601001`. Both work everywhere.

**Versioning** — `arxiv.org/abs/2601.02780` resolves to the latest version; `...v2` is a specific immutable version. `bibtex` and `download` preserve the version suffix so citations match the content you actually read (later versions can change substantially).

**Withdrawn papers** — the script flags entries whose abstract indicates withdrawal/retraction with `[WITHDRAWN]`. Don't cite these without noting the status.

**Listings caveat** — `new CATEGORY` sorts by submission date via the search API; the official "new today" listing at `https://arxiv.org/list/cs.AI/new` may group slightly differently (cross-lists, replacements).
