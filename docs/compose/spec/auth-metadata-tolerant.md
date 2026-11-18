---
feature: auth-metadata-tolerant
status: in-progress
updated: 2026-11-18
source: fix/auth-metadata-tolerant
---

# Tolerant auth.json metadata

## Report
[Not finalized yet]

## [S1] Problem

MiMo Desktop's one-click platform link writes `auth.json` entries shaped
`{ type: "api", key, metadata: { uid, base_url, platform_linked: true } }` for `xiaomi` and
`xiaomi-token-plan-*`. The CLI's `Auth.Api` schema declares `metadata` as
`Record<string, string>`, so the boolean `platform_linked` fails decoding and `Auth.all()` silently
drops the whole entry. Two user-visible effects:

1. The CLI sees no credential for the linked providers; requests go out without a valid key
   (`401 Invalid API Key`).
2. `Auth.set` / `Auth.remove` rewrite the file from the decoded view, so re-linking one provider in
   the CLI (e.g. Token Plan) erases every other undecodable entry from disk — the Desktop-linked
   `xiaomi` disappears, leaving only `xiaomi-token-plan-cn`.

## [S2] Design

### S2.1 Lenient read

When reading `auth.json` from disk, an `api` entry's `metadata` keeps only its string-valued fields
before decoding; non-string fields (such as `platform_linked: true`) are omitted from the decoded
`Auth.Info`. The entry itself stays valid. The public `Auth.Info` type is unchanged
(`metadata?: Record<string, string>`), so the SDK and plugin contracts do not move.

### S2.2 Lossless write

`Auth.set` and `Auth.remove` mutate the raw JSON object of the same source `all()` reads, touching
only the target key (plus its trailing-slash twin). Entries the CLI does not understand, and unknown
metadata fields on other entries, are written back byte-for-byte equivalent JSON values.

### S2.3 Unchanged paths

The in-process `inject` / `MIMOCODE_AUTH_CONTENT` channel keeps returning the parsed JSON as before.

## [S3] Out of Scope

- Whether a CLI re-link should preserve Desktop's `platform_linked` marker on the entry it
  overwrites (the overwritten entry is replaced by the CLI's own login result, as today).
- Changes in MiMo Desktop.

## Tasks
- [ ] T1: Lenient decode of api metadata — acceptance: an `auth.json` entry with `metadata.platform_linked: true` is returned by `Auth.all()` with its key and string metadata (covers: S2.1)
- [ ] T2: Raw-preserving set/remove — acceptance: `Auth.set` on one provider keeps a sibling entry carrying `platform_linked: true` on disk unchanged (covers: S2.2)

## Journey log
None
