# Free source endpoints (no API key)

Default tools are WebSearch + WebFetch. For specific angle types, these free endpoints give better structured results. All are keyless; on 429/5xx back off once, then continue without that source.

## General web search (fallback when WebSearch tool is unavailable)

If the WebSearch tool is missing or errors, use DuckDuckGo HTML via WebFetch — verified to return full SERP results:

```
WebFetch https://html.duckduckgo.com/html/?q=<url-encoded query>
```

- Result links are wrapped as `//duckduckgo.com/l/?uddg=<url-encoded real URL>` — decode `uddg` to get the actual URL before fetching it.
- Supports operators: `site:github.com`, `"exact phrase"`, and `df=y` (past year) / `df=m` (past month) as query params.
- For Chinese-language topics, also try Bing: `WebFetch https://www.bing.com/search?q=<query>&setlang=zh` (works without key, quality varies).


## Academic / papers

```bash
# arXiv (Atom XML)
curl -s "http://export.arxiv.org/api/query?search_query=all:\"deep+research+agent\"&sortBy=submittedDate&sortOrder=descending&max_results=10"

# Semantic Scholar (JSON; rate limit ~1 req/s unauthenticated)
curl -s "https://api.semanticscholar.org/graph/v1/paper/search?query=deep+research+agent&fields=title,year,abstract,citationCount,externalIds,url&limit=10"

# OpenAlex (JSON, generous limits; add mailto for politeness)
curl -s "https://api.openalex.org/works?search=deep%20research%20agent&per-page=10&mailto=research@example.com"
```

Full text of an arXiv paper: WebFetch `https://arxiv.org/abs/<id>` for abstract, or `https://ar5iv.org/abs/<id>` for HTML full text.

## Code / GitHub

```bash
# Repo search (60 req/h unauthenticated)
curl -s "https://api.github.com/search/repositories?q=deep+research+agent&sort=stars&per_page=10"

# README of a repo
curl -s "https://raw.githubusercontent.com/<owner>/<repo>/HEAD/README.md"
```

## Community / discussion

- Hacker News: `https://hn.algolia.com/api/v1/search?query=<q>&tags=story` (JSON, keyless)
- Reddit: WebFetch `https://www.reddit.com/search/?q=<q>` or append `.json` to any thread URL
- Stack Overflow: `https://api.stackexchange.com/2.3/search/advanced?q=<q>&site=stackoverflow` (JSON)

## Data / facts

- Wikipedia REST: `https://en.wikipedia.org/api/rest_v1/page/summary/<title>` (JSON)
- Wikidata: `https://www.wikidata.org/w/api.php?action=wbsearchentities&search=<q>&language=en&format=json`

## Optional upgrades (only if already configured — never require)

If the environment has these MCP servers/tools available, prefer them for their niche; otherwise ignore silently:

- Firecrawl MCP → JS-heavy pages that WebFetch renders poorly
- arxiv / paper-search MCP → paper download + PDF text extraction
- Any search MCP (Tavily/Exa/...) → higher-quality SERP than WebSearch

Never ask the user to install or configure anything mid-research.
