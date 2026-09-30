#!/usr/bin/env python3
"""overlay_text.py — stamp text/checks onto a non-AcroForm PDF.

Draws a transparent overlay with reportlab, then merges it onto the source
page(s). Use when the target PDF has no interactive fields.

    # Validate + preview (no PDF written):
    python overlay_text.py FORM.pdf plan.json --dry-run --preview qa/

    # Real fill:
    python overlay_text.py FORM.pdf plan.json --out filled.pdf

plan.json:

    {
      "geometry": "pdf_points" | "image_pixels",
      "page_size":  {"width": 612, "height": 792},
      "image_size": {"width": 1700, "height": 2200},   # only for image_pixels
      "marks": [
        {"page": 1, "kind": "text",  "box": [x0,y0,x1,y1],
         "text": "Ramirez", "font_size": 10, "font": "Helvetica"},
        {"page": 1, "kind": "check", "box": [x0,y0,x1,y1]}
      ]
    }

Coordinates:
  pdf_points   — origin bottom-left, y grows upward (native PDF)
  image_pixels — origin top-left,    y grows downward

Validation before drawing:
  * geometry declared and legal
  * each box strictly non-degenerate
  * text marks fit vertically at the requested font_size
  * no two marks on a page have overlapping boxes
  * pages referenced actually exist

Exit codes: 0 ok / 1 runtime failure / 2 bad usage / 3 validation failure.
"""

from __future__ import annotations

import argparse
import io
import json
import sys
from dataclasses import dataclass
from pathlib import Path


# ---------------------------------------------------------------- types

@dataclass
class Mark:
    page: int
    kind: str
    box: tuple[float, float, float, float]
    text: str | None = None
    font: str = "Helvetica"
    font_size: float = 10.0


@dataclass
class Plan:
    geometry: str
    page_w: float
    page_h: float
    image_w: float | None
    image_h: float | None
    marks: list[Mark]


# ---------------------------------------------------------------- parsing

def _parse_plan(raw: dict) -> Plan:
    geometry = raw.get("geometry")
    if geometry not in ("pdf_points", "image_pixels"):
        raise ValueError("geometry must be 'pdf_points' or 'image_pixels'")

    page_size = raw.get("page_size")
    if not isinstance(page_size, dict):
        raise ValueError("page_size {width, height} is required")

    image_size = raw.get("image_size")
    if geometry == "image_pixels" and not isinstance(image_size, dict):
        raise ValueError("image_size is required when geometry='image_pixels'")

    raw_marks = raw.get("marks")
    if not isinstance(raw_marks, list) or not raw_marks:
        raise ValueError("marks must be a non-empty array")

    marks: list[Mark] = []
    for i, entry in enumerate(raw_marks):
        if not isinstance(entry, dict):
            raise ValueError(f"marks[{i}] is not an object")
        kind = entry.get("kind")
        if kind not in ("text", "check"):
            raise ValueError(f"marks[{i}].kind must be 'text' or 'check'")
        box = entry.get("box")
        if not isinstance(box, list) or len(box) != 4:
            raise ValueError(f"marks[{i}].box must be [x0,y0,x1,y1]")
        page = entry.get("page")
        if not isinstance(page, int) or page < 1:
            raise ValueError(f"marks[{i}].page must be a positive int")
        marks.append(Mark(
            page=page, kind=kind,
            box=tuple(float(v) for v in box),
            text=entry.get("text"),
            font=entry.get("font", "Helvetica"),
            font_size=float(entry.get("font_size", 10.0)),
        ))

    return Plan(
        geometry=geometry,
        page_w=float(page_size["width"]),
        page_h=float(page_size["height"]),
        image_w=float(image_size["width"]) if image_size else None,
        image_h=float(image_size["height"]) if image_size else None,
        marks=marks,
    )


# ---------------------------------------------------------------- validation

def _lint_boxes(plan: Plan) -> list[str]:
    problems: list[str] = []
    for i, m in enumerate(plan.marks):
        x0, y0, x1, y1 = m.box
        if x0 >= x1 or y0 >= y1:
            problems.append(f"marks[{i}].box is degenerate")
    return problems


def _lint_text_heights(plan: Plan) -> list[str]:
    problems: list[str] = []
    for i, m in enumerate(plan.marks):
        if m.kind != "text":
            continue
        if not m.text:
            problems.append(f"marks[{i}].text is required")
            continue
        _, y0, _, y1 = m.box
        if (y1 - y0) < m.font_size * 0.9:
            problems.append(
                f"marks[{i}].box height {y1 - y0:.1f} < font_size {m.font_size}"
            )
    return problems


def _lint_overlaps(plan: Plan) -> list[str]:
    problems: list[str] = []
    by_page: dict[int, list[tuple[int, Mark]]] = {}
    for i, m in enumerate(plan.marks):
        by_page.setdefault(m.page, []).append((i, m))
    for page, items in by_page.items():
        for a in range(len(items)):
            for b in range(a + 1, len(items)):
                ia, ma = items[a]
                ib, mb = items[b]
                ax0, ay0, ax1, ay1 = ma.box
                bx0, by0, bx1, by1 = mb.box
                if ax0 < bx1 and bx0 < ax1 and ay0 < by1 and by0 < ay1:
                    problems.append(
                        f"page {page}: marks[{ia}] and marks[{ib}] overlap"
                    )
    return problems


def _lint(plan: Plan) -> list[str]:
    return _lint_boxes(plan) + _lint_text_heights(plan) + _lint_overlaps(plan)


# ---------------------------------------------------------------- coordinates

def _to_pdf_box(mark: Mark, plan: Plan) -> tuple[float, float, float, float]:
    """Return (x0, y0_from_bottom, x1, y1_from_bottom) in PDF points."""
    x0, y0, x1, y1 = mark.box
    if plan.geometry == "pdf_points":
        # Already native PDF coordinates: origin bottom-left, y grows upward.
        return (x0, y0, x1, y1)
    # image_pixels: origin top-left, y grows downward — scale then flip.
    sx = plan.page_w / plan.image_w  # type: ignore[operator]
    sy = plan.page_h / plan.image_h  # type: ignore[operator]
    return (x0 * sx, plan.page_h - y1 * sy, x1 * sx, plan.page_h - y0 * sy)


# ---------------------------------------------------------------- rendering

def _draw_overlay_for_page(plan: Plan, marks: list[Mark]) -> bytes:
    from reportlab.pdfgen import canvas

    buf = io.BytesIO()
    c = canvas.Canvas(buf, pagesize=(plan.page_w, plan.page_h))
    for m in marks:
        x0, y0, x1, y1 = _to_pdf_box(m, plan)
        if m.kind == "text":
            c.setFont(m.font, m.font_size)
            baseline = y0 + max(0, (y1 - y0 - m.font_size * 0.85) / 2)
            c.drawString(x0 + 1, baseline, m.text or "")
        else:  # check
            c.setStrokeColorRGB(0, 0, 0)
            c.setLineWidth(1.5)
            c.line(x0 + 1, y0 + 1, x1 - 1, y1 - 1)
            c.line(x0 + 1, y1 - 1, x1 - 1, y0 + 1)
    c.showPage()
    c.save()
    return buf.getvalue()


def _write_preview(pdf_path: Path, plan: Plan, out_dir: Path, dpi: int = 200) -> None:
    import pypdfium2 as pdfium
    from PIL import ImageDraw, ImageFont

    out_dir.mkdir(parents=True, exist_ok=True)
    doc = pdfium.PdfDocument(str(pdf_path))
    scale = dpi / 72.0

    by_page: dict[int, list[Mark]] = {}
    for m in plan.marks:
        by_page.setdefault(m.page, []).append(m)

    for pi, page in enumerate(doc, start=1):
        img = page.render(scale=scale).to_pil().convert("RGB")
        draw = ImageDraw.Draw(img)
        try:
            font = ImageFont.truetype("DejaVuSans.ttf", 12)
        except OSError:
            font = ImageFont.load_default()
        page_h = page.get_height()
        for m in by_page.get(pi, []):
            x0p, y0p, x1p, y1p = _to_pdf_box(m, plan)
            ix0, ix1 = x0p * scale, x1p * scale
            iy0, iy1 = (page_h - y1p) * scale, (page_h - y0p) * scale
            draw.rectangle([ix0, iy0, ix1, iy1], outline="red", width=2)
            label = m.text if m.kind == "text" else "[X]"
            draw.text((ix0, max(0, iy0 - 14)), label or "", fill="red", font=font)
        img.save(out_dir / f"page_{pi:02d}_preview.png")


def _apply_overlays(pdf_path: Path, plan: Plan, out_path: Path) -> None:
    from pypdf import PdfReader, PdfWriter

    reader = PdfReader(str(pdf_path))
    if reader.is_encrypted:
        raise RuntimeError("file is encrypted; unlock first")

    total_pages = len(reader.pages)
    by_page: dict[int, list[Mark]] = {}
    for m in plan.marks:
        if m.page > total_pages:
            raise ValueError(
                f"marks reference page {m.page}, only {total_pages} pages exist"
            )
        by_page.setdefault(m.page, []).append(m)

    writer = PdfWriter()
    for i, page in enumerate(reader.pages, start=1):
        if i in by_page:
            layer_bytes = _draw_overlay_for_page(plan, by_page[i])
            overlay = PdfReader(io.BytesIO(layer_bytes)).pages[0]
            page.merge_page(overlay)
        writer.add_page(page)

    out_path.parent.mkdir(parents=True, exist_ok=True)
    with out_path.open("wb") as fh:
        writer.write(fh)


# ---------------------------------------------------------------- CLI

def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Overlay text/checks onto a PDF.")
    ap.add_argument("path", type=Path)
    ap.add_argument("plan", type=Path)
    ap.add_argument("--out", type=Path)
    ap.add_argument("--dry-run", action="store_true")
    ap.add_argument("--preview", type=Path)
    ap.add_argument("--dpi", type=int, default=200)
    ns = ap.parse_args(argv)

    for p in (ns.path, ns.plan):
        if not p.exists():
            print(f"error: {p} does not exist", file=sys.stderr)
            return 2

    if not ns.dry_run and not ns.out:
        print("error: --out is required unless --dry-run", file=sys.stderr)
        return 2

    try:
        raw = json.loads(ns.plan.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        print(f"error: plan.json: {err}", file=sys.stderr)
        return 2

    try:
        plan = _parse_plan(raw)
    except ValueError as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    problems = _lint(plan)
    try:
        from pypdf import PdfReader
        total_pages = len(PdfReader(str(ns.path)).pages)
    except Exception:
        total_pages = None  # unreadable here; _apply_overlays still checks
    if total_pages is not None:
        problems += [
            f"marks[{i}] references page {m.page}, only {total_pages} pages exist"
            for i, m in enumerate(plan.marks) if m.page > total_pages
        ]
    if problems:
        print("validation failed:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 3

    if ns.preview:
        try:
            _write_preview(ns.path, plan, ns.preview, dpi=ns.dpi)
            print(f"wrote previews in {ns.preview}")
        except Exception as err:
            print(f"warning: preview failed: {err}", file=sys.stderr)

    if ns.dry_run:
        print("[dry-run] validation passed, no PDF written")
        return 0

    try:
        _apply_overlays(ns.path, plan, ns.out)
    except (RuntimeError, ValueError) as err:
        print(f"error: {err}", file=sys.stderr)
        return 1

    print(f"wrote {ns.out} ({len(plan.marks)} mark(s) stamped)")
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
