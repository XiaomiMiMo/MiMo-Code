#!/usr/bin/env python3
"""Build a contact sheet (thumbnail grid) of every slide in a .pptx.

Renders the deck to PDF via LibreOffice, rasterises each page with
Poppler's `pdftoppm`, and composites the tiles into a single JPEG using
Pillow. Each tile is labelled with its slide number underneath.

Usage:
    python contact_sheet.py deck.pptx
    python contact_sheet.py deck.pptx --cols 4
    python contact_sheet.py deck.pptx --tile 320  # wider tiles
    python contact_sheet.py deck.pptx --limit 24  # first 24 slides only
    python contact_sheet.py deck.pptx --out preview.jpg
"""
from __future__ import annotations

import argparse
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

_HERE = Path(__file__).resolve().parent
if str(_HERE) not in sys.path:
    sys.path.insert(0, str(_HERE))

from soffice_bridge import (  # noqa: E402
    BridgeError, _invoke, _rasterize,
)


@dataclass(frozen=True)
class SheetOptions:
    columns: int = 3
    tile_width: int = 300
    gap: int = 12
    label_height: int = 22
    canvas_color: tuple[int, int, int] = (245, 245, 245)
    label_bg: tuple[int, int, int] = (255, 255, 255)
    label_fg: tuple[int, int, int] = (60, 60, 60)
    rasterise_dpi: int = 96


_FONT_CANDIDATES = (
    "/System/Library/Fonts/Helvetica.ttc",
    "/System/Library/Fonts/Supplemental/Arial.ttf",
    "/usr/share/fonts/truetype/dejavu/DejaVuSans.ttf",
    "/usr/share/fonts/truetype/liberation/LiberationSans-Regular.ttf",
)


def _load_label_font():
    from PIL import ImageFont
    for candidate in _FONT_CANDIDATES:
        if Path(candidate).is_file():
            try:
                return ImageFont.truetype(candidate, size=14)
            except Exception:
                continue
    return ImageFont.load_default()


def _rasterise_pages(pdf: Path, out_dir: Path, dpi: int) -> list[Path]:
    # Delegates to the shared bridge rasteriser: pdftoppm when available, with the
    # pypdfium2 fallback (bundled MIMO_PYTHON) when Poppler is absent.
    return _rasterize(pdf, out_dir, "jpg", dpi=dpi)


def build_sheet(source: Path,
                out: Path | None = None,
                *,
                options: SheetOptions = SheetOptions(),
                limit: int | None = None) -> Path:
    from PIL import Image, ImageDraw

    if not source.is_file():
        raise BridgeError(f"{source} is not a file")

    out = out or source.with_suffix("").with_name(source.stem + ".contact-sheet.jpg")

    with tempfile.TemporaryDirectory(prefix="pptx-contact-") as workdir_str:
        workdir = Path(workdir_str)
        pdf = _invoke(source, workdir, "pdf")
        pages = _rasterise_pages(pdf, workdir, options.rasterise_dpi)
        if not pages:
            raise BridgeError("rasterisation produced no images")
        if limit is not None:
            pages = pages[:limit]

        # Resize every rendered page to `tile_width`, aspect preserved.
        tiles: list["Image.Image"] = []
        for page in pages:
            im = Image.open(page).convert("RGB")
            ratio = options.tile_width / im.width
            tiles.append(im.resize(
                (options.tile_width, int(im.height * ratio)),
                Image.LANCZOS,
            ))

        tile_h = tiles[0].height
        rows = (len(tiles) + options.columns - 1) // options.columns
        canvas_w = options.gap + options.columns * (options.tile_width + options.gap)
        canvas_h = options.gap + rows * (tile_h + options.label_height + options.gap)
        canvas = Image.new("RGB", (canvas_w, canvas_h), options.canvas_color)
        draw = ImageDraw.Draw(canvas)
        font = _load_label_font()

        for index, tile in enumerate(tiles):
            row, col = divmod(index, options.columns)
            x = options.gap + col * (options.tile_width + options.gap)
            y = options.gap + row * (tile_h + options.label_height + options.gap)
            canvas.paste(tile, (x, y))
            band_y = y + tile_h
            draw.rectangle(
                [x, band_y, x + options.tile_width, band_y + options.label_height],
                fill=options.label_bg,
            )
            draw.text((x + 8, band_y + 3), f"Slide {index + 1}",
                      fill=options.label_fg, font=font)

        canvas.save(out, "JPEG", quality=88, optimize=True)
    return out


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("--out", type=Path, default=None,
                    help="output JPEG (default: <stem>.contact-sheet.jpg)")
    ap.add_argument("--cols", type=int, default=3, help="tiles per row (default 3)")
    ap.add_argument("--tile", type=int, default=300,
                    help="tile width in pixels (default 300)")
    ap.add_argument("--limit", type=int, default=None,
                    help="only include the first N slides")
    ap.add_argument("--dpi", type=int, default=96,
                    help="rasterise DPI before downscale (default 96)")
    ns = ap.parse_args(argv)

    try:
        import PIL  # noqa: F401
    except ImportError:
        print("error: Pillow is not installed. `pip install Pillow`", file=sys.stderr)
        return 2

    options = SheetOptions(
        columns=ns.cols,
        tile_width=ns.tile,
        rasterise_dpi=ns.dpi,
    )
    try:
        produced = build_sheet(ns.source, ns.out, options=options, limit=ns.limit)
    except BridgeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1
    print(produced)
    return 0


if __name__ == "__main__":
    sys.exit(main())
