export type ClipboardContent = {
  data: string
  mime: string
}

export type ClipboardAttachment = {
  filename: string
  content: string
  mime: string
}

export function normalizeClipboardText(text: string) {
  return text.replace(/\r\n/g, "\n").replace(/\r/g, "\n")
}

export async function pasteClipboardContent(input: {
  content: ClipboardContent | undefined
  pasteText: (text: string) => Promise<void>
  pasteAttachment: (file: ClipboardAttachment) => Promise<void>
}) {
  if (!input.content) return false
  if (input.content.mime.startsWith("image/")) {
    await input.pasteAttachment({
      filename: "clipboard",
      mime: input.content.mime,
      content: input.content.data,
    })
    return true
  }
  await input.pasteText(normalizeClipboardText(input.content.data))
  return true
}
