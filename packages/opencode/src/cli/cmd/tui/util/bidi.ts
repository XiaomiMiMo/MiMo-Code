const RLI = "\u2067"
const PDI = "\u2069"
const RTL = /[\u0590-\u08ff\ufb1d-\ufdff\ufe70-\ufefc]/
const BIDI_CONTROL = /[\u202a-\u202e\u2066-\u2069]/
const FENCE = /^\s*(```|~~~)/

export function isolateBidiText(text: string) {
  if (!RTL.test(text) || BIDI_CONTROL.test(text)) return text

  let fenced = false
  return text
    .split("\n")
    .map((line) => {
      if (FENCE.test(line)) {
        fenced = !fenced
        return line
      }
      if (fenced || !RTL.test(line)) return line
      return `${RLI}${line}${PDI}`
    })
    .join("\n")
}
