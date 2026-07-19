#!/usr/bin/env python3
"""sanity_check.py — run a graduated set of checks over a PDF.

    python sanity_check.py FILE.pdf [--strict]

Each check reports one of:
    OK      — passed
    INFO    — informational note
    WARN    — non-fatal problem
    ERROR   — the file is likely broken

Exit codes:
    0  no ERROR-level findings
    1  at least one ERROR (or --strict and at least one WARN)
    2  bad usage / IO
"""

from __future__ import annotations

import argparse
import io
import shutil
import subprocess
import sys
from dataclasses import dataclass
from enum import Enum
from pathlib import Path


class Severity(Enum):
    OK = "OK"
    INFO = "INFO"
    WARN = "WARN"
    ERROR = "ERROR"


@dataclass
class Finding:
    check: str
    severity: Severity
    message: str


def _check_open(path: Path) -> tuple[Finding, object]:
    from pypdf import PdfReader
    from pypdf.errors import PdfReadError
    try:
        reader = PdfReader(str(path))
    except (PdfReadError, OSError) as err:
        return Finding("open", Severity.ERROR, f"cannot open: {err}"), None
    return Finding("open", Severity.OK, "opens cleanly"), reader


def _check_pages(reader) -> Finding:
    if reader.is_encrypted:
        return Finding("pages", Severity.INFO, "encrypted; skipping deep checks")
    n = len(reader.pages)
    if n < 1:
        return Finding("pages", Severity.ERROR, "zero pages")
    return Finding("pages", Severity.OK, f"{n} page(s)")


def _check_roundtrip(reader) -> Finding:
    from pypdf import PdfWriter
    if reader.is_encrypted:
        return Finding("roundtrip", Severity.INFO, "skipped (encrypted)")
    try:
        writer = PdfWriter(clone_from=reader)
        buf = io.BytesIO()
        writer.write(buf)
    except Exception as err:
        return Finding("roundtrip", Severity.ERROR, f"failed: {err}")
    return Finding("roundtrip", Severity.OK, "read → write → read is stable")


def _check_qpdf(path: Path) -> Finding:
    binary = shutil.which("qpdf")
    if not binary:
        return Finding("qpdf", Severity.INFO, "qpdf not on PATH (skipped)")
    proc = subprocess.run(
        [binary, "--check", str(path)],
        capture_output=True, text=True,
    )
    if proc.returncode == 0:
        return Finding("qpdf", Severity.OK, "qpdf --check passed")
    combined = (proc.stdout + "\n" + proc.stderr).strip().splitlines()
    detail = combined[-1] if combined else f"exit {proc.returncode}"
    sev = Severity.WARN if proc.returncode == 3 else Severity.ERROR
    return Finding("qpdf", sev, detail)


def _print(finding: Finding) -> None:
    tag = f"[{finding.severity.value:<5}]"
    print(f"{tag} {finding.check}: {finding.message}")


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Sanity-check a PDF.")
    ap.add_argument("path", type=Path)
    ap.add_argument("--strict", action="store_true",
                    help="treat WARN as non-zero exit")
    ns = ap.parse_args(argv)

    if not ns.path.exists():
        print(f"error: {ns.path} does not exist", file=sys.stderr)
        return 2

    open_finding, reader = _check_open(ns.path)
    _print(open_finding)
    if reader is None:
        return 1

    findings = [open_finding, _check_pages(reader), _check_roundtrip(reader),
                _check_qpdf(ns.path)]
    for f in findings[1:]:
        _print(f)

    has_error = any(f.severity is Severity.ERROR for f in findings)
    has_warn = any(f.severity is Severity.WARN for f in findings)
    if has_error or (ns.strict and has_warn):
        return 1
    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
