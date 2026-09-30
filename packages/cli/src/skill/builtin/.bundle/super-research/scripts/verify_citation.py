#!/usr/bin/env python3
"""Citation verifier: check a single citation or every entry in a .bib file.

Waterfall: Crossref -> Semantic Scholar -> OpenAlex -> arXiv.
Match by title similarity (SequenceMatcher) + author-surname overlap + year tolerance.

Verdicts:
  VERIFIED  - found, metadata matches
  MISMATCH  - found a paper but author/year/venue disagrees (details in `issues`)
  NOT_FOUND - no source returned a plausible match (possible fabrication)

Usage:
  verify_citation.py --title "Attention Is All You Need" --author Vaswani --year 2017
  verify_citation.py --bib refs.bib --out audit.json
"""
import argparse
import difflib
import json
import re
import sys
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = {"User-Agent": "auto-research-skill/1.0 (mailto:research@example.org)"}
SIM_ACCEPT = 0.85
SIM_REJECT = 0.65


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
            return None
    return None


def sim(a, b):
    na = re.sub(r"[^a-z0-9 ]", "", (a or "").lower())
    nb = re.sub(r"[^a-z0-9 ]", "", (b or "").lower())
    return difflib.SequenceMatcher(None, na, nb).ratio()


def q_crossref(title):
    url = f"https://api.crossref.org/works?query.bibliographic={urllib.parse.quote(title)}&rows=3"
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
            "title": (it.get("title") or [""])[0],
            "authors": [a.get("family", "") for a in (it.get("author") or [])],
            "year": year,
            "venue": (it.get("container-title") or [None])[0],
            "doi": it.get("DOI"),
            "url": it.get("URL"),
            "source": "crossref",
        })
    return out


def q_s2(title):
    url = (f"https://api.semanticscholar.org/graph/v1/paper/search?"
           f"query={urllib.parse.quote(title)}&limit=3"
           f"&fields=title,authors,year,venue,externalIds,url")
    body = http_get(url)
    if not body:
        return []
    out = []
    for p in json.loads(body).get("data", []):
        ext = p.get("externalIds") or {}
        out.append({
            "title": p.get("title", ""),
            "authors": [(a.get("name") or "").split()[-1] for a in (p.get("authors") or []) if a.get("name")],
            "year": p.get("year"),
            "venue": p.get("venue"),
            "doi": ext.get("DOI"),
            "url": p.get("url"),
            "source": "s2",
        })
    return out


def q_openalex(title):
    url = f"https://api.openalex.org/works?search={urllib.parse.quote(title)}&per-page=3"
    body = http_get(url)
    if not body:
        return []
    out = []
    for w in json.loads(body).get("results", []):
        loc = (w.get("primary_location") or {}).get("source") or {}
        out.append({
            "title": w.get("title", ""),
            "authors": [(a["author"]["display_name"] or "").split()[-1]
                        for a in (w.get("authorships") or [])],
            "year": w.get("publication_year"),
            "venue": loc.get("display_name"),
            "doi": (w.get("doi") or "").replace("https://doi.org/", "") or None,
            "url": w.get("doi") or w.get("id"),
            "source": "openalex",
        })
    return out


def q_arxiv(title):
    q = urllib.parse.quote(f'ti:"{title}"')
    body = http_get(f"http://export.arxiv.org/api/query?search_query={q}&max_results=3")
    if not body:
        return []
    ns = {"a": "http://www.w3.org/2005/Atom"}
    out = []
    for e in ET.fromstring(body).findall("a:entry", ns):
        out.append({
            "title": re.sub(r"\s+", " ", e.findtext("a:title", "", ns)).strip(),
            "authors": [(a.findtext("a:name", "", ns) or "").split()[-1]
                        for a in e.findall("a:author", ns)],
            "year": int((e.findtext("a:published", "0000", ns) or "0000")[:4] or 0) or None,
            "venue": "arXiv",
            "doi": None,
            "url": e.findtext("a:id", "", ns),
            "source": "arxiv",
        })
    return out


def surname(name):
    name = (name or "").strip()
    if "," in name:  # BibTeX "Family, Given"
        return name.split(",")[0].strip().lower()
    return name.split()[-1].lower() if name.split() else ""


def check_meta(cand, s, authors, year):
    issues = []
    if s < SIM_ACCEPT:
        issues.append(f"title similarity only {s:.2f}")
    if year and cand.get("year") and abs(int(year) - int(cand["year"])) > 1:
        issues.append(f"year mismatch: cited {year}, found {cand['year']}")
    if authors:
        cited = {surname(a) for a in authors if a.strip()}
        found = {(a or "").lower() for a in cand.get("authors", [])}
        if cited and found and not (cited & found):
            issues.append(f"no author overlap: cited {sorted(cited)[:3]}, found {sorted(found)[:3]}")
    return issues


def verify(title, authors=None, year=None):
    """Return verdict dict for one citation."""
    best = None  # (has_issues, sim, cand, issues); clean candidates win
    for fn in (q_crossref, q_s2, q_openalex, q_arxiv):
        for cand in fn(title):
            s = sim(title, cand["title"])
            if s < SIM_REJECT:
                continue
            issues = check_meta(cand, s, authors, year)
            entry = (1 if issues else 0, s, cand, issues)
            if best is None or (entry[0], -entry[1]) < (best[0], -best[1]):
                best = entry
        # stop the waterfall only on a clean, high-confidence match
        if best and best[0] == 0 and best[1] >= SIM_ACCEPT:
            break

    if not best:
        return {"verdict": "NOT_FOUND", "similarity": 0, "matched": None,
                "issues": ["no plausible match in crossref/s2/openalex/arxiv"]}

    has_issues, s, cand, issues = best
    return {"verdict": "MISMATCH" if has_issues else "VERIFIED",
            "similarity": round(s, 3), "matched": cand, "issues": issues}


def parse_bib(path):
    """Minimal BibTeX parser: key, title, author, year per entry."""
    text = open(path, encoding="utf-8", errors="replace").read()
    entries = []
    for m in re.finditer(r"@(\w+)\s*\{\s*([^,\s]+)\s*,", text):
        if m.group(1).lower() in ("comment", "string", "preamble"):
            continue
        start = m.end()
        depth, i = 1, start
        while i < len(text) and depth > 0:
            depth += {"{": 1, "}": -1}.get(text[i], 0)
            i += 1
        body = text[start:i - 1]

        def field(name):
            fm = re.search(name + r"\s*=\s*[{\"](.*?)[}\"]\s*,?\s*\n", body,
                           re.IGNORECASE | re.DOTALL)
            return re.sub(r"[{}\s]+", " ", fm.group(1)).strip() if fm else None

        entries.append({"key": m.group(2), "title": field("title"),
                        "authors": [a.strip() for a in (field("author") or "").split(" and ") if a.strip()],
                        "year": field("year")})
    return entries


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--title")
    ap.add_argument("--author", action="append", default=[])
    ap.add_argument("--year", type=int)
    ap.add_argument("--bib")
    ap.add_argument("--out")
    args = ap.parse_args()

    if args.bib:
        results = []
        entries = parse_bib(args.bib)
        for i, e in enumerate(entries):
            if not e["title"]:
                results.append({"key": e["key"], "verdict": "NOT_FOUND",
                                "issues": ["entry has no title field"]})
                continue
            r = verify(e["title"], e["authors"], e["year"])
            r["key"] = e["key"]
            r["cited_title"] = e["title"]
            results.append(r)
            print(f"[{i+1}/{len(entries)}] {e['key']}: {r['verdict']}", file=sys.stderr)
            time.sleep(1)
        summary = {}
        for r in results:
            summary[r["verdict"]] = summary.get(r["verdict"], 0) + 1
        report = {"summary": summary, "entries": results}
        text = json.dumps(report, ensure_ascii=False, indent=2)
        if args.out:
            open(args.out, "w").write(text)
            print(f"[info] wrote audit to {args.out}: {summary}", file=sys.stderr)
        else:
            print(text)
    elif args.title:
        print(json.dumps(verify(args.title, args.author, args.year),
                         ensure_ascii=False, indent=2))
    else:
        ap.error("provide --title or --bib")


if __name__ == "__main__":
    main()
