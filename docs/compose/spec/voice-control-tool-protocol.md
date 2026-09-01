---
feature: voice-control-tool-protocol
status: delivered
updated: 2026-09-05
branch: feat/voice-control-tool-protocol
commits: d17e176b..HEAD
---

# Voice Control Tool Protocol

## Report

**What was built** — TUI voice control now speaks the desktop `voice_input` tool-call protocol: unique function tool, three-part `{before_cursor, selection, after_cursor}` snapshot (unfocused falls back to full string), insert/set/set_with_cursor + send, protocol retry ≤2, no agent/model arms. System prompt lives in `util/voice-input.txt` (English instructions, Chinese utterance examples). ASR inserts at caret/selection with end-of-buffer space rule; control VAD uses `minSilenceS=1.2`. Insert on an unchanged buffer uses a surgical splice (keeps paste/file extmarks); set/set_with_cursor full rewrite clears parts. Models stay `xiaomi/mimo-v2.5` / `xiaomi/mimo-v2.5-asr`.

**Verification** — `bun typecheck` (packages/opencode) PASS; `bun test test/cli/tui/voice.test.ts` 42 pass, 0 fail. `bun run build:local` + smoke PASS. Independent review (3 rounds): protocol/snapshot/natural-selection solid; post-review fixes: surgical insert when buffer unchanged (keeps paste/file parts), ASR mid-flight end fallback, live mode switch, stale/protocol toasts, tool-role retry, object arguments.

**Journey log**
1. Desktop control is tool-call + three-part snapshot; old TUI JSON `edit/send/agent` is the drift to remove.
2. `@opentui` caret/selection are display-width; convert via `offset.ts` before slicing UTF-16.
3. `input.clear()` does not clear extmarks — insert on unchanged buffer stays surgical; full rewrite must clear parts.
4. Unfocused textarea can report caret 0; voice snapshot must fall back to append-at-end.
5. Prompt as `.txt` import matches the rest of the package (system/tool descriptions).

## [S1] Problem

TUI voice control still speaks the old JSON protocol (`response_format: json_object` + Chinese prompt producing `edit`/`send`/`agent` array). Desktop has converged on a forced `voice_input` function tool call with a three-part cursor/selection snapshot, English de-hallucinated prompt, and no agent/model switching. The two surfaces drift; TUI also cannot express cursor/selection edits (only whole-buffer replace). ASR mode always appends at end instead of inserting at the caret.

## [S2] Design

### Mode contract

| Mode id | Product name | Model default | Request body |
|---------|--------------|---------------|--------------|
| `asr` | 快速输入 | `xiaomi/mimo-v2.5-asr` | Xiaomi data-URL + `asr_options` (unchanged) |
| `control` | 智能编辑 | `xiaomi/mimo-v2.5` | system prompt + user(text JSON + raw wav `input_audio`) + unique tool `voice_input` |

No `mimo-explore-a`. Override stays `voice.control_model` / `voice.asr_model` in config.

### Editor snapshot (shared)

Both modes read the prompt textarea once per segment:

```
{
  value: plainText,
  cursor: { start, end },   // UTF-16 indices; selection range, empty = collapsed
}
```

If the textarea is not focused or snapshot cannot be paired, fall back to `{ value, cursor: null }` (append-at-end semantics). Source APIs on `TextareaRenderable`: `plainText`, `cursorOffset` (display-width; convert via existing `widthToStringIndex`), `getSelection()` / `hasSelection()`, `getSelectedText()`, `insertText`, `setSelection`, `deleteSelection`, `clearSelection`.

Context sent to control model:

```json
{
  "text": { "before_cursor": "...", "selection": "...", "after_cursor": "..." },
  "send_enabled": true
}
```

or `"text": "<full string>"` when no reliable caret/selection.

### Control protocol (`voice_input`)

- Unique function tool; no `tool_choice`, no `enable_thinking`.
- Args (zod + JSON Schema for API):
  - `operation` optional discriminated union:
    - `{ action: "insert", text: string }` — exact splice at caret or replace selection. No client-added separators.
    - `{ action: "set", text: string }` — full final buffer; caret to end.
    - `{ action: "set_with_cursor", before_cursor, selection, after_cursor }` — three parts concatenate to full final text; restore selection.
  - `send` optional boolean — only honored when `send_enabled`.
- Parse: exactly one tool call named `voice_input`; JSON args; zod path errors.
- Protocol failure (no tool call / bad name / bad JSON / zod fail) → append assistant message + user protocol error, retry ≤2. Business filter (send disabled) does not retry.
- No agent arm. No model arm.

### Prompt asset

Copy desktop `electron/prompts/voice-input.md` into TUI as `util/voice-input.txt` (Bun text import). Keep Chinese utterance examples; instructions English. Do not mention agent/model/permission switching.

### ASR path

- Keep Xiaomi fast-ASR body unchanged.
- No send command on ASR — 「发送」/"send it" are dictated as text. Send exists only in control mode via `voice_input`.
- Placement: if caret snapshot exists and no selection → insert at caret (exact, no auto space mid-buffer); if selection exists → replace selection; if no caret → append with existing end-of-buffer space rule.

### VAD

Control mode starts streaming with `minSilenceS: 1.2`. ASR keeps VAD default `0.8`.

### Action application (prompt/index.tsx)

- `voiceApplyFromBase(base, target)` — compute the next buffer from a frozen `{value, range}` snapshot (never a live caret). **Insert on an unchanged buffer** uses a surgical `insertText` splice so paste/file extmarks survive. **set / set_with_cursor** (or any full rewrite) clear extmarks and parts.
- `placeNaturalSelection` — caret first (`cursorOffset = end`), then `setSelection(start, end)` (opentui clears selection when `cursorOffset` is assigned).
- `submit()` — gated by `voice_send_command`.
- No agent switch.

Staleness: if `plainText` differs from the request snapshot, drop the text mutation and send, and toast `tui.voice.error.stale`. ASR also snapshots before transcription; if the user typed mid-flight, dictate at the end of the current buffer.

### Config / flags

Unchanged keys: `voice_enabled`, `voice_send_command`, `voice_control_enabled`, `voice.asr_model`, `voice.control_model`.

## [S3] Out of Scope

- Engine-registered LLM tool for agents to call voice
- Desktop explore-a / explore-b models
- Agent or model switching via voice
- Streaming ASR (partial segments)
- Hold-to-talk
- TTS reply playback
- Desktop package implementation

## Tasks

- [x] T1: Add `voice-input.txt` prompt asset + `VOICE_INPUT_TOOL_*` schema/description + `buildVoiceControlBody` / `parseVoiceControlResponse` / `buildVoiceControlRetryBody` in `util/voice.ts`. Acceptance: unit tests for body shape, zod path errors, retry body append, tool-exactly-once. (covers: S2)
- [x] T2: Editor snapshot helpers — UTF-16 caret/selection read from TextareaRenderable, three-part placement, insert/set/set_with_cursor application, stale drop. Acceptance: unit tests for width↔string index, three-part slice, insert exact splice. (covers: S2; depends: —)
- [x] T3: Wire control path in `prompt/index.tsx` — request context, tool protocol, retry ≤2, drop agent switch callbacks, VAD `minSilenceS` 1.2 for control. Acceptance: typecheck; control flow no longer references `edit`/`agent` actions or Chinese JSON prompt. (covers: S2; depends: T1, T2)
- [x] T4: Upgrade ASR path to caret/selection placement. Acceptance: unit tests for append vs mid-insert vs selection-replace. (covers: S2; depends: T2)
- [x] T5: Update existing `voice.test.ts` and add protocol/placement coverage. Acceptance: `bun test` from `packages/opencode` passes. (covers: S2; depends: T1–T4)
- [x] T6: Typecheck + focused test run + review. Acceptance: `bun typecheck` and voice tests pass in package. (covers: S2; depends: T5)
