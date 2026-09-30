#!/usr/bin/env python3
"""render_pages.py — rasterise each PDF page to an image file.

    python render_pages.py FILE.pdf OUT_DIR/ [--dpi 200]
                           [--format png|jpg] [--select 1-3]
                           [--prefix page] [--quality 90]

Uses pypdfium2 (Apache/BSD PDFium binding). No poppler required, so this
path is fully permissive.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import re
import sys
from dataclasses import dataclass
from pathlib import Path

_TOKEN_RE = re.compile(r"^\s*(\d*)\s*(-)?\s*(\d*)\s*$")


def _expand_range_list(spec: str, total: int) -> list[int]:
    if not spec:
        return list(range(1, total + 1))
    seen: set[int] = set()
    for token in spec.split(","):
        m = _TOKEN_RE.match(token)
        if not m or token.strip() == "":
            raise ValueError(f"bad range token: {token!r}")
        lo, dash, hi = m.groups()
        if dash is None:
            lo_i = hi_i = int(lo)
        else:
            lo_i = int(lo) if lo else 1
            hi_i = int(hi) if hi else total
        if not (1 <= lo_i <= hi_i <= total):
            raise ValueError(f"token {token!r} out of 1..{total}")
        seen.update(range(lo_i, hi_i + 1))
    return sorted(seen)


@dataclass
class RenderJob:
    src: Path
    out_dir: Path
    dpi: int
    fmt: str
    quality: int
    prefix: str

    @property
    def scale(self) -> float:
        return self.dpi / 72.0

    def target_for(self, page_no: int) -> Path:
        ext = "png" if self.fmt == "png" else "jpg"
        return self.out_dir / f"{self.prefix}_{page_no:03d}.{ext}"


def _save(img, dest: Path, fmt: str, quality: int) -> None:
    if fmt == "png":
        img.save(dest, "PNG")
    else:
        img.convert("RGB").save(dest, "JPEG", quality=quality)


def _run(job: RenderJob, pages: list[int]) -> None:
    import pypdfium2 as pdfium

    doc = pdfium.PdfDocument(str(job.src))
    total = len(doc)
    wanted = pages or list(range(1, total + 1))

    for n in wanted:
        bitmap = doc[n - 1].render(scale=job.scale)
        dest = job.target_for(n)
        _save(bitmap.to_pil(), dest, job.fmt, job.quality)
        print(f"wrote {dest}")


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Rasterise PDF pages.")
    ap.add_argument("path", type=Path)
    ap.add_argument("out_dir", type=Path)
    ap.add_argument("--dpi", type=int, default=150)
    ap.add_argument("--format", choices=("png", "jpg"), default="png",
                    dest="fmt")
    ap.add_argument("--select", default="", help="e.g. 1-3,5,8")
    ap.add_argument("--prefix", default="page")
    ap.add_argument("--quality", type=int, default=90)
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        import pypdfium2 as pdfium
    except ImportError:
        print("error: pypdfium2 required (pip install pypdfium2)", file=sys.stderr)
        return 1

    ns.out_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(ns.path))
    total = len(doc)

    try:
        pages = _expand_range_list(ns.select, total) if ns.select else []
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    job = RenderJob(
        src=ns.path, out_dir=ns.out_dir,
        dpi=ns.dpi, fmt=ns.fmt, quality=ns.quality, prefix=ns.prefix,
    )
    try:
        _run(job, pages)
    except Exception as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
