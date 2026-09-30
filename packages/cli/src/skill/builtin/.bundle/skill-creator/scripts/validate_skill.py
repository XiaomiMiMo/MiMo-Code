#!/usr/bin/env python3
"""Validate an agent skill folder against the skill spec.

Usage: python validate_skill.py /path/to/skill-folder

Exit code 0 = PASS (warnings allowed), 1 = FAIL (errors found), 2 = usage error.
"""

import os
import re
import sys

KEBAB_RE = re.compile(r"^[a-z0-9]+(-[a-z0-9]+)*$")
RESERVED = ("claude", "anthropic")
MAX_DESCRIPTION = 1024
MAX_BODY_WORDS = 5000

errors = []
warnings = []


def error(msg):
    errors.append(msg)


def warn(msg):
    warnings.append(msg)


def parse_frontmatter(text):
    """Minimal YAML frontmatter parser: returns (fields, body) or (None, text)."""
    if not text.startswith("---"):
        return None, text
    match = re.match(r"^---\s*\n(.*?)\n---\s*\n?", text, re.DOTALL)
    if not match:
        return None, text
    fields = {}
    current_key = None
    for line in match.group(1).splitlines():
        if not line.strip() or line.lstrip().startswith("#"):
            continue
        if line.startswith((" ", "\t")):
            if current_key:
                fields[current_key] += " " + line.strip()
            continue
        if ":" not in line:
            warn(f"frontmatter line has no key: {line!r}")
            continue
        key, _, value = line.partition(":")
        current_key = key.strip()
        fields[current_key] = value.strip().strip("\"'")
    return fields, text[match.end():]


def main():
    if len(sys.argv) != 2:
        print(__doc__.strip())
        return 2
    skill_dir = os.path.abspath(sys.argv[1])
    if not os.path.isdir(skill_dir):
        print(f"ERROR: not a directory: {skill_dir}")
        return 2

    folder = os.path.basename(skill_dir)
    entries = os.listdir(skill_dir)

    if not KEBAB_RE.match(folder):
        error(f"folder name {folder!r} is not kebab-case (lowercase, digits, hyphens only)")

    # exact-case check works even on case-insensitive filesystems via listdir
    if "SKILL.md" not in entries:
        near = [e for e in entries if e.lower() == "skill.md"]
        if near:
            error(f"found {near[0]!r} — must be named exactly 'SKILL.md' (case-sensitive)")
        else:
            error("SKILL.md is missing")
        report()
        return 1

    if any(e.lower() == "readme.md" for e in entries):
        error("README.md must not be inside the skill folder (put docs in SKILL.md or references/)")

    with open(os.path.join(skill_dir, "SKILL.md"), encoding="utf-8") as f:
        text = f.read()

    fields, body = parse_frontmatter(text)
    if fields is None:
        error("frontmatter missing or malformed: SKILL.md must start with '---' delimited YAML")
        report()
        return 1

    fm_block = text.split("---")[1] if text.count("---") >= 2 else ""
    if "<" in fm_block or ">" in fm_block:
        error("frontmatter contains XML angle brackets (< >) — forbidden for security")

    name = fields.get("name", "")
    if not name:
        error("frontmatter is missing required field 'name'")
    else:
        if not KEBAB_RE.match(name):
            error(f"name {name!r} is not kebab-case")
        if name != folder:
            warn(f"name {name!r} does not match folder name {folder!r}")
        if any(word in name.lower() for word in RESERVED):
            error(f"name {name!r} uses a reserved word ({'/'.join(RESERVED)})")

    description = fields.get("description", "")
    if not description:
        error("frontmatter is missing required field 'description'")
    else:
        if len(description) > MAX_DESCRIPTION:
            error(f"description is {len(description)} chars (max {MAX_DESCRIPTION})")
        lowered = description.lower()
        if len(description) < 40:
            warn(f"description is very short ({len(description)} chars) — likely too vague to trigger")
        if not any(cue in lowered for cue in ("use when", "use this", "use for", "trigger", "use it when")):
            warn("description has no obvious WHEN clause (e.g. 'Use when ...') — add trigger conditions")

    compat = fields.get("compatibility", "")
    if compat and not (1 <= len(compat) <= 500):
        error(f"compatibility must be 1-500 chars (got {len(compat)})")

    word_count = len(body.split())
    if word_count > MAX_BODY_WORDS:
        warn(f"SKILL.md body is {word_count} words (recommended max {MAX_BODY_WORDS}) — move detail to references/")

    for match in re.finditer(r"(?:scripts|references|assets)/[\w./-]*\w", body):
        rel = match.group(0)
        if not os.path.exists(os.path.join(skill_dir, rel)):
            warn(f"SKILL.md references {rel!r} but it does not exist in the skill folder")

    report()
    return 1 if errors else 0


def report():
    for msg in errors:
        print(f"ERROR: {msg}")
    for msg in warnings:
        print(f"WARNING: {msg}")
    verdict = "FAIL" if errors else "PASS"
    print(f"{verdict}: {len(errors)} error(s), {len(warnings)} warning(s)")


if __name__ == "__main__":
    sys.exit(main())
