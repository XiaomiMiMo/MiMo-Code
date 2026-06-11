export type ImageProtocol = "kitty"

export function detectImageProtocol(): ImageProtocol | undefined {
  const e = process.env
  if (e.KITTY_WINDOW_ID) return "kitty"
  if (e.TERM === "xterm-kitty") return "kitty"
  if (e.TERM === "xterm-ghostty" || e.GHOSTTY_RESOURCES_DIR) return "kitty"
  if (e.TERM_PROGRAM === "WezTerm") return "kitty"
  return undefined
}

let nextId = 1
export const allocImageId = () => nextId++

const CHUNK = 4096

export async function kittyDisplay(opts: { id: number; filePath: string; cols: number; rows: number }) {
  const b64 = Buffer.from(await Bun.file(opts.filePath).arrayBuffer()).toString("base64")
  const out: string[] = ["\x1b7\x1b[1;1H"]
  for (let i = 0; i < b64.length; i += CHUNK) {
    const chunk = b64.slice(i, i + CHUNK)
    const more = i + CHUNK < b64.length ? 1 : 0
    out.push(
      i === 0
        ? `\x1b_Gf=100,a=T,q=2,c=${opts.cols},r=${opts.rows},z=-1,i=${opts.id},C=1,m=${more};${chunk}\x1b\\`
        : `\x1b_Gm=${more};${chunk}\x1b\\`,
    )
  }
  out.push("\x1b8")
  process.stdout.write(out.join(""))
}

export function kittyClear(id: number) {
  process.stdout.write(`\x1b_Ga=d,d=I,i=${id},q=2\x1b\\`)
}
