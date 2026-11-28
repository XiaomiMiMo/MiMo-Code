---
feature: read-media-split
status: delivered
updated: 2026-11-18
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2829
---

# Split media reading out of `read`

## Report

**What was built** — Three built-in tools, `read_image`, `read_audio` and `read_video` (`src/tool/read-media.ts`, shared path/miss helpers in `src/tool/read-common.ts`). Each has a single `file_path` parameter and a static description. The registry offers a tool only when the turn's model, through its adapter, supports that input kind (an `unknown` adapter verdict hides it, and so does an unresolvable model). The tools are hidden in Codex mode, and each one re-checks the gate when it runs. `read` now handles text and directories only: media fails with `Cannot read binary file`, and the model-dependent `describeMedia` paragraph is gone. `@`-mentions of media files are sniffed. Images, audio and video go to the matching media tool; a PDF is inlined only for a model with PDF input and otherwise stays a path reference. Permission (`read` governs the three tools), parallel-readonly gating, dream/distill allowlists, compaction, the system-prompt vision hint, TUI/run rendering and ACP kinds are all wired. A follow-up ([S2.6]) labels media calls in the TUI and `mimo run` as `Read image|audio|video <path>`, rendered by the existing `Read` renderer through a dependency-free id → kind mapping (`tool/media-kind.ts`).

**Verification**
- `bun run typecheck` (packages/cli): PASS.
- `bun test --timeout 30000 test/tool/ test/permission/ test/session/system.test.ts test/session/compaction.test.ts test/session/prompt.test.ts test/agent/agent.test.ts test/acp`: PASS (1010 pass, 0 fail). This run predates the final PDF-mention fix; `test/session/prompt.test.ts test/tool/` re-run after it: 784 pass, 0 fail.
- Full `bun test --timeout 30000` (packages/cli): 6233 pass, 76 fail. The failures fall into three groups:
  - **PRE-EXISTING:** MCP lifecycle/admission/oauth and Project/Vcs/Worktree git tests (the same 20 failures reproduce on the main checkout).
  - **Load-only flakes:** several session/actor/instance-dispose tests that pass when run in isolation (82 pass).
  - **Stale test:** `read-vision-harness.test.ts`, retargeted to `read_image` (6 pass).
- The `@`-mention regression test fails on the pre-fix head with `Cannot read binary file` and passes now.
- [S2.6] follow-up: `bun run typecheck` PASS; `bun test --timeout 30000 test/tool/ test/session/compaction.test.ts test/session/prompt.test.ts test/permission/` PASS (937 pass, 0 fail, including the new `test/tool/media-kind.test.ts`); `mimo run` from source with a real model calling `read_image` printed `→ Read image <path>`.

## [S1] Problem

`read` carries text files, directories, images, PDFs, audio and video in one tool. Every model sees the same tool regardless of what it can ingest; media support is only advertised through a model-dependent paragraph appended to the description (`describeMedia`), and a model without the capability learns that only after it calls `read` on a media file. The media branches also make `read` the largest built-in tool (`packages/cli/src/tool/read.ts`) and couple its text path to image recompression, PDF skill hints and audio/video adapter checks.

The model should instead see one dedicated tool per media kind, and only when the current model **and** the provider adapter it runs through can accept that kind.

## [S2] Design

### [S2.1] Tool set

Three new built-in tools, each with a single parameter `file_path` (string, path to the file; relative paths resolve against the session cwd exactly like `read`):

| Tool | Accepted MIME (sniffed, existing allowlists in `src/util/media.ts`) | Gate |
|---|---|---|
| `read_image` | `READ_IMAGE_MIMES` — jpeg/png/webp/gif | `ModelCapability.modelDeclaration(model, "image").support === "supported"` |
| `read_audio` | `READ_AUDIO_MIMES` — wav/mp3 | `modelDeclaration(model, "audio").support === "supported"` |
| `read_video` | `READ_VIDEO_MIMES` — mp4 | `modelDeclaration(model, "video").support === "supported"` |

`modelDeclaration` ANDs the model's declared input modality with the adapter declaration for `model.api.npm`. An adapter verdict of `unknown` counts as unsupported: the tool is hidden (fail closed).

The tools live in one module (`src/tool/read-media.ts`) sharing path resolution, the external-directory check, the `read` permission ask, stat/miss handling and MIME sniffing. Behavior moves from `read.ts` unchanged:

- `read_image`: `classifyAttachment` size gate before reading; `shrinkAttachment` for oversized images within the source ceiling; oversized notice otherwise; attachment `data:` URL.
- `read_audio` / `read_video`: adapter MIME narrowing (`declared.mimeTypes`), `fitsMediaBase64` encoded-size gate before reading; attachment with `filename`.
- A file whose sniffed MIME is not in the tool's allowlist is refused with a message naming the accepted formats and a conversion hint (the existing `ffmpeg` example); a missing file fails with the same `File not found` error (with similar-name suggestions) `read` returns, and a directory fails with `Path is a directory, not a/an <kind> file: <path>`.
- Media tools do not resolve directory instructions (`AGENTS.md`): their output carries no file content, so there is nothing to attach them to, and `session/instruction.ts` only tracks `read` parts.

PDF gets no tool. The bundled pdf skill already covers it — text extraction by default, page rendering when layout or figures matter, OCR only for scans without a text layer — so a native PDF modality adds no capability and is no longer consulted by any tool. Neither `read` nor the media tools mention the skill in descriptions or outputs.

### [S2.2] Visibility

`ToolRegistry.available()` resolves the turn's model (`provider.getModel(providerID, modelID)`, defect → `undefined`) and drops each media tool whose gate in [S2.1] fails. An unresolvable model hides all three.

- Codex/GPT mode (`useGPTTools`) is unchanged: the three tools are hidden there exactly like `read`, and `view_image` keeps its current behavior.
- Agent `toolAllowlist` and subagent filtering apply after this, as today.
- Exec/tool-script dispatch goes through `available()`, so it sees the same set.
- The model-dependent `describeMedia` paragraph and `describeReadMedia` are removed; each media tool has a static description (formats and size limit). The tool **list** now varies with model capability where the `read` **description** varied before, so prefix-cache stability across turns of one model is unchanged.

### [S2.3] Execution-time gate

Each media tool re-checks its gate at execution against the model resolved the same way `read` does today (`ctx.extra.model`, else the last user message's model). On failure it returns an output (not an error) stating the current model has no such input support and the file was not read. For `read_image` on a non-vision model the existing vision-subagent dispatch hint is kept.

### [S2.4] `read` becomes text and directory only

- Any file whose sniffed MIME is in the image/PDF/audio/video allowlists, or that `looksLikeMediaMime` and is binary, fails with the existing binary error: `Cannot read binary file: <path>`. No attachment, no capability-specific hint (the vision-subagent and pdf-skill hints leave `read`).
- `read.txt` drops the media line and states that binary files (images, PDFs, audio, video) are not read by this tool. It does not name the media tools, so the description stays model-independent.
- `read` no longer resolves the model or depends on `Provider.Service`.

### [S2.5] Callers and wiring

- `session/system.ts` `<vision-capability>`: the subagent hint says the subagent can `read_image` the file.
- `session/prompt.ts` `@file` resolution: text and directory parts still call `read`. Media parts keep their current inline path; the synthetic "Called the `…` tool" line names `read_audio`/`read_video` for audio/video and stays `read` for PDF.
- `@`-mentions (TUI autocomplete, `insertFileReference`, ACP resource links, command-template `@path`) arrive as `text/plain` whatever the file holds. Their MIME is sniffed first: a PDF takes the inline PDF path above when the model declares PDF input, and otherwise stays a path reference (`[Attached local file: <path>]` plus a no-PDF-input note) without its bytes being read or stored; an image, audio or video file is passed to `read_image`/`read_audio`/`read_video` with the turn's model (synthetic line names that tool), so a capable model still receives the attachment and an incapable one gets the tool's gate output.
- `ToolRegistry.named()` also returns the three media tools (`media.image|audio|video`) for that dispatch. The registry gates only the built-in media tools; a plugin tool that replaces one of those ids is not gated.
- `permission/index.ts` `READ_TOOLS` gains the three tools, so the `read` permission governs them.
- `tool/gate.ts` `PARALLEL_READONLY_TOOLS` gains the three tools.
- `agent/agent.ts` dream and distill allowlists gain `read_image` next to `view_image`.
- `session/compaction.ts` records files read by the three tools the same way it records `read`.
- TUI (`cli/cmd/tui/routes/session/index.tsx`) and `cli/cmd/run.ts` render the three tools as a one-line view per [S2.6].
- ACP (`acp/agent.ts`) reports the three tools with tool kind `read` and their `file_path` as location, like `read`.

### [S2.6] Media tool rendering

The TUI and `mimo run` render each media tool on one line with the `read` icon (`→`) and the media kind between the verb and the path, so the line says which tool ran:

| Tool | Completed line | TUI pending text |
|---|---|---|
| `read_image` | `Read image <path>` | `Reading image...` |
| `read_audio` | `Read audio <path>` | `Reading audio...` |
| `read_video` | `Read video <path>` | `Reading video...` |

`read` keeps `Read <path> [offset=…, limit=…]`. The existing `Read` renderer in both the TUI and `run.ts` handles all four tools and inserts the kind when the tool is a media tool; there is no separate media renderer. The kind comes from one dependency-free mapping (`tool/media-kind.ts`: tool id → `image | audio | video`) that `read-media.ts`, the registry, compaction, the TUI and `run.ts` all use, so the TUI does not import the tool runtime.

Stored sessions need no migration: past `read` tool parts keep their name, output and attachments, and `session/tool-attachment.ts` still gates historical media (including PDFs) per model.

## [S3] Out of Scope

- Codex/GPT mode tool set and `view_image`.
- A `read_pdf` tool or PDF adapter declarations.
- Any change to bundled skills (including pdf-official); skills do not name the media tools.
- New media formats or limits.
- User-attached media delivery (`@file` inline path, including user-attached PDFs) beyond the synthetic tool-name line.
- Changing `session/tool-attachment.ts` history gating.

## Tasks

- [x] T1: `src/tool/read-media.ts` with `read_image`, `read_audio`, `read_video` and their descriptions — acceptance: tests cover each tool's success attachment, wrong-format refusal, oversized refusal before read (image shrink path included), missing file, directory, and the execution-time gate output for an incapable model (covers: S2.1, S2.3)
- [x] T2: Registry visibility — acceptance: registry tests show a text-only model sees none of the three; an image-only model sees only `read_image`; an audio+video model on `@ai-sdk/anthropic` or an undeclared adapter sees neither `read_audio` nor `read_video`, on `@ai-sdk/openai-compatible` sees both; Codex mode sees none and keeps `view_image`; `describeMedia` is gone (covers: S2.2; depends: T1)
- [x] T3: Strip media from `read` — acceptance: `read` on png/pdf/wav/mp4 fails with `Cannot read binary file`, including for a model that declares those modalities; text and directory behavior and existing text tests unchanged; `read.txt` updated (covers: S2.4; depends: T1)
- [x] T4: Callers and wiring per [S2.5] — acceptance: permission test shows denying `read` disables the three tools; system prompt vision hint names `read_image`; TUI/run render the tools; `bun typecheck` passes (covers: S2.5; depends: T2, T3)
- [x] T5: Kind-labelled media rendering per [S2.6] — acceptance: `mediaToolKind` maps exactly the three ids and nothing else (unit test); TUI and `run.ts` print `Read image|audio|video <path>` (a `mimo run` from source shows `Read image <path>` for a `read_image` call); `bun typecheck` passes (covers: S2.6)

## Journey log

- [S2.6] amends the first delivery, which rendered all three media tools as `Read <path>`: a `read_video` line could not be told apart from a `read` call, which matters because `read` refuses media.
- Review found that `@`-mentions are `text/plain` parts routed to `read`, so after S2.4 a mentioned image/PDF/audio/video failed with `Cannot read binary file` instead of attaching. Fixed by sniffing mentions in `prompt.ts` and dispatching to the media tool (or the inline PDF path); covered by a `prompt.test.ts` regression test.
- Audio/video through an adapter with no capability declaration (e.g. `@ai-sdk/openai`) is now unavailable: the old `read` checked only the model's modality, the media tools also require the adapter declaration (fail closed, per S2.1).
- PDF was first planned as a fourth tool `read_pdf` gated only on the model's `pdf` modality. Dropped: no adapter declaration for PDF exists, MiMo's API does not document PDF input although one MiMo models.dev entry declares it, and a native PDF modality is server-side text extraction plus per-page images — which the bundled pdf skill reproduces (text by default, chosen pages rendered when needed, OCR only for scans). The skill is left untouched: tool names stay out of skills, since the model learns them from tool descriptions.
