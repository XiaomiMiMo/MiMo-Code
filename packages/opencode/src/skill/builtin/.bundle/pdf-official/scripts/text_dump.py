#!/usr/bin/env python3
"""text_dump.py — dump plain text from a PDF.

    python text_dump.py FILE.pdf [--out OUT.txt] [--engine auto|python|poppler]
                                 [--layout] [--select 1-5,7,10-]

Engines:
  auto     use poppler's pdftotext if on PATH, otherwise pypdf
  python   force the pure-Python path (no GPL dependency)
  poppler  force the pdftotext binary; error out if not present

--layout only affects the poppler engine (keeps columns aligned).
--select is a comma list of 1-based ranges. A trailing dash means "to end",
         e.g. "10-" is pages 10..end; "-5" is pages 1..5.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import re
import shutil
import subprocess
import sys
from pathlib import Path

_RANGE_RE = re.compile(r"^\s*(\d*)\s*(-)?\s*(\d*)\s*$")


def _expand_selection(spec: str, total: int) -> list[int]:
    """Turn '1-3,5,10-' into a sorted list of 1-based page numbers."""
    if not spec:
        return list(range(1, total + 1))
    picks: set[int] = set()
    for chunk in spec.split(","):
        m = _RANGE_RE.match(chunk)
        if not m or chunk.strip() == "":
            raise ValueError(f"bad range: {chunk!r}")
        lo, dash, hi = m.groups()
        if dash is None:
            n = int(lo)
            start = end = n
        else:
            start = int(lo) if lo else 1
            end = int(hi) if hi else total
        if not (1 <= start <= end <= total):
            raise ValueError(f"range {chunk!r} outside 1..{total}")
        picks.update(range(start, end + 1))
    return sorted(picks)


def _pick_engine(requested: str) -> str:
    if requested == "python":
        return "python"
    if requested == "poppler":
        if shutil.which("pdftotext") is None:
            raise RuntimeError("pdftotext (poppler) not on PATH")
        return "poppler"
    # auto
    return "poppler" if shutil.which("pdftotext") else "python"


def _page_count(path: Path) -> int:
    try:
        from pypdf import PdfReader
        from pypdf.errors import PdfReadError
    except ImportError:
        raise RuntimeError(
            "pypdf is required to validate --select (pip install pypdf)")
    try:
        reader = PdfReader(str(path))
        if reader.is_encrypted and reader.decrypt("") == 0:
            raise RuntimeError("locked — unlock first with qpdf --decrypt")
        return len(reader.pages)
    except PdfReadError as err:
        raise RuntimeError(f"cannot read {path.name}: {err}")


def _contiguous_runs(pages: list[int]) -> list[tuple[int, int]]:
    """[1,2,3,7] → [(1,3), (7,7)]"""
    runs: list[list[int]] = []
    for n in pages:
        if runs and n == runs[-1][1] + 1:
            runs[-1][1] = n
        else:
            runs.append([n, n])
    return [(a, b) for a, b in runs]


def _dump_via_pypdf(path: Path, pages: list[int]) -> str:
    from pypdf import PdfReader

    reader = PdfReader(str(path))
    if reader.is_encrypted and reader.decrypt("") == 0:
        raise RuntimeError("locked — unlock first with qpdf --decrypt")

    total = len(reader.pages)
    wanted = pages or list(range(1, total + 1))

    buf: list[str] = []
    for n in wanted:
        buf.append(f"\f--- page {n} ---\n")
        buf.append(reader.pages[n - 1].extract_text() or "")
        buf.append("\n")
    return "".join(buf)


def _dump_via_poppler(path: Path, pages: list[int], layout: bool) -> str:
    base = ["pdftotext"]
    if layout:
        base.append("-layout")
    if not pages:
        proc = subprocess.run([*base, str(path), "-"],
                              check=True, capture_output=True)
        return proc.stdout.decode("utf-8", errors="replace")
    # pdftotext only takes one -f/-l window, so run once per contiguous
    # range — "1-3,7" must not silently dump pages 4-6.
    chunks: list[str] = []
    for start, end in _contiguous_runs(pages):
        proc = subprocess.run(
            [*base, "-f", str(start), "-l", str(end), str(path), "-"],
            check=True, capture_output=True)
        chunks.append(proc.stdout.decode("utf-8", errors="replace"))
    return "".join(chunks)


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Dump PDF text.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--engine", choices=("auto", "python", "poppler"), default="auto")
    ap.add_argument("--layout", action="store_true")
    ap.add_argument("--select", default="", help="e.g. 1-3,5,8-")
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        engine = _pick_engine(ns.engine)
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    pages: list[int] = []
    if ns.select:
        try:
            pages = _expand_selection(ns.select, _page_count(ns.path))
        except ValueError as err:
            print(f"error: {err}", file=sys.stderr)
            return 2
        except RuntimeError as err:
            print(f"error: {err}", file=sys.stderr)
            return 1

    try:
        if engine == "python":
            text = _dump_via_pypdf(ns.path, pages)
        else:
            text = _dump_via_poppler(ns.path, pages, ns.layout)
    except subprocess.CalledProcessError as err:
        print(f"error: pdftotext exited {err.returncode}", file=sys.stderr)
        return 1
    except RuntimeError as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    if ns.out:
        ns.out.write_text(text, encoding="utf-8")
    else:
        sys.stdout.write(text)
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
