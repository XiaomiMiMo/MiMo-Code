#!/usr/bin/env python3
"""Validate the Data Analytics semantic-layer setup contract."""

from __future__ import annotations

import argparse
import sys
from pathlib import Path


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser()
    parser.add_argument("plugin_path", type=Path)
    parser.add_argument("--plugin-id", default="data-analytics")
    return parser.parse_args()


def require_contains(failures: list[str], path: Path, phrase: str, root: Path) -> None:
    try:
        text = path.read_text(encoding="utf-8")
    except OSError as exc:
        failures.append(f"Could not read {path.relative_to(root)}: {exc}")
        return
    if phrase not in text:
        failures.append(f"{path.relative_to(root)} missing required phrase: {phrase}")


def require_absent(failures: list[str], path: Path, root: Path) -> None:
    if path.exists():
        failures.append(f"Removed path should not exist: {path.relative_to(root)}")


def main() -> int:
    args = parse_args()
    plugin_root = args.plugin_path.resolve()
    skills_root = plugin_root / "skills"
    failures: list[str] = []

    required_paths = (
        skills_root / "index/SKILL.md",
        skills_root / "create-data-context/SKILL.md",
        skills_root / "create-data-context/scripts/data_analytics_preflight.py",
        skills_root / "create-data-context/scripts/record_plugin_install_suppression.py",
        skills_root / "create-data-context/tests/test_state_helpers.py",
        skills_root / "create-data-context/plugin-author-config/source-category-config.json",
        skills_root / "create-data-context/references/semantic-layer/source-intake.md",
        skills_root / "create-data-context/references/semantic-layer/connector-playbook.md",
        skills_root / "create-data-context/references/semantic-layer/skill-template.md",
    )
    for path in required_paths:
        if not path.exists():
            failures.append(f"Missing required path: {path.relative_to(plugin_root)}")

    for path in (
        skills_root / "onboarding",
        skills_root / "user-context",
        skills_root / "create-data-context/plugin-author-config/data-context-config.md",
        skills_root / "create-data-context/references/onboarding.md",
        skills_root / "create-data-context/references/onboarding-examples.md",
        skills_root / "onboarding/references/onboarding-state-template.json",
        skills_root / "create-data-context/references/onboarding-state-template.json",
        skills_root / "create-data-context/scripts/init_user_context_state.py",
        skills_root / "create-data-context/scripts/reset_user_context_state.py",
    ):
        require_absent(failures, path, plugin_root)

    phrase_checks = (
        (
            skills_root / "index/SKILL.md",
            "Ordinary analytics workflows do not require saved data-context setup.",
        ),
        (
            skills_root / "index/SKILL.md",
            "This index owns task selection, setup-adjacent routing, and guided workflow continuation.",
        ),
        (
            skills_root / "index/SKILL.md",
            "Any path that determines there is no usable data for the active task MUST offer `Upload data` and `Use sample data` before the turn ends.",
        ),
        (
            skills_root / "create-data-context/SKILL.md",
            "Use this skill only when the user asks to save data context or create, update, inspect, or repair a semantic layer.",
        ),
        (
            skills_root / "create-data-context/scripts/data_analytics_preflight.py",
            "does not read or write local setup or hidden context state",
        ),
        (
            skills_root / "create-data-context/scripts/data_analytics_preflight.py",
            '"stateless": True',
        ),
        (
            skills_root / "create-data-context/scripts/data_analytics_preflight.py",
            "suppressed_plugin_installs",
        ),
        (
            skills_root / "create-data-context/scripts/record_plugin_install_suppression.py",
            "plugin-install-suppressions.json",
        ),
    )
    for path, phrase in phrase_checks:
        if path.exists():
            require_contains(failures, path, phrase, plugin_root)

    for skill_file in skills_root.rglob("SKILL.md"):
        text = skill_file.read_text(encoding="utf-8")
        rel = skill_file.relative_to(plugin_root)
        if "Mandatory pre-answer gate: Invoke `data-analytics:user-context`" in text:
            failures.append(f"{rel} still requires user-context preflight")
        if "Use the returned `data_analytics_preflight` envelope as the source of truth" in text:
            failures.append(f"{rel} still treats preflight as source of truth")

    for skill_file in (
        skills_root / "index/SKILL.md",
        skills_root / "create-data-context/SKILL.md",
    ):
        text = skill_file.read_text(encoding="utf-8")
        rel = skill_file.relative_to(plugin_root)
        if "../onboarding/" in text:
            failures.append(f"{rel} still links to removed onboarding skill")
        if "data-analytics:onboarding" in text:
            failures.append(f"{rel} still routes to removed onboarding skill")

    forbidden_refs = (
        "state/plugins/data-analytics/user-context.md",
        "state/plugins/data-analytics/onboarding-state.json",
        "init_user_context_state.py",
        "reset_user_context_state.py",
        "onboarding-state-template.json",
    )
    for path in (
        skills_root / "create-data-context/plugin-author-config/source-category-config.json",
        skills_root / "create-data-context/references/automation.md",
    ):
        if not path.exists():
            continue
        text = path.read_text(encoding="utf-8")
        for phrase in forbidden_refs:
            if phrase in text:
                failures.append(f"{path.relative_to(plugin_root)} still references {phrase}")

    if failures:
        for failure in failures:
            print(f"ERROR: {failure}", file=sys.stderr)
        return 1

    print("Validated Data Analytics guided-flow/create-data-context semantic-layer contract.")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
