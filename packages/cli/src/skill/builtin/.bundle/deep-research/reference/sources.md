# Free source endpoints (no API key)

Search with the `websearch` tool or a configured search MCP tool, and read pages with WebFetch. For specific angle types, these free endpoints give better structured results. All are keyless; on 429/5xx back off once, then continue without that source.

## When no search tool is available

Do not scrape search-engine result pages (DuckDuckGo, Bing, Google and similar). Use the endpoints below and primary sources you can name directly (official sites, documentation, repositories), and state in your findings that web search was not configured.


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
