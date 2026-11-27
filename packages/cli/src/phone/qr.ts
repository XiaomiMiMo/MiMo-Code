// The login URL as a QR code for a terminal. Dark modules are drawn as filled
// blocks; the caller paints them dark on a light background, so the code scans
// whatever the terminal theme is.

import { renderANSI, renderUnicodeCompact } from "uqr"

/** Half-block text, two QR rows per line; paint it black on white. */
export function qrBlocks(url: string): string {
  return renderUnicodeCompact(url, { border: 2, ecc: "L" })
}

/** ANSI-coloured QR code for a plain terminal (`mimo phone login`). */
export function qrAnsi(url: string): string {
  return renderANSI(url, { border: 2, ecc: "L" })
}
