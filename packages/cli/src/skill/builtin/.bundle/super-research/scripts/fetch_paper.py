#!/usr/bin/env python3
"""Fetch a paper's readable full text without any PDF tooling.

Strategy: arXiv id/URL -> ar5iv HTML (full text) -> fallback to arXiv abstract.
With --latex: download the arXiv e-print (original LaTeX source) instead —
exact equations, tables, macros. Extracted to a directory.
For DOIs: resolve open-access URL via OpenAlex OA location and fetch that
page's text if it is HTML.

Usage:
  fetch_paper.py 2504.17192 --out paper.txt
  fetch_paper.py https://arxiv.org/abs/2504.17192
  fetch_paper.py 2504.17192 --latex --out-dir paper_src/
  fetch_paper.py --doi 10.18653/v1/2020.acl-main.1
"""
import argparse
import gzip
import html
import io
import json
import os
import re
import sys
import tarfile
import time
import urllib.parse
import urllib.request
import xml.etree.ElementTree as ET

UA = {"User-Agent": "auto-research-skill/1.0 (mailto:research@example.org)"}


def http_get_bytes(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=120) as r:
                return r.read()
        except Exception as e:
            code = getattr(e, "code", None)
            if i < retries - 1 and (code is None or code == 429 or code >= 500):
                time.sleep(2 ** (i + 1))
                continue
            print(f"[warn] GET failed ({e}): {url}", file=sys.stderr)
            return None
    return None


def http_get(url, retries=3):
    for i in range(retries):
        try:
            req = urllib.request.Request(url, headers=UA)
            with urllib.request.urlopen(req, timeout=60) as r:
                return r.read().decode("utf-8", "replace")
        except Exception as e:
            code = getattr(e, "code", None)
            if i < retries - 1 and (code is None or code == 429 or code >= 500):
                time.sleep(2 ** (i + 1))
                continue
            print(f"[warn] GET failed ({e}): {url}", file=sys.stderr)
            return None
    return None


def html_to_text(page):
    page = re.sub(r"<(script|style|nav|header|footer)[^>]*>.*?</\1>", " ",
                  page, flags=re.DOTALL | re.IGNORECASE)
    page = re.sub(r"<(p|div|h[1-6]|li|tr|section|figcaption)\b", "\n<\\1", page,
                  flags=re.IGNORECASE)
    text = re.sub(r"<[^>]+>", " ", page)
    text = html.unescape(text)
    text = re.sub(r"[ \t]+", " ", text)
    text = re.sub(r"\n\s*\n+", "\n\n", text)
    return text.strip()


def arxiv_abstract(aid):
    body = http_get(f"http://export.arxiv.org/api/query?id_list={aid}")
    if not body:
        return None
    ns = {"a": "http://www.w3.org/2005/Atom"}
    e = ET.fromstring(body).find("a:entry", ns)
    if e is None:
        return None
    title = re.sub(r"\s+", " ", e.findtext("a:title", "", ns)).strip()
    abstract = re.sub(r"\s+", " ", e.findtext("a:summary", "", ns)).strip()
    return f"# {title}\n\n[abstract only — full text unavailable]\n\n{abstract}"


def fetch_arxiv(aid):
    page = http_get(f"https://ar5iv.labs.arxiv.org/html/{aid}")
    if page and "<article" in page:
        m = re.search(r"<article.*?</article>", page, re.DOTALL)
        text = html_to_text(m.group(0) if m else page)
        if len(text) > 2000:
            return text
    print("[warn] ar5iv full text unavailable, falling back to abstract", file=sys.stderr)
    return arxiv_abstract(aid)


def fetch_latex(aid, out_dir):
    """Download arXiv e-print (original LaTeX source) and extract to out_dir."""
    raw = http_get_bytes(f"https://arxiv.org/e-print/{aid}")
    if not raw:
        return None
    os.makedirs(out_dir, exist_ok=True)
    try:
        with tarfile.open(fileobj=io.BytesIO(raw), mode="r:*") as tf:
            tf.extractall(out_dir, filter="data")
    except tarfile.ReadError:
        # single-file submission: gzipped .tex (or raw tex/pdf)
        try:
            data = gzip.decompress(raw)
        except OSError:
            data = raw
        if data[:5] == b"%PDF-":
            print("[warn] e-print is PDF-only (no LaTeX source available)", file=sys.stderr)
            return None
        with open(os.path.join(out_dir, "main.tex"), "wb") as f:
            f.write(data)

    tex_files = []
    for root, _, files in os.walk(out_dir):
        for fn in files:
            if fn.endswith(".tex"):
                tex_files.append(os.path.relpath(os.path.join(root, fn), out_dir))
    # main file = the one containing \documentclass
    mains = []
    for rel in tex_files:
        try:
            head = open(os.path.join(out_dir, rel), encoding="utf-8", errors="replace").read(4000)
            if "\\documentclass" in head:
                mains.append(rel)
        except OSError:
            pass
    return {"dir": out_dir, "tex_files": sorted(tex_files), "main": mains[0] if mains else None}


def fetch_doi(doi):
    body = http_get(f"https://api.openalex.org/works/doi:{urllib.parse.quote(doi)}")
    if not body:
        return None
    w = json.loads(body)
    loc = w.get("best_oa_location") or {}
    url = loc.get("landing_page_url")
    title = w.get("title", "")
    inv = w.get("abstract_inverted_index")
    abstract = ""
    if inv:
        pos = {p: word for word, ps in inv.items() for p in ps}
        abstract = " ".join(pos[i] for i in sorted(pos))
    if url:
        page = http_get(url)
        if page and "<html" in page.lower():
            text = html_to_text(page)
            if len(text) > 3000:
                return f"# {title}\n\n[source: {url}]\n\n{text}"
    if abstract:
        return f"# {title}\n\n[abstract only — no OA full text found]\n\n{abstract}"
    return None


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("paper", nargs="?", help="arXiv id or arxiv.org URL")
    ap.add_argument("--doi")
    ap.add_argument("--out")
    ap.add_argument("--latex", action="store_true",
                    help="download original LaTeX source (e-print) instead of text")
    ap.add_argument("--out-dir", default=None, help="extraction dir for --latex")
    args = ap.parse_args()

    if args.latex:
        if not args.paper:
            ap.error("--latex requires an arXiv id/URL")
        m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", args.paper)
        if not m:
            ap.error(f"cannot parse arXiv id from: {args.paper}")
        aid = m.group(1)
        info = fetch_latex(aid, args.out_dir or f"arxiv_{aid.replace('.', '_')}_src")
        if not info:
            print("[error] could not fetch LaTeX source (try without --latex for text)", file=sys.stderr)
            sys.exit(1)
        print(json.dumps(info, indent=2))
        print(f"[info] extracted {len(info['tex_files'])} .tex files to {info['dir']}, "
              f"main: {info['main']}", file=sys.stderr)
        return

    text = None
    if args.doi:
        text = fetch_doi(args.doi)
    elif args.paper:
        m = re.search(r"(\d{4}\.\d{4,5})(v\d+)?", args.paper)
        if m:
            text = fetch_arxiv(m.group(1))
        else:
            ap.error(f"cannot parse arXiv id from: {args.paper}")
    else:
        ap.error("provide an arXiv id/URL or --doi")

    if not text:
        print("[error] could not fetch paper", file=sys.stderr)
        sys.exit(1)
    if args.out:
        open(args.out, "w").write(text)
        print(f"[info] wrote {len(text)} chars to {args.out}", file=sys.stderr)
    else:
        print(text)


if __name__ == "__main__":
    main()
