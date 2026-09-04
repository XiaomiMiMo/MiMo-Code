// Pure editor placement helpers shared by voice control and ASR.
// Selection/cursor offsets from the editor are display-width; convert via offset.ts.

import { widthToStringIndex, stringIndexToWidth } from "../component/prompt/offset"

export type EditorRange = { start: number; end: number }

export type TextPlacement = {
  before_cursor: string
  selection: string
  after_cursor: string
}

export type VoiceTextTarget =
  | { kind: "insert"; text: string }
  | { kind: "set"; text: string }
  | { kind: "set_with_cursor"; placement: TextPlacement }

type EditorLike = {
  plainText: string
  cursorOffset: number
  hasSelection: () => boolean
  getSelection: () => { start: number; end: number } | null
}

/** UTF-16 index range of the current selection, or a collapsed caret. */
export function getEditorRange(editor: EditorLike): EditorRange {
  const text = editor.plainText
  if (editor.hasSelection()) {
    const sel = editor.getSelection()
    if (sel) {
      const a = widthToStringIndex(text, sel.start)
      const b = widthToStringIndex(text, sel.end)
      return { start: Math.min(a, b), end: Math.max(a, b) }
    }
  }
  const idx = widthToStringIndex(text, editor.cursorOffset)
  return { start: idx, end: idx }
}

export function toTextPlacement(text: string, range: EditorRange): TextPlacement {
  return {
    before_cursor: text.slice(0, range.start),
    selection: text.slice(range.start, range.end),
    after_cursor: text.slice(range.end),
  }
}

/** Request context text: three-part when a caret/selection exists, else full string. */
export function controlContextText(text: string, range: EditorRange | null): string | TextPlacement {
  if (!range) return text
  return toTextPlacement(text, range)
}

export function applyVoiceTarget(
  value: string,
  range: EditorRange,
  target: VoiceTextTarget,
): { text: string; caret: number; selection?: EditorRange } {
  if (target.kind === "insert") {
    const text = value.slice(0, range.start) + target.text + value.slice(range.end)
    return { text, caret: range.start + target.text.length }
  }
  if (target.kind === "set") return { text: target.text, caret: target.text.length }
  const p = target.placement
  const text = p.before_cursor + p.selection + p.after_cursor
  const selStart = p.before_cursor.length
  const selEnd = selStart + p.selection.length
  return {
    text,
    caret: selEnd,
    selection: p.selection.length > 0 ? { start: selStart, end: selEnd } : undefined,
  }
}

/**
 * ASR dictation placement.
 * Selection replace or mid-buffer insert: exact splice (no auto separator).
 * End-of-buffer append: keep the existing period-then-space rule.
 */
export function asrInsertTarget(value: string, range: EditorRange, chunk: string): VoiceTextTarget {
  const trimmed = chunk.trim()
  if (!trimmed) return { kind: "insert", text: "" }
  const atEnd = range.start === value.length && range.end === value.length
  const collapsed = range.start === range.end
  if (!(atEnd && collapsed)) return { kind: "insert", text: trimmed }
  const needsSpace = value.length > 0 && /[.?!]$/.test(value) && trimmed[0] !== " "
  return { kind: "insert", text: needsSpace ? " " + trimmed : trimmed }
}

export function widthCaretFor(text: string, caretIndex: number): number {
  return stringIndexToWidth(text, caretIndex)
}

export function widthSelectionFor(text: string, range: EditorRange): { start: number; end: number } {
  return {
    start: stringIndexToWidth(text, range.start),
    end: stringIndexToWidth(text, range.end),
  }
}

type PlacementEditor = {
  cursorOffset: number
  setSelection: (start: number, end: number) => void
  clearSelection: () => boolean
}

/**
 * Natural selection: highlight [start,end) and park caret at end.
 * Order matters in opentui — assigning cursorOffset clears an existing selection,
 * so the caret must be set before setSelection.
 */
export function placeNaturalSelection(editor: PlacementEditor, value: string, range: EditorRange): void {
  const w = widthSelectionFor(value, range)
  if (range.start === range.end) {
    editor.clearSelection()
    editor.cursorOffset = w.start
    return
  }
  editor.cursorOffset = w.end
  editor.setSelection(w.start, w.end)
}
