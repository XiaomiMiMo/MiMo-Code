import { randomUUID } from "crypto"

export const PTY_CONNECT_TICKET_QUERY = "ticket"
export const PTY_CONNECT_TOKEN_HEADER = "x-mimocode-ticket"
export const PTY_CONNECT_TOKEN_HEADER_VALUE = "1"

const PTY_CONNECT_PATH = /^\/pty\/[^/]+\/connect$/

const DEFAULT_TTL_MS = 60_000

type TicketRecord = {
  ptyID: string
  expiresAt: number
}

const store = new Map<string, TicketRecord>()

function gc() {
  const now = Date.now()
  for (const [key, record] of store) {
    if (record.expiresAt <= now) store.delete(key)
  }
}

export function isPtyConnectPath(pathname: string) {
  return PTY_CONNECT_PATH.test(pathname)
}

export function issue(ptyID: string, ttl = DEFAULT_TTL_MS): { ticket: string; expires_in: number } {
  gc()
  const ticket = randomUUID()
  store.set(ticket, { ptyID, expiresAt: Date.now() + ttl })
  return { ticket, expires_in: Math.round(ttl / 1000) }
}

export function consume(ticket: string, ptyID: string): boolean {
  const record = store.get(ticket)
  if (!record) return false
  store.delete(ticket)
  if (record.expiresAt <= Date.now()) return false
  return record.ptyID === ptyID
}
