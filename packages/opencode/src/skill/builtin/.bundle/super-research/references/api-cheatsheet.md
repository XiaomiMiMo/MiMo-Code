# Free Scholarly API Cheatsheet

All endpoints below need **no API key**. Use when `scripts/` fail or a custom query is needed. Always send a User-Agent with a mailto (some APIs give better rate limits for identified "polite" clients).

## arXiv

- Search: `http://export.arxiv.org/api/query?search_query=all:<terms>&max_results=20&sortBy=relevance` (Atom XML)
  - Field prefixes: `ti:` title, `au:` author, `abs:` abstract, `cat:cs.LG` category; combine: `au:vaswani+AND+cat:cs.CL`
- By id: `?id_list=1706.03762`
- PDF: `https://arxiv.org/pdf/<id>.pdf` · HTML full text: `https://ar5iv.labs.arxiv.org/html/<id>`
- Limits: ~1 req / 3s politeness; no auth.

## Semantic Scholar (S2)

- Search: `https://api.semanticscholar.org/graph/v1/paper/search?query=<q>&limit=20&fields=title,authors,year,abstract,externalIds,citationCount,venue,url`
- Paper detail: `/graph/v1/paper/<id>` where id = `arXiv:2504.17192`, `DOI:...`, or S2 hash
- **Snowballing**: `/graph/v1/paper/<id>/citations?fields=title,year` and `/references` — best free citation-graph API
- Limits: unauthenticated pool is tight (429s are common — scripts back off; if persistent, drop S2 and rely on OpenAlex).

## OpenAlex

- Search: `https://api.openalex.org/works?search=<q>&per-page=25`
- Filters: `&filter=from_publication_date:2022-01-01,cited_by_count:>50,open_access.is_oa:true`
- By DOI: `/works/doi:10.xxxx/yyy` — response includes `best_oa_location` (free OA-PDF resolver, Unpaywall data inside)
- Abstract comes as `abstract_inverted_index` (word → positions); invert to reconstruct.
- Limits: 100k/day, very reliable. Add `&mailto=you@example.org` for the polite pool.

## Crossref

- Search: `https://api.crossref.org/works?query.bibliographic=<title+author>&rows=5` — best for citation verification (DOI authority)
- By DOI: `/works/<doi>`
- Fields: `title[]`, `author[].family`, `issued.date-parts`, `container-title[]`, `is-referenced-by-count`
- Limits: generous with polite UA.

## dblp (CS venues/authors)

- `https://dblp.org/search/publ/api?q=<q>&format=json&h=10` — precise venue/year for CS papers; good for verifying venue claims.

## PubMed (biomed)

- Search: `https://eutils.ncbi.nlm.nih.gov/entrez/eutils/esearch.fcgi?db=pubmed&term=<q>&retmax=20&retmode=json`
- Fetch: `efetch.fcgi?db=pubmed&id=<pmid>&rettype=abstract&retmode=text`
- Limits: 3 req/s without key.

## Full-text acquisition ladder

1. arXiv id known → ar5iv HTML (`scripts/fetch_paper.py`)
2. DOI known → OpenAlex `best_oa_location` → fetch landing page
3. Europe PMC (biomed OA): `https://www.ebi.ac.uk/europepmc/webservices/rest/search?query=<q>&format=json`
4. Nothing open → work from abstract; mark analysis `[abstract only]`.

## Source selection

| Need | Use |
|---|---|
| CS/ML recent preprints | arXiv, S2 |
| Citation counts / graph | S2, OpenAlex |
| Verify a citation exists | Crossref → S2 → OpenAlex → arXiv (waterfall) |
| CS venue metadata | dblp |
| Biomed | PubMed, Europe PMC |
| Cross-discipline coverage | OpenAlex |
