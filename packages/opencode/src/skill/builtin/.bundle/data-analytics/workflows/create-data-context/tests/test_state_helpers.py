#!/usr/bin/env python3
"""Tests for the Data Analytics stateless compatibility helpers."""

from __future__ import annotations

import json
import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


PLUGIN_ROOT = Path(__file__).resolve().parents[3]
DATA_CONTEXT_ROOT = PLUGIN_ROOT / "skills/create-data-context"
PREFLIGHT_SCRIPT = DATA_CONTEXT_ROOT / "scripts/data_analytics_preflight.py"
SUPPRESSION_SCRIPT = DATA_CONTEXT_ROOT / "scripts/record_plugin_install_suppression.py"


class DataAnalyticsStateHelperTests(unittest.TestCase):
    def run_preflight(self, *args: str) -> dict:
        proc = subprocess.run(
            [sys.executable, str(PREFLIGHT_SCRIPT), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(proc.stdout)

    def run_suppression(self, *args: str) -> dict:
        proc = subprocess.run(
            [sys.executable, str(SUPPRESSION_SCRIPT), *args],
            check=True,
            capture_output=True,
            text=True,
        )
        return json.loads(proc.stdout)

    def test_preflight_is_stateless_and_has_no_setup_obligation(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            payload = self.run_preflight("--codex-home", tmp)

        self.assertEqual(payload["schema"], "data_analytics_context.v2")
        self.assertTrue(payload["read_only"])
        self.assertTrue(payload["stateless"])
        self.assertEqual(payload["state_tracking"], "disabled")
        self.assertNotIn("state", payload)
        self.assertNotIn("files", payload)

        context = payload["context"]
        self.assertEqual(context["user_context"]["scope"], "current_run_only")
        self.assertEqual(context["user_context"]["state_tracking"], "disabled")
        self.assertEqual(context["source_preferences"], {})
        self.assertEqual(context["connector_confirmation"], {})
        self.assertEqual(context["semantic_layers"], [])

        summary = context["connector_setup_summary"]
        self.assertFalse(summary["action_required"])
        self.assertFalse(summary["has_setup_gaps"])
        self.assertEqual(summary["plugin_setup_opportunities"], [])
        self.assertEqual(payload["control"]["final_obligations"], [])
        self.assertEqual(payload["control"]["setup_progress"]["task_list"], [])

        suppressions = context["suppressed_plugin_installs"]
        self.assertEqual(suppressions["ids"], [])
        self.assertEqual(suppressions["entries"], [])
        self.assertEqual(suppressions["status"], "missing")
        self.assertTrue(suppressions["path"].endswith("plugin-install-suppressions.json"))

    def test_request_modes_do_not_create_setup_or_user_context_state(self) -> None:
        modes = (
            "ordinary_workflow",
            "orientation",
            "direct_setup_status",
            "guided_setup_workflow",
        )
        for mode in modes:
            with self.subTest(mode=mode), tempfile.TemporaryDirectory() as tmp:
                payload = self.run_preflight("--codex-home", tmp, "--request-mode", mode)
                state_dir = Path(tmp) / "state/plugins/data-analytics"

                self.assertEqual(payload["request_mode"], mode)
                self.assertEqual(payload["control"]["response_mode"], mode)
                self.assertEqual(payload["control"]["final_obligations"], [])
                self.assertFalse((state_dir / "user-context.md").exists())
                self.assertFalse((state_dir / "onboarding-state.json").exists())

    def test_suppression_helper_records_and_preflight_surfaces_exact_plugin_id(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            result = self.run_suppression(
                "--state-dir",
                str(state_dir),
                "--plugin-id",
                "salesforce@openai-curated-remote",
                "--tool-type",
                "plugin",
            )
            payload = self.run_preflight("--state-dir", str(state_dir))

        self.assertTrue(result["suppressed"])
        self.assertEqual(result["plugin_id"], "salesforce@openai-curated-remote")
        suppressions = payload["context"]["suppressed_plugin_installs"]
        self.assertEqual(suppressions["status"], "present")
        self.assertEqual(suppressions["ids"], ["salesforce@openai-curated-remote"])
        self.assertEqual(
            suppressions["entries"][0]["reason"],
            "user_dismissed_request_plugin_install",
        )
        self.assertEqual(suppressions["entries"][0]["source"], "request_plugin_install")

    def test_suppression_helper_replaces_duplicate_plugin_ids(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            self.run_suppression(
                "--state-dir",
                str(state_dir),
                "--plugin-id",
                "bigquery@openai-curated-remote",
                "--reason",
                "first",
            )
            self.run_suppression(
                "--state-dir",
                str(state_dir),
                "--plugin-id",
                "bigquery@openai-curated-remote",
                "--reason",
                "second",
            )
            data = json.loads((state_dir / "plugin-install-suppressions.json").read_text())

        entries = data["suppressed_plugin_installs"]
        self.assertEqual(len(entries), 1)
        self.assertEqual(entries[0]["plugin_id"], "bigquery@openai-curated-remote")
        self.assertEqual(entries[0]["reason"], "second")

    def test_preflight_tolerates_invalid_suppression_file(self) -> None:
        with tempfile.TemporaryDirectory() as tmp:
            state_dir = Path(tmp) / "state"
            state_dir.mkdir()
            (state_dir / "plugin-install-suppressions.json").write_text("{not json", encoding="utf-8")
            payload = self.run_preflight("--state-dir", str(state_dir))

        suppressions = payload["context"]["suppressed_plugin_installs"]
        self.assertEqual(suppressions["status"], "unreadable")
        self.assertEqual(suppressions["ids"], [])
        self.assertEqual(suppressions["entries"], [])

    def test_source_category_config_is_exposed_without_readiness_claims(self) -> None:
        payload = self.run_preflight()
        config = payload["context"]["source_category_config"]

        self.assertEqual(config["schema_version"], "data_analytics_source_category_config.v1")
        self.assertIn("structured_data", config["categories"])
        self.assertIn("company_docs", config["categories"])
        self.assertEqual(payload["context"]["connector_confirmation"], {})
        self.assertEqual(payload["context"]["connector_setup_summary"]["ready"], [])
        self.assertEqual(payload["context"]["connector_setup_summary"]["active"], [])

    def test_source_category_config_documents_preferred_plugins_as_hints(self) -> None:
        config_text = (
            DATA_CONTEXT_ROOT / "plugin-author-config/source-category-config.json"
        ).read_text(encoding="utf-8")

        self.assertIn("preferred_plugins values are routing hints and examples", config_text)
        self.assertIn("not an exhaustive source list", config_text)

    def test_deleted_stateful_helpers_are_absent(self) -> None:
        self.assertFalse((DATA_CONTEXT_ROOT / "scripts/init_user_context_state.py").exists())
        self.assertFalse((DATA_CONTEXT_ROOT / "scripts/reset_user_context_state.py").exists())
        self.assertFalse((DATA_CONTEXT_ROOT / "references/onboarding-state-template.json").exists())
        self.assertFalse((PLUGIN_ROOT / "skills/onboarding").exists())
        self.assertFalse((PLUGIN_ROOT / "skills/user-context").exists())
        self.assertFalse((DATA_CONTEXT_ROOT / "references/onboarding.md").exists())
        self.assertFalse((DATA_CONTEXT_ROOT / "references/onboarding-examples.md").exists())

    def test_contract_text_keeps_setup_optional(self) -> None:
        index_text = (PLUGIN_ROOT / "skills/index/SKILL.md").read_text(encoding="utf-8")
        data_context_text = (DATA_CONTEXT_ROOT / "SKILL.md").read_text(encoding="utf-8")

        self.assertIn(
            "Ordinary analytics workflows do not require saved data-context setup.",
            index_text,
        )
        self.assertIn("route to `create-data-context`", index_text)
        self.assertIn("This index owns task selection, setup-adjacent routing, and guided workflow continuation.", index_text)
        self.assertIn("name: create-data-context", data_context_text)
        self.assertIn(
            "Use this skill only when the user asks to save data context or create, update, inspect, or repair a semantic layer.",
            data_context_text,
        )
        self.assertNotIn("Route to data task", data_context_text)
        self.assertNotIn("What should Data Analytics set up?", data_context_text)

    def test_focused_skills_do_not_restore_preflight_or_repeated_context(self) -> None:
        current_session_contract = (
            "Work only from sources, files, and instructions available in the current "
            "conversation or runtime. Do not read or write plugin-scoped persistent "
            "state or claim future recall. If a required source or preference is "
            "absent, ask for it or use a clearly labeled current-session fallback."
        )
        old_preflight_markers = (
            "Mandatory pre-answer gate: Invoke `data-analytics:user-context`",
            "Use the returned `data_analytics_preflight` envelope as the source of truth",
        )
        focused_skill_count = 0

        for skill_path in (PLUGIN_ROOT / "skills").rglob("SKILL.md"):
            text = skill_path.read_text(encoding="utf-8")
            rel = skill_path.relative_to(PLUGIN_ROOT / "skills")
            for marker in old_preflight_markers:
                self.assertNotIn(marker, text, str(rel))

            if rel.parts[0] in {"index", "create-data-context"}:
                continue
            focused_skill_count += 1
            self.assertNotIn("### Current-Session Context", text, str(rel))
            self.assertNotIn(current_session_contract, text, str(rel))

        self.assertGreaterEqual(focused_skill_count, 10)

    def test_connector_playbook_treats_authenticated_cli_as_valid_existing_access(self) -> None:
        connector_playbook_text = (
            DATA_CONTEXT_ROOT / "references/semantic-layer/connector-playbook.md"
        ).read_text(encoding="utf-8")

        self.assertIn("already-authenticated read-only CLI", connector_playbook_text)
        self.assertIn("when the user names it or it is already callable", connector_playbook_text)
        self.assertIn("Treat pasted CLI output as manual evidence.", connector_playbook_text)
        self.assertIn(
            "Do not recommend installing or configuring a local CLI as the best path",
            connector_playbook_text,
        )


if __name__ == "__main__":
    unittest.main()
