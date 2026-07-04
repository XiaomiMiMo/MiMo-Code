#!/usr/bin/env python3
"""Bridge to LibreOffice's headless converter (`soffice`).

Turns a .pptx into any of the formats LibreOffice knows how to write:
`pdf`, `odp`, `pptx`, or an image sequence (`png`, `jpg`) via a two-stage
pipeline that goes through PDF.

Only used indirectly by the other scripts — the discoverable entry points
are `render_pdf.py` (target=pdf) and `render_slides.py` (target=png/jpg).

The `soffice` binary must be reachable on PATH; on macOS the standard
LibreOffice.app path is also probed. Nothing is bundled: this is a thin
subprocess wrapper with a fresh user profile per invocation (LibreOffice
refuses concurrent invocations that share a profile directory).

Usage (as a CLI, mostly for smoke testing):
    python soffice_bridge.py --target pdf  deck.pptx
    python soffice_bridge.py --target png  deck.pptx --out slides/
    python soffice_bridge.py --target odp  deck.pptx
"""
from __future__ import annotations

import argparse
import shutil
import subprocess
import sys
import tempfile
from contextlib import contextmanager
from pathlib import Path
from typing import Iterator

_MAC_APP_PATH = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")

DIRECT_TARGETS = frozenset({"pdf", "odp", "pptx"})
IMAGE_TARGETS = frozenset({"png", "jpg", "jpeg"})


class BridgeError(RuntimeError):
    """Any problem invoking soffice or Poppler."""


def _which_soffice() -> str:
    for name in ("soffice", "libreoffice"):
        found = shutil.which(name)
        if found:
            return found
    if sys.platform == "darwin" and _MAC_APP_PATH.is_file():
        return str(_MAC_APP_PATH)
    raise BridgeError(
        "soffice / libreoffice not found on PATH. Install LibreOffice or "
        "make its `soffice` binary reachable.")


def _which_pdftoppm() -> str:
    found = shutil.which("pdftoppm")
    if not found:
        raise BridgeError(
            "pdftoppm (poppler) not found. Install poppler-utils or "
            "convert to PDF only.")
    return found


@contextmanager
def _isolated_profile() -> Iterator[str]:
    """Yield a URI-formatted path to a fresh, empty LibreOffice profile.

    Sharing a profile between two soffice invocations is a common source of
    'Application is already running' errors in CI. Giving each invocation
    its own scratch directory sidesteps the problem entirely.
    """
    with tempfile.TemporaryDirectory(prefix="soffice-profile-") as td:
        yield f"file://{td}"


def _invoke(input_path: Path, out_dir: Path, target: str) -> Path:
    binary = _which_soffice()
    out_dir.mkdir(parents=True, exist_ok=True)
    with _isolated_profile() as profile_uri:
        result = subprocess.run(
            [
                binary, "--headless",
                f"-env:UserInstallation={profile_uri}",
                "--convert-to", target,
                "--outdir", str(out_dir),
                str(input_path),
            ],
            capture_output=True, text=True,
        )
    if result.returncode != 0:
        raise BridgeError(
            f"soffice exited {result.returncode}:\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}")

    produced = out_dir / f"{input_path.stem}.{target.split(':', 1)[0]}"
    if not produced.exists():
        raise BridgeError(
            f"soffice claimed success but {produced} is missing.\n"
            f"stdout: {result.stdout}\nstderr: {result.stderr}")
    return produced


def _rasterize(pdf_path: Path, out_dir: Path, image_ext: str, *,
               dpi: int = 150,
               first: int | None = None,
               last: int | None = None) -> list[Path]:
    binary = _which_pdftoppm()
    out_dir.mkdir(parents=True, exist_ok=True)
    prefix = out_dir / "slide"

    # pdftoppm's flag is `-jpeg` but the files it writes end in `.jpg`.
    flag = "jpeg" if image_ext in ("jpg", "jpeg") else image_ext
    file_ext = "jpg" if image_ext in ("jpg", "jpeg") else image_ext

    args: list[str] = [binary, f"-{flag}", "-r", str(dpi)]
    if first is not None:
        args += ["-f", str(first)]
    if last is not None:
        args += ["-l", str(last)]
    args += [str(pdf_path), str(prefix)]

    result = subprocess.run(args, capture_output=True, text=True)
    if result.returncode != 0:
        raise BridgeError(f"pdftoppm exited {result.returncode}: {result.stderr}")

    return sorted(out_dir.glob(f"slide-*.{file_ext}"))


def translate(source: Path, target: str, *,
              out_dir: Path | None = None,
              dpi: int = 150,
              first: int | None = None,
              last: int | None = None,
              keep_intermediate_pdf: bool = False) -> Path | list[Path]:
    """Convert `source` to `target` (one of `pdf`, `odp`, `pptx`, `png`, `jpg`).

    Returns a single Path for direct targets and a list of Paths for image
    targets (one per slide).
    """
    if not source.is_file():
        raise BridgeError(f"{source} is not a file")
    out_dir = out_dir or source.parent

    if target in DIRECT_TARGETS:
        return _invoke(source, out_dir, target)

    if target in IMAGE_TARGETS:
        pdf = _invoke(source, out_dir, "pdf")
        image_ext = "jpeg" if target == "jpg" else target
        try:
            images = _rasterize(pdf, out_dir, image_ext,
                                dpi=dpi, first=first, last=last)
        finally:
            if not keep_intermediate_pdf:
                try:
                    pdf.unlink()
                except OSError:
                    pass
        if not images:
            raise BridgeError("pdftoppm produced no images")
        return images

    raise BridgeError(f"unsupported target: {target}")


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(description=__doc__.splitlines()[0])
    ap.add_argument("source", type=Path)
    ap.add_argument("--target", required=True,
                    choices=sorted(DIRECT_TARGETS | IMAGE_TARGETS))
    ap.add_argument("--out", type=Path, default=None,
                    help="destination directory (default: alongside source)")
    ap.add_argument("--dpi", type=int, default=150,
                    help="rasterisation DPI for image targets (default 150)")
    ap.add_argument("--first", type=int, default=None,
                    help="first slide (1-based) to rasterise")
    ap.add_argument("--last", type=int, default=None,
                    help="last slide (1-based) to rasterise")
    ap.add_argument("--keep-pdf", action="store_true",
                    help="do not delete the intermediate PDF when rasterising")
    ns = ap.parse_args(argv)

    try:
        result = translate(ns.source, ns.target, out_dir=ns.out,
                           dpi=ns.dpi, first=ns.first, last=ns.last,
                           keep_intermediate_pdf=ns.keep_pdf)
    except BridgeError as exc:
        print(f"error: {exc}", file=sys.stderr)
        return 1

    if isinstance(result, list):
        for p in result:
            print(p)
    else:
        print(result)
    return 0


if __name__ == "__main__":
    sys.exit(main())
