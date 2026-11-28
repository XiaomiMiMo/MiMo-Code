import { describe, expect, test } from "bun:test"
import { mediaToolKind } from "../../src/tool/media-kind"
import { ReadAudioTool, ReadImageTool, ReadVideoTool } from "../../src/tool/read-media"

describe("mediaToolKind", () => {
  test("maps each media read tool to its kind", () => {
    expect(mediaToolKind(ReadImageTool.id)).toBe("image")
    expect(mediaToolKind(ReadAudioTool.id)).toBe("audio")
    expect(mediaToolKind(ReadVideoTool.id)).toBe("video")
  })

  test("is undefined for every other tool id, including prototype keys", () => {
    for (const id of ["read", "view_image", "bash", "read_pdf", "", "toString", "constructor", "__proto__"]) {
      expect(mediaToolKind(id)).toBeUndefined()
    }
  })
})
