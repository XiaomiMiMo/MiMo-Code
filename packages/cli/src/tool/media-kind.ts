// Dependency-free on purpose: the TUI and `mimo run` label media tool calls
// with it without loading the tool runtime.

export type MediaKind = "image" | "audio" | "video"

export const MEDIA_TOOL_IDS = {
  image: "read_image",
  audio: "read_audio",
  video: "read_video",
} as const satisfies Record<MediaKind, string>

const KINDS = new Map<string, MediaKind>(
  (Object.entries(MEDIA_TOOL_IDS) as Array<[MediaKind, string]>).map(([kind, id]) => [id, kind]),
)

/** The input modality of a media read tool id, or undefined for any other tool. */
export function mediaToolKind(id: string): MediaKind | undefined {
  return KINDS.get(id)
}
