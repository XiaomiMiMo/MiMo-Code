#!/usr/bin/env python3
"""Version-controlled companion for local memory/history semantic indexes.

The process writes immutable generations and atomically switches a current pointer.
Incremental refresh re-embeds changed chunks and drops deleted/empty sources.

Set SEMINDEX_MODEL to the exact already-resident embedding model before build,
update, search, or dedup; this tool never selects or downloads a model. Vector
dimension is learned from its embedding response and pinned in each generation.
SEMINDEX_DOCUMENT_TEMPLATE and SEMINDEX_QUERY_PREFIX configure matching model
input framing and are recorded in the generation fingerprint.
"""

from __future__ import annotations

import argparse
from contextlib import contextmanager
try:
    import fcntl
except ImportError:
    fcntl = None
import hashlib
import json
import os
import re
import sqlite3
import sys
import time
import uuid
import urllib.error
import urllib.request
from pathlib import Path

import numpy as np

OLLAMA = os.environ.get("SEMINDEX_OLLAMA", "http://localhost:11434")
MODEL = os.environ.get("SEMINDEX_MODEL")
ROOT = Path(os.environ.get("SEMINDEX_HOME", Path.home() / ".local/share/semindex"))
DB = Path(os.environ.get("SEMINDEX_DB", Path.home() / ".local/share/mimocode/mimocode.db"))
MEMORY_DIR = Path(os.environ.get("SEMINDEX_MEMORY_DIR", Path.home() / ".local/share/mimocode/memory"))
DOCUMENT_TEMPLATE = os.environ.get("SEMINDEX_DOCUMENT_TEMPLATE", "{title} | {text}")
QUERY_PREFIX = os.environ.get("SEMINDEX_QUERY_PREFIX", "")
CHUNK_CHARS = 1200
CHUNK_OVERLAP = 150
MIN_CHUNK = 80
TRAJ_KINDS = ("user_text", "assistant_text", "summary_text", "compaction")
MAX_TRAJ_ROWS = 200_000
MAX_TRAJ_BODY_BYTES = 256 * 1024 * 1024
MAX_TRAJ_CHUNKS = 250_000


# ── embeddings ───────────────────────────────────────────────────────────────


def embed(texts: list[str], batch: int = 64) -> np.ndarray:
    """Embed in batches, L2-normalised, so cosine is a plain dot product."""
    out: list[list[float]] = []
    for start in range(0, len(texts), batch):
        window = texts[start : start + batch]
        payload = json.dumps({"model": MODEL, "input": window}).encode()
        request = urllib.request.Request(
            f"{OLLAMA}/api/embed", data=payload, headers={"Content-Type": "application/json"}
        )
        for attempt in range(3):
            try:
                body = json.loads(urllib.request.urlopen(request, timeout=600).read())
                out.extend(body["embeddings"])
                break
            except (urllib.error.URLError, TimeoutError, KeyError) as error:
                if attempt == 2:
                    raise SystemExit(f"embedding failed at batch {start}: {error}")
                time.sleep(2 * (attempt + 1))
    vectors = np.asarray(out, dtype=np.float32)
    if vectors.ndim != 2 or vectors.shape[0] != len(texts) or not np.isfinite(vectors).all():
        raise ValueError("embedding response shape or values invalid")
    if len(vectors) and (vectors.shape[1] < 1 or np.any(np.linalg.norm(vectors, axis=1) <= 0)):
        raise ValueError("embedding response dimension or norm invalid")
    norms = np.linalg.norm(vectors, axis=1, keepdims=True)
    return vectors / np.clip(norms, 1e-9, None)


def embed_one(text: str) -> np.ndarray:
    return embed([QUERY_PREFIX + text])[0]


# ── chunking ─────────────────────────────────────────────────────────────────


def chunk(text: str) -> list[str]:
    """Split on paragraph boundaries, then hard-wrap anything still too long."""
    text = re.sub(r"\n{3,}", "\n\n", text.strip())
    if not text:
        return []
    parts: list[str] = []
    buffer = ""
    for block in text.split("\n\n"):
        if len(buffer) + len(block) + 2 <= CHUNK_CHARS:
            buffer = f"{buffer}\n\n{block}" if buffer else block
            continue
        if buffer:
            parts.append(buffer)
        if len(block) <= CHUNK_CHARS:
            buffer = block
            continue
        start = 0
        while start < len(block):
            parts.append(block[start : start + CHUNK_CHARS])
            start += CHUNK_CHARS - CHUNK_OVERLAP
        buffer = ""
    if buffer:
        parts.append(buffer)
    return [p for p in parts if len(p) >= MIN_CHUNK]


def title_of(meta: dict) -> str:
    for key in ("title", "path", "heading", "kind"):
        value = meta.get(key)
        if value:
            return str(value)[:160]
    return "untitled"


# ── sources ──────────────────────────────────────────────────────────────────
# Every collector yields (text, meta) where meta carries a stable `source` id and
# a `sig` signature. `update` keeps chunks whose sig is unchanged.


def docs_traj(since_ms: int | None, limit: int | None):
    """Session history, minus raw tool output (64% of the table and noise)."""
    connection = sqlite3.connect(f"file:{DB}?mode=ro", uri=True)
    try:
        connection.execute("begin")
        sql = (
            "select part_id, session_id, message_id, kind, time_created, body "
            "from history_fts where kind in (?,?,?,?) and length(body) >= 200"
        )
        params: list = list(TRAJ_KINDS)
        if since_ms:
            sql += " and time_created >= ?"
            params.append(since_ms)
        sql += " order by time_created"
        if limit:
            sql = f"select * from ({sql} desc limit {int(limit)}) order by time_created"
        else:
            sql += " limit ?"
            params.append(MAX_TRAJ_ROWS + 1)
        rows = connection.execute(sql, params).fetchall()
        if limit is None and len(rows) > MAX_TRAJ_ROWS:
            raise ValueError("trajectory reconciliation row bound exceeded")
        total_body_bytes = sum(len(row[5].encode("utf-8")) for row in rows)
        if total_body_bytes > MAX_TRAJ_BODY_BYTES:
            raise ValueError("trajectory reconciliation byte bound exceeded")
        source_rows = connection.execute(
            "select distinct part_id from history_fts where kind in (?,?,?,?) limit ?",
            (*TRAJ_KINDS, MAX_TRAJ_ROWS + 1),
        ).fetchall()
        if len(source_rows) > MAX_TRAJ_ROWS:
            raise ValueError("trajectory source reconciliation bound exceeded")
        sources = {row[0]: "present" for row in source_rows}
    finally:
        connection.close()

    out: list[tuple[str, dict]] = []
    for part_id, session_id, message_id, kind, created, body in rows:
        digest = hashlib.sha1(body.encode()).hexdigest()[:16]
        for index, piece in enumerate(chunk(body)):
            if len(out) >= MAX_TRAJ_CHUNKS:
                raise ValueError("trajectory chunk reconciliation bound exceeded")
            out.append(
                (
                    piece,
                    {
                        "title": f"{kind} · {body[:70].replace(chr(10), ' ')}",
                        "source": part_id,
                        "sig": hashlib.sha1(piece.encode()).hexdigest()[:12],
                        "session_id": session_id,
                        "part_id": part_id,
                        "message_id": message_id,
                        "kind": kind,
                        "time": created,
                        "ordinal": index,
                    },
                )
            )
    return out, sources


def docs_memory(limit: int | None, known: dict[str, str] | None = None):
    known = known or {}
    files: list[Path] = []
    def scan_error(error: OSError) -> None:
        raise error
    for directory, _, names in os.walk(MEMORY_DIR, onerror=scan_error):
        files.extend(Path(directory) / name for name in names if name.endswith(".md"))
    files.sort()
    if limit:
        files = files[-limit:]
    out: list[tuple[str, dict]] = []
    seen: dict[str, str] = {}
    for path in files:
        try:
            text = path.read_text(encoding="utf-8", errors="replace")
        except OSError:
            # A failed read is not deletion. Fail the update and keep the last generation.
            raise
        sig = hashlib.sha256(text.encode("utf-8")).hexdigest()
        seen[str(path)] = sig
        if known.get(str(path)) == sig:
            continue
        heading = ""
        for line in text.splitlines():
            if line.startswith("#"):
                heading = line.lstrip("# ").strip()
                break
        for index, piece in enumerate(chunk(text)):
            out.append(
                (
                    piece,
                    {
                        "title": heading or path.name,
                        "path": str(path),
                        "source": str(path),
                        "sig": hashlib.sha1(piece.encode()).hexdigest()[:12],
                        "kind": "memory",
                        "ordinal": index,
                    },
                )
            )
    return out, seen


COLLECTORS = {"traj": docs_traj, "memory": docs_memory}
def collect(
    corpus: str,
    since_ms: int | None = None,
    limit: int | None = None,
    known: dict[str, str] | None = None,
):
    if corpus == "traj":
        return docs_traj(since_ms, limit)
    return COLLECTORS[corpus](limit, known)


# ── storage ──────────────────────────────────────────────────────────────────


def paths(corpus: str) -> tuple[Path, Path, Path]:
    ROOT.mkdir(parents=True, exist_ok=True)
    pointer = ROOT / f"{corpus}.current"
    if pointer.exists():
        generation = pointer.read_text().strip()
        if not re.fullmatch(r"[a-f0-9]{32}", generation):
            raise ValueError("invalid current generation pointer")
        base = ROOT / "generations" / corpus / generation
        return base / f"{corpus}.npy", base / f"{corpus}.json", base / f"{corpus}.manifest.json"
    return (
        ROOT / f"{corpus}.npy",
        ROOT / f"{corpus}.json",
        ROOT / f"{corpus}.manifest.json",
    )


def load(corpus: str, pinned: tuple[Path, Path, Path] | None = None) -> tuple[np.ndarray, list[dict]]:
    vector_path, meta_path, manifest_path = pinned if pinned else paths(corpus)
    if not vector_path.exists():
        raise SystemExit(f"no index for {corpus}; run: semindex build {corpus}")
    vectors, meta = np.load(vector_path, allow_pickle=False), json.loads(meta_path.read_text())
    if vectors.dtype != np.float32 or vectors.ndim != 2 or vectors.shape[0] != len(meta) or vectors.shape[1] < 1:
        raise ValueError("index shape or dtype mismatch")
    if not manifest_path.exists():
        raise ValueError("legacy index must be explicitly attested before search or update")
    manifest = json.loads(manifest_path.read_text())
    if (manifest.get("semantic_protocol") != 2 or manifest.get("model") != MODEL or
        manifest.get("dimension") != vectors.shape[1] or
        manifest.get("dtype") != "float32" or manifest.get("normalization") != "l2" or
        manifest.get("document_prefix") != DOCUMENT_TEMPLATE or
        manifest.get("query_prefix") != QUERY_PREFIX or
        manifest.get("chunker") != "semindex-chars-1200-150-v1"):
        raise ValueError("index protocol mismatch or unverified legacy index")
    for path in (vector_path, meta_path):
        expected = manifest.get("file_stats", {}).get(path.name, {})
        actual = path.stat()
        recorded = (expected.get("size"), expected.get("mtime_ns"), expected.get("ctime_ns"), expected.get("inode"), expected.get("mode"))
        current = (actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns, actual.st_ino, actual.st_mode & 0o777)
        if recorded != current or actual.st_mode & 0o777 != 0o400:
            raise ValueError(f"generation file changed: {path.name} {recorded} != {current}")
    if vector_path.parent.stat().st_mode & 0o777 != 0o500 or manifest_path.stat().st_mode & 0o777 != 0o400:
        raise ValueError("generation permissions are not owner-only")
    return vectors, meta


def save(corpus: str, vectors: np.ndarray, meta: list[dict], extra: dict) -> None:
    if vectors.dtype != np.float32 or vectors.ndim != 2 or vectors.shape[0] != len(meta) or vectors.shape[1] < 1:
        raise ValueError("invalid vector matrix")
    if not np.isfinite(vectors).all():
        raise ValueError("non-finite vector matrix")
    if len(vectors) and not np.allclose(np.linalg.norm(vectors, axis=1), 1.0, atol=0.015):
        raise ValueError("vectors are not normalized")
    generation = uuid.uuid4().hex
    generations_root = ROOT / "generations"
    generation_root = ROOT / "generations" / corpus
    generations_root.mkdir(exist_ok=True)
    fsync_path(ROOT, directory=True)
    generation_root.mkdir(exist_ok=True)
    fsync_path(generations_root, directory=True)
    # The generation name is unique and invisible until the atomic current pointer swap.
    stage = generation_root / generation
    stage.mkdir()
    vector_path, meta_path = stage / f"{corpus}.npy", stage / f"{corpus}.json"
    manifest_path = stage / f"{corpus}.manifest.json"
    np.save(vector_path, vectors)
    meta_path.write_text(json.dumps(meta, ensure_ascii=False))
    vector_path.chmod(0o400)
    meta_path.chmod(0o400)
    fsync_path(vector_path)
    fsync_path(meta_path)
    model_digest = extra.get("model_digest") or resident_model_digest()
    manifest = {
        "corpus": corpus,
        "model": MODEL,
        "chunks": len(meta),
        "built_at": time.strftime("%Y-%m-%dT%H:%M:%S"),
        "bytes": int(vectors.nbytes),
        "semantic_protocol": 2,
        "generation": generation,
        "model_digest": model_digest,
        "dimension": int(vectors.shape[1]),
        "dtype": "float32",
        "normalization": "l2",
        "document_prefix": DOCUMENT_TEMPLATE,
        "query_prefix": QUERY_PREFIX,
        "chunker": "semindex-chars-1200-150-v1",
        **extra,
    }
    names = [vector_path.name, meta_path.name]
    manifest["provenance"] = {path.name: file_digest(path) for path in (vector_path, meta_path)}
    manifest["file_stats"] = {path.name: {"size": path.stat().st_size, "mtime_ns": path.stat().st_mtime_ns,
                                          "ctime_ns": path.stat().st_ctime_ns, "inode": path.stat().st_ino,
                                          "mode": path.stat().st_mode & 0o777} for path in (vector_path, meta_path)}
    manifest_path.write_text(json.dumps(manifest, indent=1))
    manifest_path.chmod(0o400)
    stage.chmod(0o500)
    fsync_path(manifest_path)
    fsync_path(stage, directory=True)
    fsync_path(generation_root, directory=True)
    fsync_path(generations_root, directory=True)
    fsync_path(ROOT, directory=True)
    pointer_tmp = ROOT / f"{corpus}.current.{uuid.uuid4().hex}.tmp"
    with pointer_tmp.open("w") as pointer_file:
        pointer_file.write(generation)
        pointer_file.flush()
        os.fsync(pointer_file.fileno())
    os.replace(pointer_tmp, ROOT / f"{corpus}.current")
    fsync_path(ROOT, directory=True)
    print(f"published {corpus} generation ({vectors.nbytes / 1e6:.1f} MB), {len(meta)} chunks")


def file_digest(path: Path) -> str:
    digest = hashlib.sha256()
    with path.open("rb") as stream:
        for block in iter(lambda: stream.read(1024 * 1024), b""):
            digest.update(block)
    return digest.hexdigest()


def fsync_path(path: Path, directory: bool = False) -> None:
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if directory else 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def resident_model_digest() -> str:
    request = urllib.request.Request(f"{OLLAMA.rstrip('/')}/api/tags")
    with urllib.request.urlopen(request, timeout=2.0) as response:
        tags = json.loads(response.read(1_000_000))
    def canonical(value: str) -> str:
        final_component = value.rsplit("/", 1)[-1]
        return value if ":" in final_component else f"{value}:latest"
    wanted = canonical(MODEL)
    matches = [item for item in tags.get("models", [])
               if canonical(str(item.get("name", item.get("model", "")))) == wanted]
    if len(matches) != 1:
        raise ValueError("resident model tag is missing or ambiguous")
    value = matches[0].get("digest")
    if not isinstance(value, str) or not value:
        raise ValueError("resident model digest unavailable")
    return value


def embed_items(items: list[tuple[str, dict]], label: str) -> np.ndarray:
    texts = [DOCUMENT_TEMPLATE.format(title=title_of(meta), text=piece) for piece, meta in items]
    started = time.time()
    vectors = embed(texts)
    elapsed = time.time() - started
    print(f"embedded {len(texts)} {label} chunks in {elapsed:.1f}s ({len(texts) / elapsed:.1f}/s)")
    return vectors


def build(corpus: str, limit: int | None) -> None:
    if not MODEL:
        raise SystemExit("set SEMINDEX_MODEL to the exact resident embedding model")
    print(f"collecting {corpus}…", flush=True)
    model_digest = resident_model_digest()
    items, seen = collect(corpus, limit=limit)
    if not items:
        raise SystemExit("nothing collected")
    print(f"{len(items)} chunks collected", flush=True)
    vectors = embed_items(items, corpus)
    if resident_model_digest() != model_digest:
        raise ValueError("resident embedding model changed during build")
    meta = [{**m, "chunk": hashlib.sha1(p.encode()).hexdigest()[:12], "text": p} for p, m in items]
    extra: dict = {"files": seen, "model_digest": model_digest}
    if corpus == "traj":
        extra["watermark"] = max((m["time"] for _, m in items), default=0)
    save(corpus, vectors, meta, extra)


def update(corpus: str) -> None:
    """Re-embed only chunks whose source changed; drop the ones that vanished.

    `processed` is the set of sources this run actually re-read. A chunk survives
    when its source was not re-read (or was re-read and still yields the same
    text), and when the source still exists on disk for file-backed corpora.
    """
    vector_path, meta_path, manifest_path = paths(corpus)
    if not vector_path.exists():
        if (ROOT / f"{corpus}.current").exists():
            raise ValueError(f"{corpus}: published generation is incomplete")
        if (ROOT / f"{corpus}.npy").exists():
            raise ValueError(f"{corpus}: legacy index must be explicitly attested before update")
        raise ValueError(f"{corpus}: no index exists; run the explicit build command first")

    if not manifest_path.exists():
        raise ValueError(f"{corpus}: missing generation manifest")
    manifest = json.loads(manifest_path.read_text())
    if manifest.get("semantic_protocol") != 2 or not manifest.get("model_digest"):
        raise ValueError(f"{corpus}: legacy index must be explicitly attested before update")
    model_digest = resident_model_digest()
    if manifest.get("model") != MODEL or manifest.get("model_digest") != model_digest:
        raise ValueError(f"{corpus}: resident embedding model changed; refusing mixed generation")
    vectors, meta = load(corpus, (vector_path, meta_path, manifest_path))
    migrated = 0
    if meta and "sig" not in meta[0]:
        for item in meta:
            item.setdefault("source", item.get("part_id") or item.get("path") or item["chunk"])
            item["sig"] = item["chunk"]
            migrated += 1
        print(f"{corpus}: migrated {migrated} legacy chunks to chunk-level signatures")

    file_sigs = dict(manifest.get("files", {}))
    if corpus == "traj":
        # Reconcile every current source/signature. Existing vectors are reused below;
        # only changed chunk signatures reach embed_items.
        items, seen = collect("traj", since_ms=None)
    else:
        items, seen = collect(corpus, known=file_sigs)

    processed = {m["source"] for _, m in items}
    if corpus == "memory" and seen is not None:
        processed.update(source for source, signature in seen.items() if file_sigs.get(source) != signature)
    elif corpus == "traj" and seen is not None:
        processed.update(seen)
    incoming = {(m["source"], m["sig"]) for _, m in items}
    existing = {(m["source"], m["sig"]) for m in meta}
    existing_meta = {(m["source"], m["sig"]): m for m in meta}
    reusable = set(existing)
    fresh = []
    for piece, item in items:
        key = (item["source"], item["sig"])
        indexed = existing_meta.get(key)
        if indexed is None or title_of(indexed) != title_of(item):
            fresh.append((piece, item))
            reusable.discard(key)

    desired = set(incoming)
    for item in meta:
        source, sig = item["source"], item["sig"]
        if seen is not None and source not in seen:
            continue  # the file is gone
        if source in processed and (source, sig) not in incoming:
            continue  # re-read, and this chunk no longer exists
        desired.add((source, sig))

    keep_mask = np.array([(m["source"], m["sig"]) in desired and (m["source"], m["sig"]) in reusable
                          for m in meta], dtype=bool)
    kept_vectors = vectors[keep_mask]
    incoming_meta = {(m["source"], m["sig"]): {**m, "chunk": hashlib.sha1(p.encode()).hexdigest()[:12], "text": p}
                     for p, m in items}
    kept_meta = [incoming_meta.get((m["source"], m["sig"]), m)
                 for m, keep in zip(meta, keep_mask) if keep]
    original_kept_meta = [m for m, keep in zip(meta, keep_mask) if keep]
    metadata_changed = kept_meta != original_kept_meta
    dropped = int((~keep_mask).sum())

    if corpus == "memory" and seen is not None:
        file_sigs = {source: signature for source, signature in file_sigs.items() if source in seen}
        file_sigs.update(seen)
    elif corpus == "traj":
        file_sigs = {}
    extra: dict = {"files": file_sigs, "model_digest": model_digest}
    if corpus == "traj":
        extra["watermark"] = max((m["time"] for _, m in items), default=0)
    manifest_changed = file_sigs != manifest.get("files", {})
    if corpus == "traj":
        manifest_changed = manifest_changed or extra["watermark"] != manifest.get("watermark", 0)

    if not fresh and not dropped and not migrated and not metadata_changed and not manifest_changed:
        print(f"{corpus}: already up to date ({len(meta)} chunks)")
        return

    print(
        f"{corpus}: {len(meta)} indexed, {dropped} dropped, {len(fresh)} to embed"
    )
    new_vectors = embed_items(fresh, corpus) if fresh else None
    if new_vectors is not None and new_vectors.shape[1] != vectors.shape[1]:
        raise ValueError("embedding dimension changed; refusing mixed generation")
    if resident_model_digest() != model_digest:
        raise ValueError("resident embedding model changed during update")
    new_meta = [
        {**m, "chunk": hashlib.sha1(p.encode()).hexdigest()[:12], "text": p} for p, m in fresh
    ]
    if new_vectors is not None and len(kept_vectors):
        combined = np.vstack([kept_vectors, new_vectors])
    elif new_vectors is not None:
        combined = new_vectors
    else:
        combined = kept_vectors
    save(corpus, combined, kept_meta + new_meta, extra)


# ── commands ─────────────────────────────────────────────────────────────────


def snippet(text: str, limit: int = 700, full: bool = False) -> str:
    """Chunks are already paragraph-bounded; keep the breaks so context is readable."""
    body = text.strip()
    if full or len(body) <= limit:
        return body
    cut = body.rfind("\n\n", 0, limit)
    if cut < limit * 0.4:
        cut = body.rfind(". ", 0, limit)
    if cut < limit * 0.4:
        return body[:limit].rstrip() + " …"
    return body[:cut].rstrip() + " …"


def cmd_search(corpora: list[str], query: str, k: int, as_json: bool, kind: str | None, since: str | None, full: bool = False) -> None:
    since_ms = None
    if since:
        since_ms = int(time.mktime(time.strptime(since, "%Y-%m-%d")) * 1000)
    query_vector = embed_one(query)

    hits: list[tuple[float, dict]] = []
    for corpus in corpora:
        vectors, meta = load(corpus)
        scores = vectors @ query_vector
        for index in np.argsort(-scores)[: max(k * 4, 20)]:
            item = meta[index]
            if kind and item.get("kind") != kind:
                continue
            if since_ms and item.get("time") and item["time"] < since_ms:
                continue
            hits.append((float(scores[index]), {**item, "corpus": corpus}))
    hits.sort(key=lambda pair: -pair[0])
    hits = hits[:k]

    if as_json:
        print(
            json.dumps(
                [
                    {
                        "score": round(score, 4),
                        "corpus": item["corpus"],
                        "title": title_of(item),
                        "path": item.get("path"),
                        "session_id": item.get("session_id"),
                        "part_id": item.get("part_id"),
                        "kind": item.get("kind"),
                        "time": item.get("time"),
                        "text": item["text"],
                    }
                    for score, item in hits
                ],
                ensure_ascii=False,
            )
        )
        return

    for rank, (score, item) in enumerate(hits, 1):
        print(f"\n{rank}. [{score:.3f}] {title_of(item)}  ({item['corpus']})")
        location = item.get("path") or (
            f"session {item.get('session_id')} part {item.get('part_id')}"
            if item.get("session_id")
            else ""
        )
        if location:
            page = f" p.{item['page']}" if item.get("page") else ""
            print(f"   {location}{page}")
        body = snippet(item["text"], full=full)
        for line in body.splitlines():
            print(f"   {line}" if line.strip() else "   ")


def cmd_dedup(corpus: str, threshold: float, limit: int, as_json: bool) -> None:
    """Report near-duplicate chunks across files. Never deletes anything."""
    vectors, meta = load(corpus)
    pairs: list[tuple[float, int, int]] = []
    block = 2048
    for start in range(0, len(vectors), block):
        window = vectors[start : start + block] @ vectors.T
        for row in range(window.shape[0]):
            index = start + row
            for column in np.nonzero(window[row] > threshold)[0]:
                if column > index:
                    pairs.append((float(window[row, column]), index, int(column)))
    pairs.sort(reverse=True)

    seen: dict[tuple[str, str], float] = {}
    for score, left, right in pairs:
        a, b = meta[left], meta[right]
        if a.get("path") == b.get("path"):
            continue  # adjacent chunks of one file overlap by design
        key = tuple(sorted([a.get("path", a["chunk"]), b.get("path", b["chunk"])]))
        seen.setdefault(key, score)

    if as_json:
        print(
            json.dumps(
                [{"score": round(score, 4), "a": a, "b": b} for (a, b), score in list(seen.items())[:limit]],
                ensure_ascii=False,
            )
        )
        return
    for (a, b), score in list(seen.items())[:limit]:
        print(f"{score:.3f}  {a}\n       {b}")
    print(f"\n{len(seen)} distinct duplicate file pairs above {threshold}")


def cmd_status(as_json: bool) -> None:
    rows = []
    for corpus in COLLECTORS:
        vector_path, _, manifest_path = paths(corpus)
        if not vector_path.exists():
            rows.append({"corpus": corpus, "chunks": 0, "state": "not built"})
            continue
        vectors = np.load(vector_path, mmap_mode="r")
        manifest = json.loads(manifest_path.read_text()) if manifest_path.exists() else {}
        rows.append(
            {
                "corpus": corpus,
                "chunks": int(vectors.shape[0]),
                "mb": round(vectors.nbytes / 1e6, 1),
                "built_at": manifest.get("built_at"),
                "age_h": round((time.time() - vector_path.stat().st_mtime) / 3600, 2),
                "watermark": manifest.get("watermark"),
            }
        )
    if as_json:
        print(json.dumps(rows, indent=1))
        return
    for row in rows:
        if row.get("state"):
            print(f"{row['corpus']:8s} not built")
            continue
        print(
            f"{row['corpus']:8s} {row['chunks']:7d} chunks  {row['mb']:6.1f} MB  "
            f"{row['age_h']:6.2f}h old  built {row['built_at']}"
        )


@contextmanager
def corpus_lock(corpus: str):
    ROOT.mkdir(parents=True, exist_ok=True)
    lock = ROOT / f"{corpus}.writer.lock"
    if fcntl is None:
        raise RuntimeError("safe writer locking is unavailable on this platform")
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise RuntimeError(f"{corpus} writer is already active")
    try:
        os.ftruncate(descriptor, 0)
        os.write(descriptor, str(os.getpid()).encode())
        yield
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def main() -> None:
    parser = argparse.ArgumentParser(prog="semindex", description=__doc__, formatter_class=argparse.RawDescriptionHelpFormatter)
    sub = parser.add_subparsers(dest="command", required=True)
    names = list(COLLECTORS)

    build_parser = sub.add_parser("build", help="full rebuild of one corpus")
    build_parser.add_argument("corpus", choices=names)
    build_parser.add_argument("--limit", type=int, default=None, help="cap source items")

    update_parser = sub.add_parser("update", help="incremental refresh (only new or changed sources)")
    update_parser.add_argument("corpus", nargs="?", default="all", choices=names + ["all"])

    search_parser = sub.add_parser("search", help="semantic top-k")
    search_parser.add_argument("corpus", nargs="?", default="all", choices=names + ["all"])
    search_parser.add_argument("query")
    search_parser.add_argument("-k", type=int, default=8)
    search_parser.add_argument("--json", action="store_true")
    search_parser.add_argument("--kind", help="traj: user_text|assistant_text|summary_text|compaction")
    search_parser.add_argument("--since", help="YYYY-MM-DD, traj only")
    search_parser.add_argument("--full", action="store_true", help="print the whole chunk, not a 700-char cut")

    dedup_parser = sub.add_parser("dedup", help="report near-duplicate chunks")
    dedup_parser.add_argument("corpus", nargs="?", default="memory", choices=names)
    dedup_parser.add_argument("--threshold", type=float, default=0.95)
    dedup_parser.add_argument("--limit", type=int, default=25)
    dedup_parser.add_argument("--json", action="store_true")

    status_parser = sub.add_parser("status", help="what is built and how fresh")
    status_parser.add_argument("--json", action="store_true")

    args = parser.parse_args()
    if args.command in {"build", "update", "search", "dedup"} and not MODEL:
        parser.error("set SEMINDEX_MODEL to the exact resident embedding model")
    if args.command == "build":
        with corpus_lock(args.corpus):
            build(args.corpus, args.limit)
    elif args.command == "update":
        targets = names if args.corpus == "all" else [args.corpus]
        for corpus in targets:
            with corpus_lock(corpus):
                update(corpus)
    elif args.command == "search":
        cmd_search(
            names if args.corpus == "all" else [args.corpus],
            args.query,
            args.k,
            args.json,
            args.kind,
            args.since,
            args.full,
        )
    elif args.command == "dedup":
        cmd_dedup(args.corpus, args.threshold, args.limit, args.json)
    else:
        cmd_status(args.json)


if __name__ == "__main__":
    main()
