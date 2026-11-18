#!/usr/bin/env python3
"""Bounded source-scoped lookup and explicit attestation for semindex generations."""
import hashlib
import heapq
import json
import os
import shutil
import sys
import time
import urllib.request
import uuid
from pathlib import Path

try:
    import fcntl
except ImportError:
    fcntl = None

import numpy as np

DOCUMENT_TEMPLATE = os.environ.get("SEMINDEX_DOCUMENT_TEMPLATE", "{title} | {text}")
QUERY_PREFIX = os.environ.get("SEMINDEX_QUERY_PREFIX", "")
SCORING_BATCH_SIZE = 4096


def digest(path):
    h = hashlib.sha256()
    with path.open("rb") as f:
        for block in iter(lambda: f.read(1024 * 1024), b""):
            h.update(block)
    return h.hexdigest()


def fsync_path(path, directory=False):
    flags = os.O_RDONLY | (getattr(os, "O_DIRECTORY", 0) if directory else 0)
    descriptor = os.open(path, flags)
    try:
        os.fsync(descriptor)
    finally:
        os.close(descriptor)


def embed(texts, model, ollama, dimension):
    payload = json.dumps({"model": model, "input": texts}).encode()
    req = urllib.request.Request(ollama.rstrip("/") + "/api/embed", payload, {"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=2.0) as response:
        body = json.loads(response.read(1_000_000))
    vectors = np.asarray(body["embeddings"], dtype=np.float32)
    if vectors.ndim != 2 or len(vectors) != len(texts) or vectors.shape[1] != dimension or not np.isfinite(vectors).all():
        raise ValueError("embedding response shape")
    # Scale first so finite float32 values near the representable limit do not
    # overflow while squaring. This also handles very small nonzero embeddings.
    scales = np.max(np.abs(vectors), axis=1)
    if not np.isfinite(scales).all() or np.any(scales <= 0):
        raise ValueError("embedding response norm")
    scaled = vectors / scales[:, None]
    norms = np.linalg.norm(scaled, axis=1)
    if not np.isfinite(norms).all() or np.any(norms <= 0):
        raise ValueError("embedding response norm")
    normalized = scaled / norms[:, None]
    if not np.isfinite(normalized).all() or not np.allclose(np.linalg.norm(normalized, axis=1), 1.0, atol=0.015):
        raise ValueError("unusable normalized embedding")
    return normalized


def top_matches(rows, vectors, query, limit):
    """Score eligible rows in bounded vector batches; ties prefer lower source index."""
    count = min(max(1, min(int(limit), 50)), len(rows))
    best = []
    for start in range(0, len(rows), SCORING_BATCH_SIZE):
        batch = rows[start:start + SCORING_BATCH_SIZE]
        indices = np.fromiter((index for index, _ in batch), dtype=np.int64, count=len(batch))
        scores = vectors[indices] @ query
        if not np.isfinite(scores).all():
            raise ValueError("non-finite semantic score")
        for (index, item), score_value in zip(batch, scores):
            score = float(score_value)
            entry = (score, -index, index, item)
            if len(best) < count:
                heapq.heappush(best, entry)
            elif entry[:2] > best[0][:2]:
                heapq.heapreplace(best, entry)
    return sorted(best, key=lambda entry: (-entry[0], entry[2]))


def model_digest(model, ollama):
    req = urllib.request.Request(ollama.rstrip("/") + "/api/tags")
    with urllib.request.urlopen(req, timeout=1.5) as response:
        tags = json.loads(response.read(1_000_000))
    def canonical(value):
        final_component = value.rsplit("/", 1)[-1]
        return value if ":" in final_component else value + ":latest"
    wanted = canonical(model)
    matches = [item for item in tags.get("models", [])
               if canonical(str(item.get("name", item.get("model", "")))) == wanted]
    if len(matches) != 1:
        raise ValueError("resident model tag is missing or ambiguous")
    digest_value = matches[0].get("digest")
    if not isinstance(digest_value, str) or not digest_value:
        raise ValueError("resident model digest unavailable")
    return digest_value


def attest_unlocked(corpus, root):
    if corpus not in ("memory", "traj"):
        raise ValueError("invalid corpus")
    paths = [root / f"{corpus}.{ext}" for ext in ("npy", "json", "manifest.json")]
    before = [(p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns, p.stat().st_ino) for p in paths]
    manifest = json.loads(paths[2].read_text())
    model = os.environ.get("SEMINDEX_MODEL")
    if not model:
        raise ValueError("SEMINDEX_MODEL must name the exact resident embedding model")
    if manifest.get("corpus") != corpus or manifest.get("model") != model:
        raise ValueError("legacy manifest identity mismatch")
    meta = json.loads(paths[1].read_text())
    vectors = np.load(paths[0], allow_pickle=False, mmap_mode="r")
    if vectors.dtype != np.float32 or vectors.ndim != 2 or vectors.shape[0] != len(meta) or vectors.shape[1] < 1 or manifest.get("chunks") != len(meta):
        raise ValueError("index shape mismatch")
    if not np.isfinite(vectors).all():
        raise ValueError("non-finite index vector")
    norms = np.linalg.norm(vectors, axis=1)
    if len(norms) and not np.allclose(norms, 1.0, atol=0.015):
        raise ValueError("index vectors are not normalized")
    sample = [i for i, item in enumerate(meta) if isinstance(item.get("text"), str)][:3]
    if not sample:
        raise ValueError("empty index")
    phrases = [DOCUMENT_TEMPLATE.format(title=str(meta[i].get('title') or meta[i].get('path') or meta[i].get('kind') or 'untitled')[:160], text=meta[i]['text']) for i in sample]
    ollama = os.environ.get("SEMINDEX_OLLAMA", "http://localhost:11434")
    resident_digest = model_digest(model, ollama)
    fresh = embed(phrases, model, ollama, vectors.shape[1])
    if model_digest(model, ollama) != resident_digest:
        raise ValueError("resident model changed during attestation")
    cosine = np.sum(fresh * vectors[sample], axis=1)
    if np.any(cosine < 0.97):
        raise ValueError("sample embeddings do not match resident model")
    if before != [(p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns, p.stat().st_ino) for p in paths]:
        raise ValueError("legacy files changed during attestation")
    generation = uuid.uuid4().hex
    generations_root = root / "generations"
    corpus_root = generations_root / corpus
    genroot = corpus_root / generation
    generations_root.mkdir(exist_ok=True)
    fsync_path(root, directory=True)
    corpus_root.mkdir(exist_ok=True)
    fsync_path(generations_root, directory=True)
    genroot.mkdir()
    published = False
    try:
        names = [f"{corpus}.npy", f"{corpus}.json"]
        for source, name in zip(paths[:2], names):
            shutil.copyfile(source, genroot / name)
        if before != [(p.stat().st_size, p.stat().st_mtime_ns, p.stat().st_ctime_ns, p.stat().st_ino) for p in paths]:
            raise ValueError("legacy files changed during snapshot")
        for name in names:
            (genroot / name).chmod(0o400)
            fsync_path(genroot / name)
        provenance = {name: digest(genroot / name) for name in names}
        out_manifest = {**manifest, "semantic_protocol": 2, "generation": generation,
                        "provenance": provenance, "attested_at": time.time(),
                        "sample_count": len(sample), "sample_min_cosine": float(np.min(cosine)),
                        "model_digest": resident_digest, "dimension": int(vectors.shape[1]), "dtype": "float32",
                        "normalization": "l2", "document_prefix": DOCUMENT_TEMPLATE,
                        "query_prefix": QUERY_PREFIX, "chunker": "semindex-chars-1200-150-v1",
                        "file_stats": {name: {"size": (genroot / name).stat().st_size,
                                               "mtime_ns": (genroot / name).stat().st_mtime_ns,
                                               "ctime_ns": (genroot / name).stat().st_ctime_ns,
                                               "inode": (genroot / name).stat().st_ino,
                                               "mode": (genroot / name).stat().st_mode & 0o777} for name in names}}
        (genroot / f"{corpus}.manifest.json").write_text(json.dumps(out_manifest))
        for name in [f"{corpus}.manifest.json"]:
            (genroot / name).chmod(0o400)
        genroot.chmod(0o500)
        fsync_path(genroot / f"{corpus}.manifest.json")
        fsync_path(genroot, directory=True)
        fsync_path(corpus_root, directory=True)
        fsync_path(generations_root, directory=True)
        fsync_path(root, directory=True)
        pointer = root / f"{corpus}.current.{uuid.uuid4().hex}.tmp"
        with pointer.open("w") as stream:
            stream.write(generation)
            stream.flush()
            os.fsync(stream.fileno())
        os.replace(pointer, root / f"{corpus}.current")
        published = True
        fsync_path(root, directory=True)
    except Exception:
        if not published:
            try:
                genroot.chmod(0o700)
                for child in genroot.iterdir():
                    child.chmod(0o600)
            except OSError:
                pass
            shutil.rmtree(genroot, ignore_errors=True)
        raise
    print(json.dumps({"generation": generation, "sample_count": len(sample), "sample_min_cosine": float(np.min(cosine))}))


def attest(corpus, root):
    root.mkdir(parents=True, exist_ok=True)
    if fcntl is None:
        raise RuntimeError("safe attestation locking is unavailable on this platform")
    lock = root / f"{corpus}.writer.lock"
    descriptor = os.open(lock, os.O_CREAT | os.O_RDWR, 0o600)
    try:
        fcntl.flock(descriptor, fcntl.LOCK_EX | fcntl.LOCK_NB)
    except BlockingIOError:
        os.close(descriptor)
        raise RuntimeError(f"{corpus} writer is already active")
    try:
        os.ftruncate(descriptor, 0)
        os.write(descriptor, str(os.getpid()).encode())
        attest_unlocked(corpus, root)
    finally:
        fcntl.flock(descriptor, fcntl.LOCK_UN)
        os.close(descriptor)


def search(request, root):
    corpus = request.get("corpus")
    allowed = set(request.get("allowed", []))
    if corpus not in ("memory", "traj") or not allowed or len(allowed) > 200_000:
        raise ValueError("invalid request")
    if any(not isinstance(source, str) or len(source.encode("utf-8")) > 512 for source in allowed):
        raise ValueError("invalid source id")
    pointer = root / f"{corpus}.current"
    generation = pointer.read_text().strip()
    if not generation or "/" in generation or ".." in generation:
        raise ValueError("invalid generation pointer")
    genroot = root / "generations" / corpus / generation
    manifest = json.loads((genroot / f"{corpus}.manifest.json").read_text())
    model = os.environ.get("SEMINDEX_MODEL")
    if not model:
        raise ValueError("SEMINDEX_MODEL must name the exact resident embedding model")
    dimension = manifest.get("dimension")
    if manifest.get("semantic_protocol") != 2 or manifest.get("generation") != generation or not manifest.get("provenance"):
        raise ValueError("unverified generation")
    if not isinstance(dimension, int) or dimension < 1:
        raise ValueError("index dimension is invalid")
    if manifest.get("corpus") != corpus or manifest.get("model") != model or manifest.get("dtype") != "float32" or manifest.get("normalization") != "l2" or manifest.get("query_prefix") != QUERY_PREFIX or manifest.get("document_prefix") != DOCUMENT_TEMPLATE or manifest.get("chunker") != "semindex-chars-1200-150-v1":
        raise ValueError("index identity mismatch")
    meta_path, vector_path = genroot / f"{corpus}.json", genroot / f"{corpus}.npy"
    # Publication hashes once, then seals files read-only. Per-query stat checks avoid
    # re-hashing hundreds of megabytes; owners who can alter the directory can bypass mode bits.
    for path in (meta_path, vector_path):
        expected = manifest.get("file_stats", {}).get(path.name, {})
        actual = path.stat()
        if (expected.get("size"), expected.get("mtime_ns"), expected.get("ctime_ns"), expected.get("inode"), expected.get("mode")) != (actual.st_size, actual.st_mtime_ns, actual.st_ctime_ns, actual.st_ino, actual.st_mode & 0o777) or actual.st_mode & 0o777 != 0o400:
            raise ValueError("generation file changed")
    if genroot.stat().st_mode & 0o777 != 0o500:
        raise ValueError("generation directory permissions are not owner-only")
    meta = json.loads(meta_path.read_text())
    vectors = np.load(vector_path, allow_pickle=False, mmap_mode="r")
    if vectors.dtype != np.float32 or len(meta) != len(vectors) or manifest.get("chunks") != len(meta) or vectors.ndim != 2 or vectors.shape[1] != dimension:
        raise ValueError("index shape mismatch")
    rows = [(i, item) for i, item in enumerate(meta) if item.get("source") in allowed]
    if not rows:
        print("[]")
        return
    query_text = request.get("query")
    if not isinstance(query_text, str) or not query_text.strip() or len(query_text.encode("utf-8")) > 16000:
        raise ValueError("invalid query")
    ollama = os.environ.get("SEMINDEX_OLLAMA", "http://localhost:11434")
    if model_digest(model, ollama) != manifest.get("model_digest"):
        raise ValueError("resident model digest changed")
    query = embed([QUERY_PREFIX + query_text], model, ollama, dimension)[0]
    order = top_matches(rows, vectors, query, request.get("limit", 8))
    hits = []
    for rank, (_, _, _, item) in enumerate(order, 1):
        text, sig = item.get("text"), item.get("sig")
        if not isinstance(text, str) or not isinstance(sig, str) or hashlib.sha1(text.encode()).hexdigest()[:12] != sig:
            continue
        hits.append({"source": item["source"], "text": text, "signature": sig, "rank": rank,
                     "sessionID": item.get("session_id"), "messageID": item.get("message_id"),
                     "partID": item.get("part_id"), "time": item.get("time"), "kind": item.get("kind")})
    print(json.dumps(hits, ensure_ascii=False))


def main():
    root = Path(os.environ.get("SEMINDEX_HOME", Path.home() / ".local/share/semindex"))
    if len(sys.argv) == 3 and sys.argv[1] == "--attest":
        attest(sys.argv[2], root)
    elif len(sys.argv) == 1:
        raw = sys.stdin.buffer.read(32_000_001)
        if len(raw) > 32_000_000:
            raise ValueError("request too large")
        search(json.loads(raw), root)
    else:
        raise ValueError("invalid invocation")


if __name__ == "__main__":
    try:
        main()
    except Exception:
        sys.exit(1)
