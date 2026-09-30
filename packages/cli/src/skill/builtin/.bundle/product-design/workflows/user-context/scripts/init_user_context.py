#!/usr/bin/env python3
"""Create the local Product Design context file."""

from __future__ import annotations

import argparse
import os
import sys
from pathlib import Path

SKILL_ROOT = Path(__file__).resolve().parents[1]
TEMPLATE_PATH = SKILL_ROOT / "plugin-author-config/user-context-template.md"
PLUGIN_STATE_DIR = Path("state/plugins/product-design")

CONTEXT_NOTE = """<!--
Product Design context. This file is user-editable.
Unresolved `status: not provided` entries are setup prompts, not saved facts.
Saved references should include Date Added, Useful Context, and Future Use when available.
-->

"""


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description=(
            "Create $CODEX_HOME/state/plugins/product-design/user-context.md "
            "from the bundled Product Design template."
        )
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
        "--overwrite",
        action="store_true",
        help="Overwrite an existing user-context.md file.",
    )
    return parser.parse_args()


def resolve_state_dir(codex_home: Path | None, state_dir: Path | None) -> Path:
    if state_dir is not None:
        return state_dir.expanduser().resolve()
    home = codex_home or Path(os.environ.get("CODEX_HOME", "~/.codex"))
    return (home.expanduser() / PLUGIN_STATE_DIR).resolve()


def main() -> int:
    args = parse_args()
    state_dir = resolve_state_dir(args.codex_home, args.state_dir)
    context_path = state_dir / "user-context.md"

    if not TEMPLATE_PATH.exists():
        print("Missing Product Design context template.", file=sys.stderr)
        print(f"- {TEMPLATE_PATH.relative_to(SKILL_ROOT)}", file=sys.stderr)
        return 1

    state_dir.mkdir(parents=True, exist_ok=True)
    (state_dir / "assets").mkdir(parents=True, exist_ok=True)

    existed = context_path.exists()
    if existed and not args.overwrite:
        result = "preserved"
    else:
        context_path.write_text(
            CONTEXT_NOTE + TEMPLATE_PATH.read_text(encoding="utf-8"), encoding="utf-8"
        )
        result = "overwritten" if existed else "created"

    print(f"Product Design state directory: {state_dir}")
    print(f"user-context.md: {result}")
    return 0


if __name__ == "__main__":
    sys.exit(main())
