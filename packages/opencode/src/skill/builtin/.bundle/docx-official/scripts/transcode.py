#!/usr/bin/env python3
"""Format transcoding for Office documents via a LibreOffice CLI backend.

Alternate implementation notes:
    - Backed by a small `LibreOfficeBackend` class that encapsulates locating
      `soffice`, provisioning a scratch profile per call, and running the
      subprocess. Callers use a fluent API (`Transcode(source).to("pdf")`).
    - Supported targets: docx, pdf, png (PDF then rasterise via Poppler),
      odt, html, txt — the last three are pass-throughs to whatever soffice
      knows how to write.

Usage:
    uv run transcode.py <input> --to pdf
    uv run transcode.py <input> --to png --dpi 200 --out-dir out/
"""
from __future__ import annotations

import argparse
import os
import shutil
import subprocess
import sys
import tempfile
from dataclasses import dataclass
from pathlib import Path

_MAC_STANDALONE = Path("/Applications/LibreOffice.app/Contents/MacOS/soffice")


class BackendMissing(RuntimeError):
    """soffice / libreoffice is not on PATH and not at a known install path."""


class BackendFailure(RuntimeError):
    """The backend ran but did not produce the requested output."""


class LibreOfficeBackend:
    """Locate and run soffice with a fresh user profile per invocation."""

    _ENV_OVERRIDE = "DOCX_SKILL_SOFFICE"

    def __init__(self, executable: str | None = None) -> None:
        self._executable = executable or self._discover()

    @classmethod
    def _discover(cls) -> str:
        override = os.environ.get(cls._ENV_OVERRIDE)
        if override:
            return override
        for candidate in ("soffice", "libreoffice"):
            path = shutil.which(candidate)
            if path:
                return path
        if sys.platform == "darwin" and _MAC_STANDALONE.is_file():
            return str(_MAC_STANDALONE)
        raise BackendMissing(
            "soffice / libreoffice not found on PATH. "
            "Install LibreOffice or set the "
            f"{cls._ENV_OVERRIDE} environment variable to the executable."
        )

    def convert(self, source: Path, out_dir: Path, target_fmt: str) -> Path:
        out_dir.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(prefix="lo-profile-") as profile:
            cmd = [
                self._executable,
                "--headless",
                f"-env:UserInstallation=file://{profile}",
                "--convert-to", target_fmt,
                "--outdir", str(out_dir),
                str(source),
            ]
            proc = subprocess.run(cmd, capture_output=True, text=True)
            if proc.returncode != 0:
                raise BackendFailure(
                    f"soffice exit {proc.returncode}\n"
                    f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
                )
        # soffice writes <stem>.<target_fmt_without_options> in --outdir.
        core = target_fmt.split(":", 1)[0]
        produced = out_dir / f"{source.stem}.{core}"
        if not produced.is_file():
            raise BackendFailure(
                f"soffice succeeded but {produced} is missing.\n"
                f"stdout: {proc.stdout}\nstderr: {proc.stderr}"
            )
        return produced


@dataclass
class Transcode:
    """Fluent entry point. `.to(fmt)` returns the produced file's path."""

    source: Path
    out_dir: Path | None = None
    dpi: int = 150
    backend: LibreOfficeBackend | None = None

    def _resolve_out_dir(self) -> Path:
        return self.out_dir if self.out_dir is not None else self.source.parent

    def _backend(self) -> LibreOfficeBackend:
        return self.backend or LibreOfficeBackend()

    def to(self, target: str) -> Path | list[Path]:
        if not self.source.is_file():
            raise FileNotFoundError(self.source)

        out = self._resolve_out_dir()
        target = target.lower()

        if target == "png":
            pdf = self._backend().convert(self.source, out, "pdf")
            return self._rasterise(pdf, out)

        if target in {"docx", "pdf", "odt", "html", "txt"}:
            return self._backend().convert(self.source, out, target)

        raise ValueError(f"unsupported target: {target!r}")

    def _rasterise(self, pdf: Path, out_dir: Path) -> list[Path]:
        if shutil.which("pdftoppm") is None:
            raise BackendMissing(
                "pdftoppm (Poppler) is not on PATH. Install poppler-utils, "
                "or convert only as far as PDF."
            )
        cmd = ["pdftoppm", "-png", "-r", str(self.dpi),
               str(pdf), str(out_dir / pdf.stem)]
        proc = subprocess.run(cmd, capture_output=True, text=True)
        if proc.returncode != 0:
            raise BackendFailure(
                f"pdftoppm exit {proc.returncode}: {proc.stderr}"
            )
        pages = sorted(out_dir.glob(f"{pdf.stem}-*.png"))
        if not pages:
            raise BackendFailure("pdftoppm produced no PNG output.")
        return pages


def _parse_args(argv: list[str]) -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Transcode Office documents via LibreOffice."
    )
    parser.add_argument("source", type=Path, help="Input file")
    parser.add_argument("--to", dest="target", required=True,
                        help="Target format: docx, pdf, png, odt, html, txt")
    parser.add_argument("--out-dir", type=Path, default=None,
                        help="Directory for the produced file (default: source's).")
    parser.add_argument("--dpi", type=int, default=150,
                        help="Rasterisation DPI for PNG target (default 150).")
    return parser.parse_args(argv)


def main(argv: list[str] | None = None) -> int:
    args = _parse_args(sys.argv[1:] if argv is None else argv)
    try:
        result = Transcode(
            source=args.source,
            out_dir=args.out_dir,
            dpi=args.dpi,
        ).to(args.target)
    except FileNotFoundError:
        sys.stderr.write(f"transcode: {args.source} is not a file\n")
        return 2
    except (BackendMissing, BackendFailure, ValueError) as exc:
        sys.stderr.write(f"transcode: {exc}\n")
        return 1
    if isinstance(result, list):
        for page in result:
            print(page)
    else:
        print(result)
    return 0


if __name__ == "__main__":  # pragma: no cover
    raise SystemExit(main())
