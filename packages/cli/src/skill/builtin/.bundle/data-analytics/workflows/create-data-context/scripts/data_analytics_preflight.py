#!/usr/bin/env python3
"""Emit a stateless Data Analytics context envelope for compatibility.

This helper does not read or write local setup or hidden context state.
It intentionally does not read or write local setup or hidden context
state. Older tests and maintainer workflows may still call the script name, so
the payload makes the no-state contract explicit instead of failing or touching
local state files.
"""

from __future__ import annotations

import argparse
import json
import os
from pathlib import Path
from typing import Any

PLUGIN_ROOT = Path(__file__).resolve().parents[3]
SOURCE_CATEGORY_CONFIG_REFERENCE = (
    PLUGIN_ROOT / "skills/create-data-context/plugin-author-config/source-category-config.json"
)


def parse_args() -> argparse.Namespace:
    parser = argparse.ArgumentParser(
        description="Return a stateless Data Analytics context envelope as JSON."
    )
    parser.add_argument("--workflow", default="ordinary")
    parser.add_argument(
        "--request-mode",
        choices=("ordinary_workflow", "orientation", "direct_setup_status", "guided_setup_workflow"),
        default="ordinary_workflow",
    )
    parser.add_argument("--codex-home", type=Path, default=None)
    parser.add_argument("--state-dir", type=Path, default=None)
    parser.add_argument("--max-context-bytes", type=int, default=200_000)
    parser.add_argument("--section", action="append", default=[])
    return parser.parse_args()


def read_source_category_config() -> dict[str, Any]:
    try:
        return json.loads(SOURCE_CATEGORY_CONFIG_REFERENCE.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {
            "schema_version": "data_analytics_source_category_config.v1",
            "categories": {},
        }


def default_codex_home() -> Path:
    env_home = os.environ.get("CODEX_HOME")
    if env_home:
        return Path(env_home).expanduser()
    return Path.home() / ".codex"


def state_dir_from_args(args: argparse.Namespace) -> Path:
    if args.state_dir:
        return args.state_dir.expanduser()
    codex_home = args.codex_home.expanduser() if args.codex_home else default_codex_home()
    return codex_home / "state/plugins/data-analytics"


def read_plugin_install_suppressions(args: argparse.Namespace) -> dict[str, Any]:
    path = state_dir_from_args(args) / "plugin-install-suppressions.json"
    if not path.exists():
        return {"ids": [], "entries": [], "path": str(path), "status": "missing"}
    try:
        data = json.loads(path.read_text(encoding="utf-8"))
    except (OSError, json.JSONDecodeError):
        return {"ids": [], "entries": [], "path": str(path), "status": "unreadable"}
    raw_entries = data.get("suppressed_plugin_installs") if isinstance(data, dict) else []
    entries = raw_entries if isinstance(raw_entries, list) else []
    ids: list[str] = []
    normalized_entries: list[dict[str, Any]] = []
    for entry in entries:
        if isinstance(entry, str):
            plugin_id = entry
            normalized = {"plugin_id": plugin_id}
        elif isinstance(entry, dict):
            plugin_id = entry.get("plugin_id") or entry.get("tool_id") or entry.get("id")
            normalized = dict(entry)
            if plugin_id:
                normalized["plugin_id"] = plugin_id
        else:
            continue
        if isinstance(plugin_id, str) and plugin_id and plugin_id not in ids:
            ids.append(plugin_id)
            normalized_entries.append(normalized)
    return {"ids": ids, "entries": normalized_entries, "path": str(path), "status": "present"}


def build_payload(args: argparse.Namespace) -> dict[str, Any]:
    source_config = read_source_category_config()
    categories = source_config.get("categories", {})
    suppressed_plugin_installs = read_plugin_install_suppressions(args)
    return {
        "schema": "data_analytics_context.v2",
        "read_only": True,
        "stateless": True,
        "workflow": args.workflow,
        "request_mode": args.request_mode,
        "state_tracking": "disabled",
        "ignored_compat_args": {
            "codex_home": str(args.codex_home) if args.codex_home else None,
            "state_dir": str(args.state_dir) if args.state_dir else None,
            "max_context_bytes": args.max_context_bytes,
            "section": args.section,
        },
        "context": {
            "user_context": {
                "scope": "current_run_only",
                "state_tracking": "disabled",
                "source_routing_preferences": {},
                "semantic_layer_count": 0,
                "normalization_complete": True,
            },
            "source_preferences": {},
            "source_category_config": {
                "schema_version": source_config.get("schema_version"),
                "categories": categories,
            },
            "semantic_layers": [],
            "connector_confirmation": {},
            "connector_setup_summary": {
                "status": "not_tracked",
                "action_required": False,
                "has_setup_gaps": False,
                "ready": [],
                "active": [],
                "needs_attention": [],
                "needs_choice": [],
                "fallback_or_closed": [],
                "not_set_up": [],
                "plugin_setup_opportunities": [],
                "unresolved_core_ids": [],
                "core_complete": False,
                "next_action": None,
                "user_facing_guidance": (
                    "Data Analytics does not track local connector setup state. "
                    "Resolve sources in the active workflow."
                ),
            },
            "suppressed_plugin_installs": suppressed_plugin_installs,
            "hero_prompt_candidates": [],
            "primary_hero_prompt": None,
            "extra_hero_prompt_candidates": [],
        },
        "control": {
            "response_mode": args.request_mode,
            "final_obligations": [],
            "conditional_guidance": [],
            "setup_progress": {
                "status": "not_tracked",
                "core_setup": {
                    "complete": False,
                    "remaining_step_ids": [],
                    "next_action": None,
                },
                "task_list": [],
            },
        },
    }


def main() -> int:
    args = parse_args()
    print(json.dumps(build_payload(args), indent=2, sort_keys=True))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
