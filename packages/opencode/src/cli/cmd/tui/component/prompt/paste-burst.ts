/**
 * Distinguish a pasted text burst from human typing on terminals that do not
 * support bracketed paste mode.
 *
 * Without bracketed paste (mode 2004) the terminal delivers a paste as a rapid
 * stream of ordinary key events, so every newline inside the pasted text looks
 * like Enter and fires the editor's submit — one message per pasted line. A
 * paste stream delivers keystrokes within microseconds of each other; no human
 * types a character and hits Enter within the same few milliseconds. Recording
 * when the last printable key arrived is enough to tell the two apart.
 */
export class PasteBurstGuard {
  private lastPrintableAt = 0

  constructor(private readonly windowMs = 20) {}

  /** Record a key event. Only printable single-character keys move the clock. */
  key(name: string | undefined, now: number = Date.now()): void {
    if (name && name.length === 1) this.lastPrintableAt = now
  }

  /**
   * Whether an Enter pressed `now` may submit. Enter arriving inside the
   * window after a printable key is part of a paste burst and must be kept in
   * the editor (as a newline) instead of sent.
   */
  canSubmit(now: number = Date.now()): boolean {
    return now - this.lastPrintableAt >= this.windowMs
  }
}
