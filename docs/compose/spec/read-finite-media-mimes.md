---
feature: read-finite-media-mimes
status: delivered
updated: 2026-09-12
branch: fix/read-finite-media-mimes
commits: 6fbb1732..4b4d5b90
---

# read finite media MIME allowlist

## Report

**What was built** — `read` no longer treats every `audio/*` or `video/*` MIME as attachable media. Attachment branches open only for a finite allowlist in `util/media.ts`: images `image/jpeg|png|webp|gif`, PDF `application/pdf`, audio `audio/wav|x-wav|mp3|mpeg`, video `video/mp4`. Binary media-like files outside that list (`.webm`, `.aac`, sniffed BMP) refuse with a convert hint naming the list; text-like media-like MIMEs fall through to the text reader (`.ts`/`.mts` fix for the `video/mp2t` mime-types collision).

Tool description is aligned in a second pass: static `read.txt` stays model-independent — image and PDF are attachments when the model includes those modalities — and names the finite list (`jpeg/png/webp/gif`, `wav/mp3`, `mp4`). Dynamic `describeMedia(model)` advertises only the modalities the model has, with those same finite format names.

**Verification** —
- `bun typecheck` in `packages/cli` — PASS
- `bun test test/util/media.test.ts test/tool/read.test.ts` — 61 pass, 0 fail
- Reviewer pass 1 (allowlist): all 5 acceptance criteria met; no critical findings
- Reviewer pass 2 (description alignment): APPROVE; no critical findings

**Journey log** —
- Root cause: `mime-types` extension lookup, not content sniffing — `.ts` → `video/mp2t` is a known IANA collision with TypeScript.
- Feature lineage: audio/video attach landed 2026-09-12 (`049fe862`, `cca753c0`); image/PDF earlier; sniffing `7fa302e3` (2026-09-07).
- User chose a stricter-than-MiMo allowlist (no BMP/FLAC/M4A/OGG/MOV/AVI/WMV) over a `modality` tool parameter.
- BMP was previously attached for transform transcode; it is now refused under the finite image list.
- Prefix helpers (`isMedia`, `looksLikeMediaMime`) remain for messaging only — they must never gate a successful attach.
- Static desc must keep PDF caveated, not model-gated; dynamic desc owns capability-specific format lists. Change either string set and update the other + tests.

## [S1] Problem

The `read` tool decided media modality with prefix checks on a MIME from `sniffAttachmentMime(sample, AppFileSystem.mimeType(filepath))`. `mime-types` maps `.ts`/`.mts` to `video/mp2t`, so TypeScript source entered the video branch and was refused. Prefix rules would attach any future `audio/*`/`video/*` lookup even when MiMo cannot take it.

Audio/video attachment was added on 2026-09-12 (`049fe862`, `cca753c0`). Image/PDF attachment predates that; content sniffing landed earlier (`7fa302e3`, 2026-09-07).

## [S2] Design

`read` attaches media only when the resolved MIME is in a finite allowlist. Prefix matches are no longer sufficient to enter an attachment branch.

| Modality | MIME allowlist |
| --- | --- |
| image | `image/jpeg`, `image/png`, `image/webp`, `image/gif` |
| PDF | `application/pdf` |
| audio | `audio/wav`, `audio/x-wav`, `audio/mp3`, `audio/mpeg` |
| video | `video/mp4` |

Official MiMo also lists BMP/FLAC/M4A/OGG/MOV/AVI/WMV; `read` will not attach those. GIF stays (explicitly allowed).

Helpers: `isReadImageMime`, `isReadPdfMime`, `isReadAudioMime`, `isReadVideoMime`, `isReadAttachmentMime`.

`read.ts` branching after `sniffAttachmentMime`:

1. MIME in a finite list → existing size / model-capability / adapter-declaration gates, then attach.
2. MIME looks like media but is **outside** every finite list:
   - sample is binary → refuse with a convert hint naming that modality’s finite list.
   - sample is text-like → **fall through** to the text path (`.ts` / `.mts` fix).
3. Otherwise → existing text / binary-fail path.

No `modality` tool parameter. Sniffing still overrides extension for known image/pdf/wav headers, but a sniffed MIME outside the finite list (e.g. BMP) is not attached.

Tool description alignment (second pass):

- **Static** `read.txt` stays model-independent: one short sentence covers image and PDF — both are attachments “when the model includes those modalities” — and the same line names the finite attach list (`jpeg/png/webp/gif`, `wav/mp3`, `mp4`). All multimodal attach is model-capability gated, not PDF-only.
- **Dynamic** `describeMedia(model)` lists only the modalities the model accepts, each with the same finite format names (`image (jpeg, png, webp, gif)`, `audio (wav, mp3)`, `video (mp4)`). It does not invent PDF support; PDF remains the static caveat plus the runtime capability gate.

`view_image`, prompt-attachment routing, and MCP sampling keep their current prefix/capability logic (out of scope).

## [S3] Out of Scope

- Adding a `modality` parameter to `read`.
- Changing `AppFileSystem.mimeType` / `mime-types` itself.
- Broadening or narrowing provider capability declarations in `capability-registry.ts`.
- prompt-side user attachments, MCP sampling, or `view_image` MIME policy.
- Supporting MPEG-TS video (`.ts`/`.m2ts`) even when binary — callers convert to `video/mp4` first.

## Tasks
- [x] T1: Export finite read-attachment MIME allowlists and membership helpers from `util/media.ts` — acceptance: helpers return true only for listed MIMEs; `video/mp2t` is not a read image/audio/video/pdf mime (covers: S2)
- [x] T2: Gate `tool/read.ts` media branches on the finite lists; binary media-like files outside the list still refuse with a convert hint naming the allowed list; text-like media-like MIMEs fall through to text — acceptance: `.ts` TypeScript source reads as text; `.webm` binary still refuses with convert hint (covers: S2; depends: T1)
- [x] T3: Add/adjust regression tests in `test/util/media.test.ts` and `test/tool/read.test.ts` — acceptance: tests cover `.ts`/`.mts` as text, finite-list attach still works for wav/mp4, out-of-list binary media still refuses (covers: S2; depends: T2)
