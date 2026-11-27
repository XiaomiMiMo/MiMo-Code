// The login URL as a QR code for a terminal: half blocks, two QR rows per text
// line and one column per module, which keeps the modules square. Dark modules
// are the blocks; they are painted dark on a light background so the code scans
// whatever the terminal theme is. The login URL is long (~134 characters), so the
// code needs 23 lines by 45 columns.

import { renderUnicodeCompact } from "uqr"

/** Half-block text; paint it black on white. */
export function qrBlocks(url: string): string {
  return renderUnicodeCompact(url, { border: 2, ecc: "L" })
}

/** The same half blocks, painted black on white with ANSI colours, for a plain terminal. */
export function qrAnsi(url: string): string {
  return qrBlocks(url)
    .split("\n")
    .map((line) => `\x1b[30;107m${line}\x1b[0m`)
    .join("\n")
}
