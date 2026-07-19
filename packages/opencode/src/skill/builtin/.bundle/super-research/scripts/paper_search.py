#!/usr/bin/env python3
"""Multi-source paper search: arXiv + Semantic Scholar + OpenAlex + Crossref.

Stdlib only. Unified output schema, cross-source dedup by DOI / arXiv id / normalized title.

Usage:
  paper_search.py "query terms" [--sources arxiv,s2,openalex,crossref] [--limit 10]
                  [--year-from 2020] [--out papers.json]
"""
import argparse
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = {"User-Agent": "auto-research-skill/1.0 (mailto:research@example.org)"}


def http_get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=30) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            code = getattr(e, "code", None)
            if i < retries - 1 and (code is None or code == 429 or code >= 500):
                time.sleep(2 ** (i + 1))
                continue
            print(f"[warn] GET failed ({e}): {url}", file=sys.stderr)
            return None
    return None


def norm_title(t):
    return re.sub(r"[^a-z0-9]", "", (t or "").lower())


def search_arxiv(query, limit, year_from):
    q = urllib.parse.quote(query)
    url = (f"http://export.arxiv.org/api/query?search_query=all:{q}"
           f"&max_results={limit}&sortBy=relevance")
    body = http_get(url)
    if not body:
        return []
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in ET.fromstring(body).findall("a:entry", ns):
        year = int((e.findtext("a:published", "", ns) or "0000")[:4] or 0)
        if year_from and year and year < year_from:
            continue
        aid = (e.findtext("a:id", "", ns) or "").rsplit("/abs/", 1)[-1]
        out.append({
            "title": re.sub(r"\s+", " ", e.findtext("a:title", "", ns)).strip(),
            "authors": [a.findtext("a:name", "", ns) for a in e.findall("a:author", ns)],
            "year": year or None,
            "abstract": re.sub(r"\s+", " ", e.findtext("a:summary", "", ns)).strip(),
            "doi": None,
            "arxiv_id": re.sub(r"v\d+$", "", aid),
            "url": f"https://arxiv.org/abs/{aid}",
            "venue": "arXiv",
            "citations": None,
            "source": "arxiv",
        })
    return out


def search_s2(query, limit, year_from):
    q = urllib.parse.quote(query)
    url = (f"https://api.semanticscholar.org/graph/v1/paper/search?query={q}"
           f"&limit={limit}&fields=title,authors,year,abstract,externalIds,url,venue,citationCount")
    if year_from:
        url += f"&year={year_from}-"
    body = http_get(url)
    if not body:
        return []
    out = []
    for p in json.loads(body).get("data", []):
        ext = p.get("externalIds") or {}
        out.append({
            "title": p.get("title"),
            "authors": [a.get("name") for a in (p.get("authors") or [])],
            "year": p.get("year"),
            "abstract": p.get("abstract"),
            "doi": ext.get("DOI"),
            "arxiv_id": ext.get("ArXiv"),
            "url": p.get("url"),
            "venue": p.get("venue"),
            "citations": p.get("citationCount"),
            "source": "s2",
        })
    return out


def search_openalex(query, limit, year_from):
    q = urllib.parse.quote(query)
    flt = f"&filter=from_publication_date:{year_from}-01-01" if year_from else ""
    url = f"https://api.openalex.org/works?search={q}&per-page={limit}{flt}"
    body = http_get(url)
    if not body:
        return []
    out = []
    for w in json.loads(body).get("results", []):
        abstract = None
        inv = w.get("abstract_inverted_index")
        if inv:
            pos = {p: word for word, ps in inv.items() for p in ps}
            abstract = " ".join(pos[i] for i in sorted(pos))
        loc = (w.get("primary_location") or {}).get("source") or {}
        out.append({
            "title": w.get("title"),
            "authors": [a["author"]["display_name"] for a in (w.get("authorships") or [])],
            "year": w.get("publication_year"),
            "abstract": abstract,
            "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
            "arxiv_id": None,
            "url": w.get("doi") or w.get("id"),
            "venue": loc.get("display_name"),
            "citations": w.get("cited_by_count"),
            "source": "openalex",
        })
    return out


def search_crossref(query, limit, year_from):
    q = urllib.parse.quote(query)
    flt = f"&filter=from-pub-date:{year_from}-01-01" if year_from else ""
    url = f"https://api.crossref.org/works?query={q}&rows={limit}{flt}"
    body = http_get(url)
    if not body:
        return []
    out = []
    for it in json.loads(body).get("message", {}).get("items", []):
        year = None
        for k in ("published-print", "published-online", "issued"):
            parts = (it.get(k) or {}).get("date-parts") or [[None]]
            if parts[0][0]:
                year = parts[0][0]
                break
        out.append({
            "title": (it.get("title") or [None])[0],
            "authors": [f"{a.get('given','')} {a.get('family','')}".strip()
                        for a in (it.get("author") or [])],
            "year": year,
            "abstract": re.sub(r"<[^>]+>", "", it.get("abstract") or "") or None,
            "doi": it.get("DOI"),
            "arxiv_id": None,
            "url": it.get("URL"),
            "venue": (it.get("container-title") or [None])[0],
            "citations": it.get("is-referenced-by-count"),
            "source": "crossref",
        })
    return out


SEARCHERS = {"arxiv": search_arxiv, "s2": search_s2,
             "openalex": search_openalex, "crossref": search_crossref}


def dedup(papers):
    seen, out = {}, []
    for p in papers:
        key = (p.get("doi") or "").lower() or p.get("arxiv_id") or norm_title(p.get("title"))
        if not key:
            continue
        if key in seen:
            prev = seen[key]
            for f in ("doi", "arxiv_id", "abstract", "venue", "citations"):
                if not prev.get(f) and p.get(f):
                    prev[f] = p[f]
            prev["source"] += "," + p["source"]
        else:
            seen[key] = p
            out.append(p)
    return out


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("query")
    ap.add_argument("--sources", default="arxiv,s2,openalex")
    ap.add_argument("--limit", type=int, default=10)
    ap.add_argument("--year-from", type=int, default=None)
    ap.add_argument("--out", default=None)
    args = ap.parse_args()

    papers = []
    for s in args.sources.split(","):
        s = s.strip()
        if s not in SEARCHERS:
            print(f"[warn] unknown source: {s}", file=sys.stderr)
            continue
        got = SEARCHERS[s](args.query, args.limit, args.year_from)
        print(f"[info] {s}: {len(got)} results", file=sys.stderr)
        papers.extend(got)

    papers = dedup(papers)
    papers.sort(key=lambda p: (p.get("citations") or 0), reverse=True)
    text = json.dumps(papers, ensure_ascii=False, indent=2)
    if args.out:
        with open(args.out, "w") as f:
            f.write(text)
        print(f"[info] wrote {len(papers)} unique papers to {args.out}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
