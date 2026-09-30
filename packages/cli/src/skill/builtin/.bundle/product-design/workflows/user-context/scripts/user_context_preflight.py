#!/usr/bin/env python3
"""Read local Product Design context and print compact JSON."""

from __future__ import annotations

import argparse
import hashlib
import json
import os
import re
import sys
from datetime import datetime, timezone
from pathlib import Path
from typing import Any

PLUGIN_STATE_DIR = Path("state/plugins/product-design")
DEFAULT_MAX_CONTEXT_BYTES = 2_000_000


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Read Product Design user-context.md and return saved context as JSON."
    )
    parser.add_argument(
        "--codex-home",
        type=Path,
        default=None,
        help="Codex home directory. Defaults to $CODEX_HOME or ~/.codex.",
    )
    parser.add_argument(
        "--state-dir",
        type=Path,
        default=None,
        help="Override the Product Design state directory.",
    )
    parser.add_argument(
        "--max-context-bytes",
        type=int,
        default=DEFAULT_MAX_CONTEXT_BYTES,
        help="Maximum user-context.md size to read.",
    )
    return parser.parse_args()


def resolve_state_dir(codex_home: Path | None, state_dir: Path | None) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    home = codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex"))
    return (home.expanduser() / PLUGIN_STATE_DIR).resolve()


def file_mtime(path: Path) -> str | None:
    try:
        return datetime.fromtimestamp(path.stat().st_mtime, tz=timezone.utc).isoformat()
    except OSError:
        return None


def sha256_text(text: str) -> str:
    return hashlib.sha256(text.encode("utf-8")).hexdigest()


def parse_resource_name(line: str) -> dict[str, str]:
    link_match = re.match(r"^\[(.+?)\]\((.+?)\)\s*$", line)
    if link_match:
        return {"name": link_match.group(1).strip(), "url": link_match.group(2).strip()}
    url_match = re.match(r"^(https?://\S+)\s*$", line)
    if url_match:
        return {"name": url_match.group(1).strip(), "url": url_match.group(1).strip()}
    return {"name": line.strip()}


def summarize_user_context(markdown: str) -> dict[str, Any]:
    entries: list[dict[str, Any]] = []
    unresolved_categories: list[str] = []
    category: str | None = None
    in_saved_context = False
    current_entry: dict[str, Any] | None = None

    def flush_entry() -> None:
        nonlocal current_entry
        if current_entry:
            entries.append(current_entry)
            current_entry = None

    for raw_line in markdown.splitlines():
        line = raw_line.strip()
        if not line or line.startswith(("<!--", "-->")):
            continue

        category_match = re.match(r"^# ([^#].*?)\s*$", line)
        if category_match:
            flush_entry()
            category = category_match.group(1).strip()
            in_saved_context = False
            continue

        if line == "## Saved Links And Context":
            flush_entry()
            in_saved_context = True
            continue

        if not category or not in_saved_context:
            continue

        if line.casefold() == "status: not provided" or line.casefold() == "status: not provided.":
            flush_entry()
            unresolved_categories.append(category)
            continue

        if not line.startswith("- "):
            flush_entry()
            current_entry = {"category": category, **parse_resource_name(line)}
            continue

        if not current_entry:
            continue

        bullet = line[2:].strip()
        for prefix, key in (
            ("Date Added:", "date_added"),
            ("File:", "file"),
            ("Useful Context:", "useful_context"),
            ("Future Use:", "future_use"),
        ):
            if bullet.startswith(prefix):
                current_entry[key] = bullet[len(prefix) :].strip().rstrip(".")
                break
        else:
            current_entry.setdefault("notes", []).append(bullet)

    flush_entry()
    return {"entries": entries, "unresolved_categories": unresolved_categories}


def missing_payload(state_dir: Path, context_path: Path) -> dict[str, Any]:
    return {
        "plugin": "product-design",
        "state_dir": str(state_dir),
        "user_context": {
            "path": str(context_path),
            "exists": False,
            "status": "missing",
            "entries": [],
            "unresolved_categories": [],
        },
    }


def main() -> int:
    args = parse_args()
    state_dir = resolve_state_dir(args.codex_home, args.state_dir)
    context_path = state_dir / "user-context.md"

    if not context_path.exists():
        print(json.dumps(missing_payload(state_dir, context_path), indent=2))
        return 0

    size = context_path.stat().st_size
    if size > args.max_context_bytes:
        print(
            json.dumps(
                {
                    "plugin": "product-design",
                    "state_dir": str(state_dir),
                    "user_context": {
                        "path": str(context_path),
                        "exists": True,
                        "status": "too_large",
                        "size_bytes": size,
                        "max_context_bytes": args.max_context_bytes,
                        "entries": [],
                        "unresolved_categories": [],
                    },
                },
                indent=2,
            )
        )
        return 0

    markdown = context_path.read_text(encoding="utf-8")
    summary = summarize_user_context(markdown)
    print(
        json.dumps(
            {
                "plugin": "product-design",
                "state_dir": str(state_dir),
                "user_context": {
                    "path": str(context_path),
                    "exists": True,
                    "status": "present",
                    "sha256": sha256_text(markdown),
                    "modified_at": file_mtime(context_path),
                    **summary,
                },
            },
            indent=2,
        )
    )
    return 0


if __name__ == "__main__":
    sys.exit(main())
