#!/usr/bin/env python3
"""apply_values.py — apply values to an AcroForm PDF.

    python apply_values.py FORM.pdf values.json --out filled.pdf
                          [--flatten]

`values.json` shape:

    [
      {"name": "applicant.last_name", "value": "Ramirez"},
      {"name": "citizen_flag",        "value": "/Yes"},
      {"name": "employment",          "value": "FT"}
    ]

Before writing, every value is validated:
  * name must exist in the form
  * checkbox → value ∈ {checked_value, unchecked_value}
  * radio    → value ∈ any option's value ∪ {"/Off"}
  * choice   → value ∈ any option's value
  * signature fields are refused (need a real cert)

--flatten (requires qpdf) makes the values permanent and removes widgets.

Exit codes: 0 ok / 1 runtime failure / 2 bad usage / 3 validation failure.
"""

from __future__ import annotations

import argparse
import importlib
import importlib.util
import json
import os
import shutil
import subprocess
import sys
from pathlib import Path
from typing import Any


class ValueError_(Exception):
    """Renamed to avoid clashing with builtin; raised on bad input JSON."""


def _load_probe_module():
    """Load probe_fields.py from the same directory (sibling script).

    We register in sys.modules BEFORE exec_module so that @dataclass
    decorators inside the module can look up cls.__module__ successfully
    (Python 3.12+ dataclass internals require it).
    """
    here = Path(__file__).parent / "probe_fields.py"
    spec = importlib.util.spec_from_file_location("pdf_skill_probe_fields", here)
    module = importlib.util.module_from_spec(spec)
    sys.modules["pdf_skill_probe_fields"] = module
    spec.loader.exec_module(module)
    return module


def _read_values(path: Path) -> dict[str, Any]:
    try:
        raw = json.loads(path.read_text(encoding="utf-8"))
    except json.JSONDecodeError as err:
        raise ValueError_(f"values.json: {err}") from err
    if not isinstance(raw, list):
        raise ValueError_("values.json must be a JSON array")
    result: dict[str, Any] = {}
    for i, entry in enumerate(raw):
        if not isinstance(entry, dict):
            raise ValueError_(f"entry {i}: not an object")
        if "name" not in entry or "value" not in entry:
            raise ValueError_(f"entry {i}: missing 'name' or 'value'")
        result[str(entry["name"])] = entry["value"]
    return result


def _legal_values_for(field) -> set[str] | None:
    """Return the set of legal strings for enum-typed fields, else None."""
    kind = field.kind
    if kind == "checkbox":
        return {field.checked_value, field.unchecked_value}
    if kind == "radio_group":
        legal = {opt["value"] for opt in field.options if opt.get("value")}
        legal.add("/Off")
        return legal
    if kind == "choice":
        legal = {opt["value"] for opt in field.options}
        return legal or None
    return None


def _validate(fields, values: dict[str, Any]) -> list[str]:
    by_name = {f.name: f for f in fields}
    problems: list[str] = []
    for name, value in values.items():
        if name not in by_name:
            problems.append(f"unknown field: {name!r}")
            continue
        field = by_name[name]
        if field.kind == "signature":
            problems.append(f"{name!r}: signature fields are not supported")
            continue
        legal = _legal_values_for(field)
        if legal is not None and str(value) not in legal:
            problems.append(f"{name!r}: {value!r} not in {sorted(legal)}")
    return problems


def _flatten_via_qpdf(target_pdf: Path) -> bool:
    """Flatten `target_pdf` in place. Returns True on success."""
    qpdf = os.environ.get("MIMO_QPDF")  # bundled qpdf: use only when present, else fall through
    if qpdf and not os.path.exists(qpdf):
        qpdf = None
    qpdf = qpdf or shutil.which("qpdf")
    if not qpdf:
        print("warning: qpdf not on PATH — cannot flatten", file=sys.stderr)
        return False
    flat = target_pdf.with_name(f"{target_pdf.stem}_flat_tmp.pdf")
    # --generate-appearances first: we set /NeedAppearances when filling, and
    # qpdf refuses to flatten fields whose appearances are marked stale.
    proc = subprocess.run(
        [qpdf, "--generate-appearances", "--flatten-annotations=all",
         str(target_pdf), str(flat)],
        capture_output=True, text=True,
    )
    # qpdf exit 3 = completed with warnings; the output is still written.
    if proc.returncode not in (0, 3):
        print(f"warning: qpdf flatten failed: {proc.stderr}", file=sys.stderr)
        flat.unlink(missing_ok=True)
        return False
    flat.replace(target_pdf)
    return True


def _main(argv: list[str]) -> int:
    ap = argparse.ArgumentParser(description="Apply values to an AcroForm PDF.")
    ap.add_argument("path", type=Path)
    ap.add_argument("values", type=Path)
    ap.add_argument("--out", type=Path, required=True)
    ap.add_argument("--flatten", action="store_true")
    ns = ap.parse_args(argv)

    for p in (ns.path, ns.values):
        if not p.exists():
            print(f"error: {p} does not exist", file=sys.stderr)
            return 2

    try:
        values = _read_values(ns.values)
    except ValueError_ as err:
        print(f"error: {err}", file=sys.stderr)
        return 2

    try:
        probe = _load_probe_module()
        fields = probe.probe_widgets(ns.path)
    except Exception as err:
        print(f"error: {err}", file=sys.stderr)
        return 1
    if not fields:
        print("error: no AcroForm fields; use overlay_text.py instead",
              file=sys.stderr)
        return 1

    problems = _validate(fields, values)
    if problems:
        print("validation failed:", file=sys.stderr)
        for p in problems:
            print(f"  - {p}", file=sys.stderr)
        return 3

    try:
        from pypdf import PdfReader, PdfWriter
        from pypdf.generic import BooleanObject, NameObject
    except ImportError:
        print("error: pypdf required (pip install pypdf)", file=sys.stderr)
        return 1

    reader = PdfReader(str(ns.path))
    writer = PdfWriter(clone_from=reader)

    acroform = writer._root_object.get("/AcroForm")
    if acroform is not None:
        if hasattr(acroform, "get_object"):
            acroform = acroform.get_object()
        acroform[NameObject("/NeedAppearances")] = BooleanObject(True)

    for page in writer.pages:
        writer.update_page_form_field_values(page, values)

    ns.out.parent.mkdir(parents=True, exist_ok=True)
    with ns.out.open("wb") as fh:
        writer.write(fh)
    print(f"wrote {ns.out} ({len(values)} field(s) filled)")

    if ns.flatten:
        if _flatten_via_qpdf(ns.out):
            print(f"flattened {ns.out} (widgets baked into page content)")

    return 0


if __name__ == "__main__":
    sys.exit(_main(sys.argv[1:]))
