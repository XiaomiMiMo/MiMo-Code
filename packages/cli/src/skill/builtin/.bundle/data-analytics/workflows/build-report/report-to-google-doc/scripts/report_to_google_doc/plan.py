from __future__ import annotations

import json
from pathlib import Path
from typing import Any

from .constants import DEFAULT_RENDER_WORKERS, DOC_CONTENT_WIDTH_PT
from .docx_writer import write_docx
from .html_parser import parse_html
from .quality import build_preflight_checks
from .rendering import render_chart_images


def build_docx_upload_plan(
    manifest: dict[str, Any],
    docx_path: Path,
    preflight: dict[str, Any],
) -> dict[str, Any]:
    return {
        "title": manifest["title"],
        "source_html": manifest["source_html"],
        "docx_file": str(docx_path),
        "preflight_status": preflight["status"],
        "doc_content_width_pt": DOC_CONTENT_WIDTH_PT,
        "sequence": [
            {
                "tool": "mcp__codex_apps__google_drive._upload_file",
                "file_uri": str(docx_path),
                "file_name": docx_path.name,
                "mime_type": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
            }
        ],
        "expected_drive_result": (
            "A Drive-hosted DOCX file is acceptable. The file does not need to be "
            "converted to the native Google Docs MIME type."
        ),
        "verification": [
            "fetch or open the uploaded Drive file and confirm it is readable",
            "compare extracted text against manifest.json headings, lists, source notes, and links",
            "inspect local report.docx structure for expected headings, tables, lists, and image relationships",
            "compare generated chart_images/*.png against the HTML report visuals when visual fidelity matters",
        ],
    }


def write_json(path: Path, obj: Any) -> None:
    path.write_text(json.dumps(obj, indent=2, ensure_ascii=False) + "\n", encoding="utf-8")


def write_docx_upload_readme(
    html: Path,
    manifest: dict[str, Any],
    preflight: dict[str, Any],
    docx_path: Path,
) -> str:
    return f"""# Report-to-Google-Doc DOCX Upload Plan

Source: `{html}`

Local DOCX: `{docx_path}`

Inventory:
- headings: {manifest["counts"]["headings"]}
- native tables/cards: {manifest["counts"]["tables"]}
- chart images: {manifest["counts"].get("chart_images", 0)}
- source two-column blocks: {manifest["counts"].get("two_col_source_blocks", 0)}
- rendered two-column blocks: {manifest["counts"].get("two_col_image_blocks", 0)}
- inline style spans: {manifest["counts"]["inline_styles"]}
- lists: {manifest["counts"]["lists"]}
- preflight: {preflight["status"]} ({preflight["summary"]["errors"]} errors,
  {preflight["summary"]["warnings"]} warnings)

Expected connector sequence:

1. Inspect `preflight_checks.json`. Do not upload until preflight passes.
2. Upload `{docx_path}` with `mcp__codex_apps__google_drive._upload_file`.
3. Treat the Drive-hosted DOCX as the deliverable; it does not need native
   Google Docs MIME conversion.
4. Fetch/open the uploaded file and compare it against `manifest.json` and the
   source HTML report.

This helper intentionally writes only DOCX-upload artifacts. It does not write
Google Docs batch-update request files such as `seed_requests.json`,
`table_requests.json`, `content_replacement_requests_template.json`,
`chart_image_requests_template.json`, `remote_write_plan.json`, or
`all_requests*.json`.
"""


def write_outputs(
    html: Path,
    out_dir: Path,
    chart_mode: str = "image",
    render_workers: int = DEFAULT_RENDER_WORKERS,
    strict_preflight: bool = True,
) -> None:
    out_dir.mkdir(parents=True, exist_ok=True)
    manifest = parse_html(html, chart_mode=chart_mode)
    if manifest.get("chart_images"):
        render_chart_images(manifest, out_dir, render_workers=render_workers)
    preflight = build_preflight_checks(
        manifest,
        out_dir,
    )

    (out_dir / "skeleton.txt").write_text(manifest["skeleton_text"], encoding="utf-8")
    write_json(out_dir / "manifest.json", manifest)
    write_json(out_dir / "preflight_checks.json", preflight)
    write_json(out_dir / "placeholder_queries.json", manifest["placeholders"])

    docx_path = write_docx(manifest, out_dir)
    docx_upload_plan = build_docx_upload_plan(
        manifest,
        docx_path,
        preflight,
    )
    write_json(out_dir / "docx_upload_plan.json", docx_upload_plan)
    readme = write_docx_upload_readme(
        html,
        manifest,
        preflight,
        docx_path,
    )
    (out_dir / "README.md").write_text(readme, encoding="utf-8")
    if strict_preflight and preflight["status"] != "passed":
        raise SystemExit(
            f"Preflight failed with {preflight['summary']['errors']} error(s). "
            f"Inspect {out_dir / 'preflight_checks.json'}."
        )
