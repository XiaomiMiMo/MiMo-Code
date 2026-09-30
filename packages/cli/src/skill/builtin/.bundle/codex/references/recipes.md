# Codex CLI Headless Recipes

## Contents

- Production shell wrapper
- JSONL parsing
- Structured-result schema
- Docker runner
- GitHub Actions pattern
- Kubernetes job pattern
- Exit classification

## Production Shell Wrapper

```bash
#!/usr/bin/env bash
set -euo pipefail

repo="${1:?usage: run-codex.sh REPO TASK_FILE OUTPUT_DIR}"
task_file="${2:?usage: run-codex.sh REPO TASK_FILE OUTPUT_DIR}"
out_dir="${3:?usage: run-codex.sh REPO TASK_FILE OUTPUT_DIR}"

mkdir -p "$out_dir"

prompt="$(cat <<'PROMPT'
Work fully autonomously.
Do not ask questions or request interactive input.
Inspect the repository before making assumptions.
Choose conservative, backward-compatible, non-destructive defaults.
Run relevant validation and report assumptions and blockers.

Task:
PROMPT
)"
prompt+=$'\n'
prompt+="$(cat "$task_file")"

set +e
codex exec \
  -C "$repo" \
  --json \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-last-message "$out_dir/final.md" \
  "$prompt" \
  > "$out_dir/events.jsonl" \
  2> "$out_dir/stderr.log"
status=$?
set -e

printf '%s\n' "$status" > "$out_dir/exit-code.txt"
exit "$status"
```

## JSONL Parsing

Get the session ID:

```bash
jq -r 'select(.type == "thread.started") | .thread_id' events.jsonl | head -n 1
```

Get the last agent message found in events:

```bash
jq -r '
  select(.type == "item.completed" and .item.type == "agent_message")
  | .item.text
' events.jsonl | tail -n 1
```

Get failed turns and errors:

```bash
jq -c 'select(.type == "turn.failed" or .type == "error")' events.jsonl
```

Get usage records when emitted:

```bash
jq 'select(.type == "turn.completed") | .usage // empty' events.jsonl
```

Treat event schemas as versioned interfaces. Parse defensively and tolerate unknown event types.

## Structured-Result Schema

```json
{
  "$schema": "https://json-schema.org/draft/2020-12/schema",
  "type": "object",
  "properties": {
    "status": {
      "type": "string",
      "enum": ["success", "partial", "failed"]
    },
    "summary": { "type": "string" },
    "changed_files": {
      "type": "array",
      "items": { "type": "string" }
    },
    "validation": {
      "type": "array",
      "items": {
        "type": "object",
        "properties": {
          "command": { "type": "string" },
          "result": { "type": "string" }
        },
        "required": ["command", "result"],
        "additionalProperties": false
      }
    },
    "assumptions": {
      "type": "array",
      "items": { "type": "string" }
    },
    "blockers": {
      "type": "array",
      "items": { "type": "string" }
    }
  },
  "required": [
    "status",
    "summary",
    "changed_files",
    "validation",
    "assumptions",
    "blockers"
  ],
  "additionalProperties": false
}
```

## Docker Runner

```dockerfile
FROM node:22-bookworm

RUN npm install -g @openai/codex \
    && useradd --create-home --uid 10001 codex

USER codex
WORKDIR /workspace

ENTRYPOINT ["codex", "exec"]
```

Safe default invocation:

```bash
docker run --rm \
  --network=none \
  --read-only \
  --tmpfs /tmp:rw,nosuid,nodev,size=512m \
  --cpus=2 \
  --memory=4g \
  -e CODEX_API_KEY="$OPENAI_API_KEY" \
  -v "$PWD:/workspace" \
  -v "$PWD/.codex-output:/output" \
  codex-headless \
  -C /workspace \
  --sandbox workspace-write \
  --ask-for-approval never \
  --output-last-message /output/final.md \
  "Analyze and complete the task autonomously."
```

A read-only root filesystem can conflict with tools that expect writable cache or home directories. Add narrowly scoped tmpfs or writable mounts rather than disabling isolation broadly.

## GitHub Actions Pattern

Do not expose a Codex credential to a step that runs untrusted repository code. Separate credentialed analysis from untrusted build execution when possible.

```yaml
name: codex-review

on:
  workflow_dispatch:

jobs:
  review:
    runs-on: ubuntu-latest
    permissions:
      contents: read
    steps:
      - uses: actions/checkout@v4
        with:
          persist-credentials: false

      - name: Install Codex CLI
        run: npm install -g @openai/codex

      - name: Run Codex
        env:
          CODEX_API_KEY: ${{ secrets.CODEX_API_KEY }}
        run: |
          mkdir -p artifacts
          codex exec \
            -C "$GITHUB_WORKSPACE" \
            --json \
            --sandbox read-only \
            --ask-for-approval never \
            --output-last-message artifacts/final.md \
            "Review the repository without executing project-controlled code." \
            > artifacts/events.jsonl \
            2> artifacts/stderr.log

      - uses: actions/upload-artifact@v4
        with:
          name: codex-output
          path: artifacts/
```

Pin third-party actions to immutable commit SHAs in high-security environments.

## Kubernetes Job Pattern

```yaml
apiVersion: batch/v1
kind: Job
metadata:
  name: codex-headless
spec:
  backoffLimit: 0
  activeDeadlineSeconds: 1800
  template:
    spec:
      restartPolicy: Never
      automountServiceAccountToken: false
      containers:
        - name: codex
          image: example/codex-headless:latest
          args:
            - -C
            - /workspace
            - --json
            - --sandbox
            - workspace-write
            - --ask-for-approval
            - never
            - --output-last-message
            - /output/final.md
            - Work autonomously. Inspect the repository, implement the task, run validation, and report blockers.
          env:
            - name: CODEX_API_KEY
              valueFrom:
                secretKeyRef:
                  name: codex-credentials
                  key: api-key
          resources:
            requests:
              cpu: "1"
              memory: 2Gi
            limits:
              cpu: "2"
              memory: 4Gi
          securityContext:
            allowPrivilegeEscalation: false
            capabilities:
              drop: ["ALL"]
            runAsNonRoot: true
            readOnlyRootFilesystem: true
          volumeMounts:
            - name: workspace
              mountPath: /workspace
            - name: output
              mountPath: /output
      volumes:
        - name: workspace
          emptyDir: {}
        - name: output
          emptyDir: {}
```

Populate the workspace using a trusted init container or a prebuilt task image. Do not grant the Pod broad cluster permissions.

## Exit Classification

Classify a run using multiple signals:

1. Process exit code
2. Presence of `turn.failed` or `error` events
3. Structured final `status`, when configured
4. Expected repository diff
5. Validation command results
6. Timeout, OOM, or external runner termination

Do not equate exit code zero with a correct implementation. Conversely, preserve useful partial artifacts from failed runs for diagnosis.
