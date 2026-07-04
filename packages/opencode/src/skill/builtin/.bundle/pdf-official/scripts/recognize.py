#!/usr/bin/env python3
"""recognize.py — run OCR over a scanned PDF, produce a plain-text file.

    python recognize.py scan.pdf --out scan.txt [--language eng]
                                 [--dpi 300] [--select 1-3] [--parallel N]

Uses pypdfium2 to rasterise (no poppler needed) and pytesseract to OCR.
Language codes are Tesseract codes: eng, deu, chi_sim, jpn, …
Combine with '+', e.g. --language eng+chi_sim.

--parallel N runs page OCR through a ProcessPoolExecutor with N workers.
             Default 1 (sequential). Ignored if only one page is selected.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import sys
from concurrent.futures import ProcessPoolExecutor
from pathlib import Path


def _pages_wanted(spec: str, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    out: set[int] = set()
    for token in spec.split(","):
        token = token.strip()
        if not token:
            continue
        if "-" in token:
            a, b = token.split("-", 1)
            lo = int(a) if a else 1
            hi = int(b) if b else total
        else:
            lo = hi = int(token)
        if not (1 <= lo <= hi <= total):
            raise ValueError(f"{token!r} outside 1..{total}")
        out.update(range(lo, hi + 1))
    return sorted(out)


def _render_page(path: str, page_no: int, dpi: int) -> "PIL.Image.Image":
    import pypdfium2 as pdfium
    doc = pdfium.PdfDocument(path)
    return doc[page_no - 1].render(scale=dpi / 72.0).to_pil()


def _ocr_image(img, language: str) -> str:
    import pytesseract
    return pytesseract.image_to_string(img, lang=language)


def _ocr_page_worker(args) -> tuple[int, str]:
    path, page_no, dpi, language = args
    img = _render_page(path, page_no, dpi)
    return page_no, _ocr_image(img, language)


def _run_sequential(path: str, pages: list[int], dpi: int, lang: str) -> list[tuple[int, str]]:
    results = []
    for n in pages:
        img = _render_page(path, n, dpi)
        results.append((n, _ocr_image(img, lang)))
    return results


def _run_parallel(path: str, pages: list[int], dpi: int, lang: str, workers: int):
    args = [(path, n, dpi, lang) for n in pages]
    with ProcessPoolExecutor(max_workers=workers) as pool:
        return sorted(pool.map(_ocr_page_worker, args), key=lambda x: x[0])


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="OCR a scanned PDF.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--language", default="eng")
    ap.add_argument("--dpi", type=int, default=300)
    ap.add_argument("--select", default="")
    ap.add_argument("--parallel", type=int, default=1)
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        import pypdfium2 as pdfium
    except ImportError:
        print("error: pypdfium2 required", file=sys.stderr)
        return 1
    try:
        import pytesseract  # noqa: F401
    except ImportError:
        print("error: pytesseract required (and Tesseract must be installed)",
              file=sys.stderr)
        return 1

    doc = pdfium.PdfDocument(str(ns.path))
    total = len(doc)
    try:
        pages = _pages_wanted(ns.select, total)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    if ns.parallel > 1 and len(pages) > 1:
        results = _run_parallel(str(ns.path), pages, ns.dpi, ns.language, ns.parallel)
    else:
        results = _run_sequential(str(ns.path), pages, ns.dpi, ns.language)

    joined = "".join(f"\f--- page {n} ---\n{txt}\n" for n, txt in results)

    if ns.out:
        ns.out.write_text(joined, encoding="utf-8")
        print(f"wrote {ns.out}")
    else:
        sys.stdout.write(joined)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
