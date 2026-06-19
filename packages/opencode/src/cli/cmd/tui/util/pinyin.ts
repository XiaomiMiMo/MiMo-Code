import { pinyin } from "pinyin-pro"

const CJK = /[㐀-䶿一-鿿豈-﫿]/
const cache = new Map<string, string>()

// Build a romanized, latin-keyboard-typable search string for CJK text so that
// users don't have to switch their input method to find an item. For "切换会话"
// this yields "qiehuanhuihua qie huan hui hua qhhh", matching full pinyin,
// per-syllable pinyin, and the initials. Returns "" for text without CJK so the
// extra fuzzysort key is a no-op for already-latin titles.
export function pinyinSearch(text: string | undefined): string {
  if (!text || !CJK.test(text)) return ""
  const cached = cache.get(text)
  if (cached !== undefined) return cached
  const syllables = pinyin(text, { toneType: "none", type: "array" })
  const initials = pinyin(text, { pattern: "first", toneType: "none", type: "array" }).join("")
  const result = `${syllables.join("")} ${syllables.join(" ")} ${initials}`.toLowerCase()
  cache.set(text, result)
  return result
}
