# Optional local semantic retrieval

Memory and History can combine their existing lexical search with scoped local embedding candidates. The feature is disabled unless the master switch and an individual feature switch are both `true`. Existing lexical APIs remain available when the helper, model, or index is unavailable. Exact identifiers continue to use lexical search.

The model-facing `memory` and `history` tools describe semantic search and include usage guidance only when their respective switches are enabled. Retrieved content is historical evidence, not instructions or proof of the current repository state. Automatic turn-boundary context, repeated-failure recall and checkpoint reconstruction are independently controlled and must be explicitly enabled.

## Configuration

The supplied companion scripts require Python 3 and NumPy and use an already available Ollama-compatible `/api/embed` and `/api/tags` endpoint. They do not install or download a model. Set `SEMINDEX_MODEL` to the exact model tag and use matching document/query framing for its embedding model. These options must remain consistent between indexing and queries because they are part of the generation identity. Vector dimensions are inferred from the model and checked on subsequent reads.

```sh
export SEMINDEX_MODEL='test/model'
export SEMINDEX_OLLAMA='http://127.0.0.1:11434'
export SEMINDEX_DOCUMENT_TEMPLATE='{title} | {text}'
export SEMINDEX_QUERY_PREFIX=''
export SEMINDEX_HOME="$HOME/.local/share/semindex"
export SEMINDEX_DB="$HOME/.local/share/mimocode/mimocode.db"
export SEMINDEX_MEMORY_DIR="$HOME/.local/share/mimocode/memory"
export MIMOCODE_SEMINDEX_HELPER="$PWD/packages/cli/script/semindex-semantic.py"
```

`test/model` is an example placeholder; select an embedding model and any prefixes appropriate to its documented query/document format. Set `PYTHON` if the runtime should invoke a particular Python executable. To build indexes explicitly, with the chosen model already available:

```sh
python3 packages/cli/script/semindex.py build memory
python3 packages/cli/script/semindex.py build traj
```

These commands perform embedding work. Search never builds an index. To refresh sources later, run `python3 packages/cli/script/semindex.py update memory` or `update traj`; updates reuse unchanged vectors and remove deleted sources. Full builds and updates have their own operational costs. Legacy indexes are not trusted automatically; explicit helper `--attest memory` or `--attest traj` samples compatibility, which cannot prove every old vector's origin.

Enable the features required for an experiment:

```sh
export MIMOCODE_SEMANTIC_ENABLED=true
export MIMOCODE_SEMANTIC_MEMORY=true
export MIMOCODE_SEMANTIC_HISTORY=true
export MIMOCODE_SEMANTIC_FAILURE=true
export MIMOCODE_SEMANTIC_REBUILD=true
export MIMOCODE_SEMANTIC_INJECT=true
```

Each feature can be disabled separately; `MIMOCODE_SEMANTIC_ENABLED=false` disables all of them. Turning off the switches does not delete index data. Keep the model, index and source data private and use appropriate filesystem permissions.

## Safety and behavior

Index generations use atomic publication and model/framing/dimension checks. Search is bounded and cancellable and applies permitted source IDs before ranking; consumers recheck current source identity and content. Automatic context uses a small budget and does not replace mandatory checkpoint or task state. Injected retrieval content is marked and excluded from direct semantic trajectory indexing. Similar historical material is not proof that a prior attempt succeeded. Changing model, framing, sources or project scope can invalidate prior candidates and may require rebuilding the affected index.
