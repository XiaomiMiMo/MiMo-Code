// Session catalog for one authorized device group: sessions-page and
// sessions-changed.
//
// `revision` hashes the ordered [{sessionId,title}] list, so every page of one
// read and every watch notification agree on it. Cursors are MAC'd with a
// random key that only lives as long as this group (a restart, epoch or grant
// change makes old cursors invalid instead of letting them address new data).

import { base64url, fromBase64url, hex, sha256 } from "./json"
import type { BackendSession } from "./ports"

export const WIRE_ID = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/
const CURSOR_PREFIX = "mimo-cli-catalog-v1\n"
const CURSOR_LIFETIME_MS = 300_000
/** Entries JSON stays under the 256 KiB frame with room for the envelope. */
const PAGE_BUDGET_BYTES = 262_144 - 2_048
const MAX_TITLE = 4096

export type CatalogEntry = { sessionId: string; title: string; updatedAt?: string }
export type CatalogPage = { revision: string; entries: CatalogEntry[]; nextCursor: string | null }
export type CatalogError = "invalid_cursor" | "cursor_expired" | "catalog_changed" | "projection_too_large"

type CursorBody = { v: 1; keyId: string; revision: string; offset: number; issuedAt: number; expiresAt: number }

export class Catalog {
  private readonly key = crypto.getRandomValues(new Uint8Array(32))
  private readonly keyId = crypto.randomUUID()

  constructor(private readonly clock: () => number = Date.now) {}

  async revision(sessions: BackendSession[]): Promise<string> {
    return hex(await sha256(JSON.stringify(entriesOf(sessions).map(({ sessionId, title }) => ({ sessionId, title })))))
  }

  async page(sessions: BackendSession[], cursor: string | null, limit: number): Promise<CatalogPage | CatalogError> {
    const entries = entriesOf(sessions)
    const revision = await this.revision(sessions)
    let offset = 0
    if (cursor !== null) {
      const body = await this.open(cursor)
      if (typeof body === "string") return body
      if (body.revision !== revision) return "catalog_changed"
      if (body.offset >= entries.length) return "invalid_cursor"
      offset = body.offset
    }
    const page: CatalogEntry[] = []
    let bytes = 2
    for (const entry of entries.slice(offset, offset + limit)) {
      const size = new TextEncoder().encode(JSON.stringify(entry)).length + 1
      if (bytes + size > PAGE_BUDGET_BYTES) break
      bytes += size
      page.push(entry)
    }
    if (page.length === 0 && offset < entries.length) return "projection_too_large"
    const next = offset + page.length
    return {
      revision,
      entries: page,
      nextCursor: next < entries.length ? await this.seal(revision, next) : null,
    }
  }

  private async seal(revision: string, offset: number): Promise<string> {
    const issuedAt = this.clock()
    const body: CursorBody = {
      v: 1,
      keyId: this.keyId,
      revision,
      offset,
      issuedAt,
      expiresAt: issuedAt + CURSOR_LIFETIME_MS,
    }
    const encoded = base64url(new TextEncoder().encode(JSON.stringify(body)))
    return `${encoded}.${base64url(await this.mac(encoded))}`
  }

  private async open(cursor: string): Promise<CursorBody | CatalogError> {
    const [encoded, mac, extra] = cursor.split(".")
    if (!encoded || !mac || extra !== undefined || cursor.length > 2048) return "invalid_cursor"
    const expected = base64url(await this.mac(encoded))
    if (mac !== expected) return "invalid_cursor"
    let body: CursorBody
    try {
      body = JSON.parse(new TextDecoder().decode(fromBase64url(encoded)))
    } catch {
      return "invalid_cursor"
    }
    if (body.v !== 1 || body.keyId !== this.keyId) return "invalid_cursor"
    const now = this.clock()
    if (now < body.issuedAt || now >= body.expiresAt) return "cursor_expired"
    return body
  }

  private async mac(encoded: string): Promise<Uint8Array> {
    const key = await crypto.subtle.importKey("raw", this.key, { name: "HMAC", hash: "SHA-256" }, false, ["sign"])
    return new Uint8Array(await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(CURSOR_PREFIX + encoded)))
  }
}

function entriesOf(sessions: BackendSession[]): CatalogEntry[] {
  return sessions
    .filter((session) => WIRE_ID.test(session.id))
    .map((session) => ({
      sessionId: session.id,
      title: clipTitle(session.title),
      ...(Number.isFinite(session.updatedAt) && session.updatedAt > 0
        ? { updatedAt: new Date(session.updatedAt).toISOString() }
        : {}),
    }))
}

/** The phone accepts titles of at most 4096 UTF-16 units; longer ones are cut, never dropped. */
export function clipTitle(title: string): string {
  if (title.length <= MAX_TITLE) return title
  const end = /[\uD800-\uDBFF]/.test(title[MAX_TITLE - 1]) ? MAX_TITLE - 1 : MAX_TITLE
  return title.slice(0, end)
}
