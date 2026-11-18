---
feature: auth-metadata-tolerant
status: delivered
updated: 2026-11-18
source: https://github.com/XiaomiMiMo/MiMo-Code/pull/2830
---

# Tolerant auth.json metadata

## Report
**What was built** — `Auth.all()` now tolerates non-string `metadata` fields on disk `api` entries (they are omitted from the decoded view instead of dropping the credential), and `Auth.set` / `Auth.remove` rewrite the raw JSON so entries and fields the CLI does not understand survive. Desktop one-click-linked `xiaomi` / `xiaomi-token-plan-*` credentials are usable from the CLI and are no longer erased when the CLI re-links another provider.

**Verification**
- `bun test test/auth test/provider/provider-auth-write.test.ts test/provider/xiaomi-family.test.ts test/plugin/mimo.test.ts` — 45 pass / 0 fail (both new tests failed on base for the intended reason)
- `bun test test/provider test/cli` — 1048 pass / 0 fail
- `bun run typecheck` (packages/cli) — pass
- Manual: Desktop-shaped auth.json under a temp `XDG_DATA_HOME`, `providers list` — base: 0 credentials; branch: 2 credentials
- Independent review — approved, no critical findings; test cleanup nit addressed

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
- [x] T1: Lenient decode of api metadata — acceptance: an `auth.json` entry with `metadata.platform_linked: true` is returned by `Auth.all()` with its key and string metadata (covers: S2.1)
- [x] T2: Raw-preserving set/remove — acceptance: `Auth.set` on one provider keeps a sibling entry carrying `platform_linked: true` on disk unchanged (covers: S2.2)

## Journey log
None
