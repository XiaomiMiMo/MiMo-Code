#!/usr/bin/env python3
"""arXiv research CLI — search, read, cite, download, and analyze papers.

Stdlib only. No API keys required.

Commands:
    search QUERY            Search arXiv (combine with --author/--category)
    get ID[,ID...]          Full metadata + abstract for specific papers
    bibtex ID[,ID...]       BibTeX entries for papers
    download ID             Download the PDF (--dest DIR, default cwd)
    new CATEGORY            Latest submissions in a category (e.g. cs.AI)
    cites ID                Papers citing this one       (Semantic Scholar)
    refs ID                 Papers this one references   (Semantic Scholar)
    similar ID              Recommended related papers   (Semantic Scholar)

Examples:
    python arxiv.py search "MiMo Technical Report" --max 10 --sort date
    python arxiv.py search "attention" --author vaswani --category cs.CL
    python arxiv.py get 2601.02780,1706.03762
    python arxiv.py bibtex 2601.02780
    python arxiv.py download 2601.02780 --dest ./papers
    python arxiv.py new cs.CL --max 10
    python arxiv.py cites 2601.02780 --max 20
    python arxiv.py similar 2601.02780
    python arxiv.py search "diffusion models" --json

Flags:
    --max N        Max results (default 5)
    --start N      Result offset for pagination (search only)
    --sort MODE    relevance | date | updated (search only)
    --author NAME  Filter by author (search only)
    --category CAT Filter by category (search only)
    --dest DIR     Download directory (download only)
    --json         Emit JSON instead of readable text
"""
import argparse
import json
import os
import re
import sys
import urllib.error
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

ARXIV_API = "https://export.arxiv.org/api/query"
S2_API = "https://api.semanticscholar.org"
NS = {
    "a": "http://www.w3.org/2005/Atom",
    "arxiv": "http://arxiv.org/schemas/atom",
    "os": "http://a9.com/-/spec/opensearch/1.1/",
}
UA = "MiMoCode-arxiv-skill/2.0"


def http_get(url, timeout=30):
    req = urllib.request.Request(url, headers={"User-Agent": UA})
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.read()
    except urllib.error.HTTPError as e:
        if e.code == 429:
            sys.exit(f"Rate limited by {urllib.parse.urlsplit(url).netloc} — wait a few seconds and retry.")
        sys.exit(f"HTTP {e.code} fetching {url}")
    except urllib.error.URLError as e:
        sys.exit(f"Network error: {e.reason}")


def text_of(entry, tag):
    node = entry.find(tag, NS)
    return node.text.strip() if node is not None and node.text else ""


def parse_entry(entry):
    raw_id = text_of(entry, "a:id")
    full_id = raw_id.split("/abs/")[-1] if "/abs/" in raw_id else raw_id
    base_id = re.sub(r"v\d+$", "", full_id)
    summary = re.sub(r"\s+", " ", text_of(entry, "a:summary"))
    primary = entry.find("arxiv:primary_category", NS)
    doi = text_of(entry, "arxiv:doi")
    comment = text_of(entry, "arxiv:comment")
    journal = text_of(entry, "arxiv:journal_ref")
    return {
        "id": base_id,
        "version": full_id[len(base_id):],
        "title": re.sub(r"\s+", " ", text_of(entry, "a:title")),
        "authors": [a.find("a:name", NS).text for a in entry.findall("a:author", NS)],
        "published": text_of(entry, "a:published")[:10],
        "updated": text_of(entry, "a:updated")[:10],
        "abstract": summary,
        "categories": [c.get("term") for c in entry.findall("a:category", NS)],
        "primary_category": primary.get("term") if primary is not None else "",
        "doi": doi,
        "comment": comment,
        "journal_ref": journal,
        "abs_url": f"https://arxiv.org/abs/{base_id}",
        "pdf_url": f"https://arxiv.org/pdf/{base_id}",
        "html_url": f"https://arxiv.org/html/{base_id}",
        "withdrawn": "withdrawn" in summary.lower()[:200] or "retracted" in summary.lower()[:200],
    }


def fetch_entries(params):
    url = ARXIV_API + "?" + urllib.parse.urlencode(params)
    root = ET.fromstring(http_get(url))
    total = root.find("os:totalResults", NS)
    entries = [parse_entry(e) for e in root.findall("a:entry", NS)]
    return int(total.text) if total is not None else len(entries), entries


def print_paper(p, i=None, full=False):
    prefix = f"{i}. " if i is not None else ""
    flag = " [WITHDRAWN]" if p["withdrawn"] else ""
    print(f"{prefix}{p['title']}{flag}")
    print(f"   ID: {p['id']}{p['version']} | Published: {p['published']} | Updated: {p['updated']}")
    print(f"   Authors: {', '.join(p['authors'])}")
    print(f"   Categories: {', '.join(p['categories'])}")
    if p["journal_ref"]:
        print(f"   Journal: {p['journal_ref']}")
    if p["comment"]:
        print(f"   Comment: {p['comment']}")
    if p["doi"]:
        print(f"   DOI: {p['doi']}")
    abstract = p["abstract"] if full else p["abstract"][:300] + ("..." if len(p["abstract"]) > 300 else "")
    print(f"   Abstract: {abstract}")
    print(f"   Links: {p['abs_url']} | {p['pdf_url']}")
    print()


def emit(papers, args, total=None, full=False):
    if args.json:
        print(json.dumps({"total": total, "results": papers} if total is not None else papers,
                         ensure_ascii=False, indent=2))
        return
    if not papers:
        print("No results found.")
        return
    if total is not None:
        print(f"Found {total} results (showing {len(papers)})\n")
    for i, p in enumerate(papers, 1):
        print_paper(p, i, full=full)


def cmd_search(args):
    parts = []
    if args.query:
        parts.append(f"all:{args.query}")
    if args.author:
        parts.append(f'au:"{args.author}"')
    if args.category:
        parts.append(f"cat:{args.category}")
    if not parts:
        sys.exit("Provide a query, --author, or --category.")
    sort_map = {"relevance": "relevance", "date": "submittedDate", "updated": "lastUpdatedDate"}
    total, papers = fetch_entries({
        "search_query": " AND ".join(parts),
        "start": args.start,
        "max_results": args.max,
        "sortBy": sort_map[args.sort],
        "sortOrder": "descending",
    })
    emit(papers, args, total=total)


def cmd_get(args):
    _, papers = fetch_entries({"id_list": args.ids, "max_results": 100})
    emit(papers, args, full=True)


def bibtex_key(p):
    last = p["authors"][0].split()[-1].lower() if p["authors"] else "unknown"
    return re.sub(r"[^a-z0-9]", "", last) + p["published"][:4] + p["id"].replace(".", "").replace("/", "")


def cmd_bibtex(args):
    _, papers = fetch_entries({"id_list": args.ids, "max_results": 100})
    if not papers:
        sys.exit("Paper not found.")
    for p in papers:
        eprint = p["id"] + p["version"]  # keep version to prevent citation drift
        lines = [
            f"@misc{{{bibtex_key(p)},",
            f"  title         = {{{p['title']}}},",
            f"  author        = {{{' and '.join(p['authors'])}}},",
            f"  year          = {{{p['published'][:4]}}},",
            f"  eprint        = {{{eprint}}},",
            "  archivePrefix = {arXiv},",
            f"  primaryClass  = {{{p['primary_category']}}},",
            f"  url           = {{https://arxiv.org/abs/{eprint}}},",
        ]
        if p["doi"]:
            lines.append(f"  doi           = {{{p['doi']}}},")
        lines.append("}")
        print("\n".join(lines))
        print()


def cmd_download(args):
    paper_id = args.ids.split(",")[0]
    _, papers = fetch_entries({"id_list": paper_id})
    if not papers:
        sys.exit(f"Paper {paper_id} not found.")
    p = papers[0]
    if p["withdrawn"]:
        print(f"Warning: {p['id']} appears to be withdrawn.", file=sys.stderr)
    os.makedirs(args.dest, exist_ok=True)
    dest = os.path.join(args.dest, f"{p['id'].replace('/', '_')}{p['version']}.pdf")
    data = http_get(f"https://arxiv.org/pdf/{p['id']}{p['version']}", timeout=120)
    if not data.startswith(b"%PDF"):
        sys.exit("Downloaded content is not a PDF (paper may lack a PDF version).")
    with open(dest, "wb") as f:
        f.write(data)
    print(f"Saved: {dest} ({len(data) // 1024} KB)")
    print(f"Title: {p['title']}")


def cmd_new(args):
    total, papers = fetch_entries({
        "search_query": f"cat:{args.category}",
        "max_results": args.max,
        "sortBy": "submittedDate",
        "sortOrder": "descending",
    })
    emit(papers, args, total=total)


S2_FIELDS = "title,authors,year,citationCount,externalIds,abstract"


def s2_paper_row(p):
    ext = p.get("externalIds") or {}
    return {
        "title": p.get("title"),
        "authors": [a["name"] for a in p.get("authors") or []],
        "year": p.get("year"),
        "citations": p.get("citationCount"),
        "arxiv_id": ext.get("ArXiv"),
        "doi": ext.get("DOI"),
    }


def print_s2(rows, args, header):
    if args.json:
        print(json.dumps(rows, ensure_ascii=False, indent=2))
        return
    if not rows:
        print("No results.")
        return
    print(f"{header}\n")
    for i, r in enumerate(rows, 1):
        arxiv = f" | arXiv:{r['arxiv_id']}" if r["arxiv_id"] else ""
        print(f"{i}. {r['title']} ({r['year']})")
        print(f"   Authors: {', '.join(r['authors'][:6])}{' ...' if len(r['authors']) > 6 else ''}")
        print(f"   Citations: {r['citations']}{arxiv}")
        print()


def cmd_s2_links(args, direction):
    paper_id = args.ids.split(",")[0]
    url = f"{S2_API}/graph/v1/paper/arXiv:{paper_id}/{direction}?fields={S2_FIELDS}&limit={args.max}"
    data = json.loads(http_get(url))
    key = "citingPaper" if direction == "citations" else "citedPaper"
    rows = [s2_paper_row(item[key]) for item in data.get("data", [])]
    rows.sort(key=lambda r: r["citations"] or 0, reverse=True)
    label = "Papers citing" if direction == "citations" else "References of"
    print_s2(rows, args, f"{label} arXiv:{paper_id} (sorted by citations)")


def cmd_similar(args):
    paper_id = args.ids.split(",")[0]
    url = f"{S2_API}/recommendations/v1/papers/forpaper/arXiv:{paper_id}?fields={S2_FIELDS}&limit={args.max}"
    data = json.loads(http_get(url))
    rows = [s2_paper_row(p) for p in data.get("recommendedPapers", [])]
    print_s2(rows, args, f"Papers similar to arXiv:{paper_id}")


def main():
    parser = argparse.ArgumentParser(add_help=False)
    parser.add_argument("command", nargs="?")
    parser.add_argument("query", nargs="*")
    parser.add_argument("--max", type=int, default=5)
    parser.add_argument("--start", type=int, default=0)
    parser.add_argument("--sort", choices=["relevance", "date", "updated"], default="relevance")
    parser.add_argument("--author")
    parser.add_argument("--category")
    parser.add_argument("--dest", default=".")
    parser.add_argument("--json", action="store_true")
    parser.add_argument("-h", "--help", action="store_true")
    args = parser.parse_args()

    if args.help or not args.command:
        print(__doc__)
        sys.exit(0)

    args.ids = ",".join(args.query)
    args.query = " ".join(args.query)

    commands = {
        "search": cmd_search,
        "get": cmd_get,
        "bibtex": cmd_bibtex,
        "download": cmd_download,
        "new": lambda a: cmd_new(argparse.Namespace(**{**vars(a), "category": a.query or a.category})),
        "cites": lambda a: cmd_s2_links(a, "citations"),
        "refs": lambda a: cmd_s2_links(a, "references"),
        "similar": cmd_similar,
    }
    handler = commands.get(args.command)
    if handler is None:
        # bare query fallback: treat first arg as part of the search
        args.query = (args.command + " " + args.query).strip()
        handler = cmd_search
    if args.command == "new" and not (args.query or args.category):
        sys.exit("Provide a category, e.g.: python arxiv.py new cs.AI")
    handler(args)


if __name__ == "__main__":
    main()
