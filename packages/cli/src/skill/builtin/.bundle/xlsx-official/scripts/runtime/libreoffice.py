"""Locate and invoke a headless LibreOffice binary.

Two entry points:

    from runtime.libreoffice import locate_libreoffice, invoke
    binary = locate_libreoffice()          # raises LibreOfficeNotFound
    result = invoke(["--headless", "--version"])

The module deliberately does *not* install PRELOAD shims, wrappers, or user
profiles. Callers that need those in a sandboxed environment can construct
their own env dict and pass it through the ``extra_env`` argument of
``invoke``.
"""

from __future__ import annotations

import os
import shutil
import subprocess
from dataclasses import dataclass
from pathlib import Path
from typing import Iterable, Mapping


class LibreOfficeNotFound(FileNotFoundError):
    """Raised when neither ``soffice`` nor ``libreoffice`` is on PATH."""


_CANDIDATE_NAMES = ("soffice", "libreoffice")
_MACOS_APP_PATH = "/Applications/LibreOffice.app/Contents/MacOS/soffice"
_LINUX_HINTS = (
    "/usr/bin/soffice",
    "/usr/bin/libreoffice",
    "/opt/libreoffice/program/soffice",
)


def locate_libreoffice() -> Path:
    """Return the absolute path to a usable LibreOffice binary.

    Raises ``LibreOfficeNotFound`` with an install hint when nothing works.
    """
    bundled = os.environ.get("MIMO_SOFFICE")  # bundled runtime: use only when present, else fall through
    if bundled and Path(bundled).is_file():
        return Path(bundled)

    for name in _CANDIDATE_NAMES:
        resolved = shutil.which(name)
        if resolved:
            return Path(resolved)

    for hint in (_MACOS_APP_PATH, *_LINUX_HINTS):
        if Path(hint).exists():
            return Path(hint)

    raise LibreOfficeNotFound(
        "LibreOffice binary not found. Install it with one of:\n"
        "  macOS         brew install --cask libreoffice\n"
        "  Debian/Ubuntu apt-get install -y libreoffice\n"
        "  Fedora/RHEL   dnf install -y libreoffice"
    )


def headless_env(extra_env: Mapping[str, str] | None = None) -> dict[str, str]:
    """Return an env dict suitable for headless soffice.

    Sets the "server" VCL plugin so LibreOffice can run without an X11 display.
    Callers can extend it via ``extra_env``.
    """
    env = dict(os.environ)
    env.setdefault("SAL_USE_VCLPLUGIN", "svp")
    env.setdefault("SAL_DISABLE_JAVALDX", "1")
    if extra_env:
        env.update(extra_env)
    return env


@dataclass
class InvokeResult:
    """Outcome of ``invoke``. Wraps ``subprocess.CompletedProcess`` fields."""

    returncode: int
    stdout: str
    stderr: str

    @property
    def ok(self) -> bool:
        return self.returncode == 0


def invoke(
    args: Iterable[str],
    *,
    timeout: float | None = None,
    extra_env: Mapping[str, str] | None = None,
) -> InvokeResult:
    """Run LibreOffice with ``args`` and return an ``InvokeResult``.

    Never raises on non-zero exit — inspect ``.returncode`` / ``.stderr``
    yourself. Raises ``LibreOfficeNotFound`` if no binary exists, and lets
    ``subprocess.TimeoutExpired`` propagate.
    """
    binary = locate_libreoffice()
    proc = subprocess.run(
        [str(binary), *args],
        env=headless_env(extra_env),
        timeout=timeout,
        capture_output=True,
        text=True,
        check=False,
    )
    return InvokeResult(
        returncode=proc.returncode,
        stdout=proc.stdout or "",
        stderr=proc.stderr or "",
    )


if __name__ == "__main__":
    import sys

    result = invoke(sys.argv[1:])
    if result.stdout:
        sys.stdout.write(result.stdout)
    if result.stderr:
        sys.stderr.write(result.stderr)
    sys.exit(result.returncode)
