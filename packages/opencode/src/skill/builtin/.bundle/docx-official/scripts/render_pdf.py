#!/usr/bin/env python3
"""Render a `.docx` as PDF for visual QA.

Alternate implementation notes:
    - Calls `soffice` directly rather than reusing `transcode.py`. Keeping
      this script self-contained lets you drop it into a QA pipeline that
      doesn't ship the rest of the toolkit.

Usage:
    uv run render_pdf.py <input.docx> [--out-dir out/]
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from pathlib import Path

_MAC_STANDALONE = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")


def _find_soffice() -> str:
    override = os.environ.get("DOCX_SKILL_SOFFICE")
    if override:
        return override
    for candidate in ("soffice", "libreoffice"):
        path = shutil.which(candidate)
        if path:
            return path
    if sys.platform == "darwin" and _MAC_STANDALONE.is_file():
        return str(_MAC_STANDALONE)
    raise RuntimeError(
        "soffice / libreoffice not found on PATH. Install LibreOffice or set "
        "DOCX_SKILL_SOFFICE to its executable path."
    )


def render_pdf(source: Path, out_dir: Path | None = None) -> Path:
    if not source.is_file():
        raise FileNotFoundError(source)
    soffice = _find_soffice()
    dest_dir = out_dir if out_dir is not None else source.parent
    dest_dir.mkdir(parents=True, exist_ok=True)

    with tempfile.TemporaryDirectory(prefix="lo-render-") as scratch:
        cmd = [
            soffice,
            "--headless",
            f"-env:UserInstallation=file://{scratch}",
            "--convert-to", "pdf",
            "--outdir", str(dest_dir),
            str(source),
        ]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise RuntimeError(
                f"soffice exit {proc.returncode}\n"
                f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
            )

    produced = dest_dir / f"{source.stem}.pdf"
    if not produced.is_file():
        raise RuntimeError(f"soffice reported success but {produced} is missing")
    return produced


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Render a .docx to PDF for visual review."
    )
    parser.add_argument("source", type=Path, help="Source .docx file")
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Where to write the PDF (default: alongside source).")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        produced = render_pdf(args.source, args.out_dir)
    except FileNotFoundError:
        sys.stderr.write(f"render_pdf: {args.source} is not a file\n")
        return 2
    except Exception as exc:
        sys.stderr.write(f"render_pdf: {exc}\n")
        return 1
    print(produced)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
