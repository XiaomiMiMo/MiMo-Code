const CODE_TEXT = {
  Numpad0: "0",
  Numpad1: "1",
  Numpad2: "2",
  Numpad3: "3",
  Numpad4: "4",
  Numpad5: "5",
  Numpad6: "6",
  Numpad7: "7",
  Numpad8: "8",
  Numpad9: "9",
  NumpadDecimal: ".",
  NumpadAdd: "+",
  NumpadSubtract: "-",
  NumpadMultiply: "*",
  NumpadDivide: "/",
} as const

const NAMED_TEXT = {
  Add: "+",
  Decimal: ".",
  Divide: "/",
  Multiply: "*",
  Subtract: "-",
} as const

export function numpadInputText(event: KeyboardEvent) {
  if (!event.code.startsWith("Numpad")) return
  if (event.ctrlKey || event.metaKey || event.altKey) return
  if (event.key.length === 1) return event.key
  if (Object.hasOwn(NAMED_TEXT, event.key)) return NAMED_TEXT[event.key as keyof typeof NAMED_TEXT]
  if (event.key !== "Process" && event.key !== "Unidentified") return
  if (Object.hasOwn(CODE_TEXT, event.code)) return CODE_TEXT[event.code as keyof typeof CODE_TEXT]
}
