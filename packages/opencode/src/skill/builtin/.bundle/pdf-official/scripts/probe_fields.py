#!/usr/bin/env python3
"""probe_fields.py — introspect a PDF's interactive fields or layout skeleton.

Two probes selectable with --mode:

    --mode widgets (default)
        Walk every /Widget annotation, resolve field name + type + rect +
        legal values. Emits a JSON array of field descriptors.

    --mode skeleton
        Extract text tokens, horizontal rules, and checkbox-sized rectangles
        via pdfplumber. Useful when the file has no AcroForm and you need to
        author coordinates by hand for `overlay_text.py`.

Optional:
    --render-marked DIR/    render each page as PNG with red rectangles at
                            every field location, and the field name printed
                            just above (widgets mode only).
    --output FILE.json      write JSON here (default: stdout)
    --dpi INT               DPI for --render-marked (default 200)

Exit codes: 0 ok / 1 runtime failure / 2 bad usage.
"""

from __future__ import annotations

import argparse
import json
import sys
from dataclasses import asdict, dataclass, field as _field
from pathlib import Path
from typing import Iterator


# ---------------------------------------------------------------- data model

@dataclass
class FieldRecord:
    name: str
    kind: str
    page: int
    rect: list[float] | None = None
    multiline: bool = False
    password: bool = False
    checked_value: str | None = None
    unchecked_value: str | None = None
    options: list[dict] = _field(default_factory=list)


@dataclass
class PageSkeleton:
    page: int
    width: float
    height: float
    labels: list[dict] = _field(default_factory=list)
    rules: list[dict] = _field(default_factory=list)
    squares: list[dict] = _field(default_factory=list)


# ---------------------------------------------------------------- widget visitor

class _WidgetVisitor:
    """Walk /Annots on each page and produce FieldRecord instances."""

    _FT_TEXT = "/Tx"
    _FT_BUTTON = "/Btn"
    _FT_CHOICE = "/Ch"
    _FT_SIGNATURE = "/Sig"

    _FLAG_MULTILINE = 1 << 12
    _FLAG_PASSWORD = 1 << 13
    _FLAG_RADIO = 1 << 15
    _FLAG_PUSHBUTTON = 1 << 16

    def __init__(self, reader):
        self.reader = reader
        self._collected: dict[str, FieldRecord] = {}

    @staticmethod
    def _deref(obj):
        return obj.get_object() if hasattr(obj, "get_object") else obj

    @classmethod
    def _climb(cls, node, attribute: str):
        """Look up `attribute` on `node`, then its /Parent chain."""
        cursor, guard = node, set()
        while cursor is not None and id(cursor) not in guard:
            guard.add(id(cursor))
            if attribute in cursor:
                return cursor[attribute]
            parent = cursor.get("/Parent")
            cursor = cls._deref(parent) if parent else None
        return None

    @classmethod
    def _fq_name(cls, node) -> str | None:
        """Dot-joined name, walking up /Parent."""
        pieces, guard = [], set()
        cursor = node
        while cursor is not None and id(cursor) not in guard:
            guard.add(id(cursor))
            t = cursor.get("/T")
            if t is not None:
                pieces.append(str(t))
            parent = cursor.get("/Parent")
            cursor = cls._deref(parent) if parent else None
        if not pieces:
            return None
        return ".".join(reversed(pieces))

    @classmethod
    def _widget_rect(cls, widget) -> list[float] | None:
        raw = widget.get("/Rect")
        return [float(x) for x in raw] if raw else None

    @classmethod
    def _button_on(cls, widget) -> str:
        ap = widget.get("/AP")
        if not ap:
            return "/Yes"
        ap = cls._deref(ap)
        n = ap.get("/N") if ap else None
        if not n:
            return "/Yes"
        n = cls._deref(n)
        for key in n:
            if str(key) != "/Off":
                return str(key)
        return "/Yes"

    def _iter_widget_annots(self) -> Iterator[tuple[int, object]]:
        for page_no, page in enumerate(self.reader.pages, start=1):
            for ref in (page.get("/Annots") or []):
                annot = self._deref(ref)
                if annot and annot.get("/Subtype") == "/Widget":
                    yield page_no, annot

    def _record_text(self, name, annot, page_no, flags):
        self._collected[name] = FieldRecord(
            name=name, kind="text", page=page_no,
            rect=self._widget_rect(annot),
            multiline=bool(flags & self._FLAG_MULTILINE),
            password=bool(flags & self._FLAG_PASSWORD),
        )

    def _record_checkbox(self, name, annot, page_no):
        self._collected[name] = FieldRecord(
            name=name, kind="checkbox", page=page_no,
            rect=self._widget_rect(annot),
            checked_value=self._button_on(annot),
            unchecked_value="/Off",
        )

    def _record_radio(self, name, annot, page_no):
        rec = self._collected.setdefault(name, FieldRecord(
            name=name, kind="radio_group", page=page_no,
        ))
        rec.options.append({
            "value": self._button_on(annot),
            "page": page_no,
            "rect": self._widget_rect(annot),
        })

    def _record_choice(self, name, annot, page_no):
        raw = self._climb(annot, "/Opt") or []
        opts: list[dict] = []
        for item in raw:
            resolved = self._deref(item) if hasattr(item, "get_object") else item
            if isinstance(resolved, list) and len(resolved) >= 2:
                opts.append({"value": str(resolved[0]), "text": str(resolved[1])})
            else:
                opts.append({"value": str(resolved), "text": str(resolved)})
        self._collected[name] = FieldRecord(
            name=name, kind="choice", page=page_no,
            rect=self._widget_rect(annot), options=opts,
        )

    def _record_signature(self, name, annot, page_no):
        self._collected[name] = FieldRecord(
            name=name, kind="signature", page=page_no,
            rect=self._widget_rect(annot),
        )

    def collect(self) -> list[FieldRecord]:
        for page_no, annot in self._iter_widget_annots():
            name = self._fq_name(annot)
            if not name:
                continue
            ft = self._climb(annot, "/FT")
            ft = str(ft) if ft is not None else None
            flags = int(self._climb(annot, "/Ff") or 0)

            if ft == self._FT_TEXT:
                self._record_text(name, annot, page_no, flags)
            elif ft == self._FT_BUTTON:
                if flags & self._FLAG_PUSHBUTTON:
                    continue
                if flags & self._FLAG_RADIO:
                    self._record_radio(name, annot, page_no)
                else:
                    self._record_checkbox(name, annot, page_no)
            elif ft == self._FT_CHOICE:
                self._record_choice(name, annot, page_no)
            elif ft == self._FT_SIGNATURE:
                self._record_signature(name, annot, page_no)

        return list(self._collected.values())


def probe_widgets(pdf_path: Path) -> list[FieldRecord]:
    from pypdf import PdfReader

    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        raise RuntimeError("file is encrypted; unlock first")
    root = reader.trailer.get("/Root", {})
    if "/AcroForm" not in root:
        return []
    return _WidgetVisitor(reader).collect()


# ---------------------------------------------------------------- skeleton probe

def probe_skeleton(pdf_path: Path) -> list[PageSkeleton]:
    import pdfplumber

    def _label(word):
        return {
            "text": word["text"],
            "x0": round(float(word["x0"]), 2),
            "top": round(float(word["top"]), 2),
            "x1": round(float(word["x1"]), 2),
            "bottom": round(float(word["bottom"]), 2),
        }

    def _rule(line):
        return {
            "x0": round(float(line["x0"]), 2),
            "x1": round(float(line["x1"]), 2),
            "y": round(float(line["top"]), 2),
        }

    def _square(rect):
        w = float(rect["x1"]) - float(rect["x0"])
        h = float(rect["bottom"]) - float(rect["top"])
        if not (6 <= w <= 22 and 6 <= h <= 22 and abs(w - h) <= 2):
            return None
        return {
            "x0": round(float(rect["x0"]), 2),
            "top": round(float(rect["top"]), 2),
            "x1": round(float(rect["x1"]), 2),
            "bottom": round(float(rect["bottom"]), 2),
            "cx": round((float(rect["x0"]) + float(rect["x1"])) / 2, 2),
            "cy": round((float(rect["top"]) + float(rect["bottom"])) / 2, 2),
        }

    with pdfplumber.open(str(pdf_path)) as pdf:
        return [
            PageSkeleton(
                page=i,
                width=float(p.width),
                height=float(p.height),
                labels=[_label(w) for w in p.extract_words()],
                rules=[_rule(l) for l in p.lines
                       if abs(l["top"] - l["bottom"]) < 1.5],
                squares=[s for r in p.rects if (s := _square(r))],
            )
            for i, p in enumerate(pdf.pages, start=1)
        ]


# ---------------------------------------------------------------- marked preview

def render_marked_pages(pdf_path: Path, fields: list[FieldRecord],
                         out_dir: Path, dpi: int = 200) -> None:
    import pypdfium2 as pdfium
    from PIL import ImageDraw, ImageFont

    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(pdf_path))
    scale = dpi / 72.0

    grouped: dict[int, list[tuple[str, list[float]]]] = {}
    for rec in fields:
        if rec.rect:
            grouped.setdefault(rec.page, []).append((rec.name, rec.rect))
        for opt in rec.options:
            if opt.get("rect") and opt.get("page"):
                label = f"{rec.name}={opt.get('value', '?')}"
                grouped.setdefault(opt["page"], []).append((label, opt["rect"]))

    for pi, page in enumerate(doc, start=1):
        img = page.render(scale=scale).to_pil().convert("RGB")
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 12)
        except OSError:
            font = ImageFont.load_default()
        page_h = page.get_height()
        for name, (x0, y0, x1, y1) in grouped.get(pi, []):
            ix0, ix1 = x0 * scale, x1 * scale
            iy0, iy1 = (page_h - y1) * scale, (page_h - y0) * scale
            draw.rectangle([ix0, iy0, ix1, iy1], outline="red", width=2)
            draw.text((ix0, max(0, iy0 - 14)), name, fill="red", font=font)
        img.save(out_dir / f"page_{pi:02d}_marked.png")


# ---------------------------------------------------------------- CLI

def _emit_json(obj, out: Path | None) -> None:
    payload = json.dumps(obj, ensure_ascii=False, indent=2)
    if out:
        out.write_text(payload, encoding="utf-8")
        print(f"wrote {out}")
    else:
        print(payload)


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Probe PDF form fields or layout.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--mode", choices=("widgets", "skeleton"), default="widgets")
    ap.add_argument("--output", type=Path)
    ap.add_argument("--render-marked", type=Path,
                    help="write annotated page PNGs (widgets mode only)")
    ap.add_argument("--dpi", type=int, default=200)
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    try:
        if ns.mode == "widgets":
            fields = probe_widgets(ns.path)
            _emit_json([asdict(f) for f in fields], ns.output)
            if ns.render_marked:
                render_marked_pages(ns.path, fields, ns.render_marked, dpi=ns.dpi)
                print(f"marked previews in {ns.render_marked}")
        else:
            pages = probe_skeleton(ns.path)
            _emit_json({"pages": [asdict(p) for p in pages]}, ns.output)
    except Exception as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
