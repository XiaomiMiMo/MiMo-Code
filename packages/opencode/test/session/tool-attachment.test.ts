import { describe, expect, test } from "bun:test"
import type { Provider } from "../../src/provider"
import { ModelID, ProviderID } from "../../src/provider/schema"
import {
  inlineToolAttachment,
  routeToolAttachment,
  toolAttachmentFilename,
  toolAttachmentPlaceholder,
} from "../../src/session/tool-attachment"

function makeModel(input: {
  npm: string
  id?: string
  image?: boolean
  audio?: boolean
  video?: boolean
  pdf?: boolean
}): Provider.Model {
  return {
    id: ModelID.make(input.id ?? "test-model"),
    providerID: ProviderID.make("test"),
    api: {
      id: input.id ?? "test-model",
      url: "https://example.com",
      npm: input.npm,
    },
    name: "Test Model",
    capabilities: {
      temperature: true,
      reasoning: false,
      attachment: true,
      toolcall: true,
      input: {
        text: true,
        image: input.image ?? false,
        audio: input.audio ?? false,
        video: input.video ?? false,
        pdf: input.pdf ?? false,
      },
      output: { text: true, image: false, audio: false, video: false, pdf: false },
      interleaved: false,
    },
    cost: { input: 0, output: 0, cache: { read: 0, write: 0 } },
    limit: { context: 0, input: 0, output: 0 },
    status: "active",
    options: {},
    headers: {},
    release_date: "2026-01-01",
  }
}

const attachment = (mime: string) => ({
  mime,
  url: `data:${mime};base64,Zm9v`,
  filename: `result.${mime.split("/")[1]}`,
})

describe("session tool attachment routing", () => {
  test("uses only OpenAI-compatible input formats that the adapter accepts", () => {
    const model = makeModel({
      npm: "@ai-sdk/openai-compatible",
      image: true,
      audio: true,
      pdf: true,
    })

    expect(routeToolAttachment({ model, attachment: attachment("image/png"), allowNative: true })).toBe("synthetic")
    expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: true })).toBe("synthetic")
    expect(routeToolAttachment({ model, attachment: attachment("audio/ogg"), allowNative: true })).toBe("placeholder")
    expect(routeToolAttachment({ model, attachment: attachment("application/octet-stream"), allowNative: true })).toBe(
      "placeholder",
    )
    expect(routeToolAttachment({ model, attachment: attachment("image/svg+xml"), allowNative: true })).toBe(
      "placeholder",
    )
  })

  test("does not send audio or text files through the OpenAI Responses adapter", () => {
    for (const npm of ["@ai-sdk/openai", "@ai-sdk/azure"]) {
      const model = makeModel({ npm, image: true, audio: true, pdf: true })

      expect(routeToolAttachment({ model, attachment: attachment("image/png"), allowNative: false })).toBe("synthetic")
      expect(routeToolAttachment({ model, attachment: attachment("application/pdf"), allowNative: false })).toBe(
        "synthetic",
      )
      expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: false })).toBe(
        "placeholder",
      )
      expect(routeToolAttachment({ model, attachment: attachment("text/plain"), allowNative: false })).toBe(
        "placeholder",
      )
    }
  })

  test("keeps supported Anthropic files native only for successful tool results", () => {
    const model = makeModel({ npm: "@ai-sdk/anthropic", image: true, audio: true, pdf: true })

    expect(routeToolAttachment({ model, attachment: attachment("image/jpeg"), allowNative: true })).toBe("native")
    expect(routeToolAttachment({ model, attachment: attachment("application/pdf"), allowNative: true })).toBe("native")
    expect(routeToolAttachment({ model, attachment: attachment("image/jpeg"), allowNative: false })).toBe("synthetic")
    expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: false })).toBe("placeholder")
  })

  test("uses Gemini 3 native multimodal tool results and synthetic error files", () => {
    const model = makeModel({
      npm: "@ai-sdk/google",
      id: "gemini-3-pro-preview",
      audio: true,
      video: true,
    })

    expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: true })).toBe("native")
    expect(routeToolAttachment({ model, attachment: attachment("video/mp4"), allowNative: true })).toBe("native")
    expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: false })).toBe("synthetic")

    const prefixed = makeModel({
      npm: "@ai-sdk/google",
      id: "proxy/gemini-3-pro-preview",
      audio: true,
    })
    expect(routeToolAttachment({ model: prefixed, attachment: attachment("audio/wav"), allowNative: true })).toBe(
      "synthetic",
    )
    const modelsPrefixed = makeModel({ npm: "@ai-sdk/google", id: "models/gemini-3-pro-preview", audio: true })
    expect(routeToolAttachment({ model: modelsPrefixed, attachment: attachment("audio/wav"), allowNative: true })).toBe(
      "synthetic",
    )
    const uppercase = makeModel({ npm: "@ai-sdk/google", id: "GEMINI-3-PRO-PREVIEW", audio: true })
    expect(routeToolAttachment({ model: uppercase, attachment: attachment("audio/wav"), allowNative: true })).toBe(
      "synthetic",
    )
  })

  test("downgrades files disabled by model capabilities", () => {
    const model = makeModel({ npm: "@ai-sdk/openai-compatible" })

    expect(routeToolAttachment({ model, attachment: attachment("image/png"), allowNative: false })).toBe("placeholder")
    expect(routeToolAttachment({ model, attachment: attachment("audio/wav"), allowNative: false })).toBe("placeholder")
  })

  test("limits Bedrock synthetic text files to media types supported by its adapter", () => {
    const model = makeModel({ npm: "@ai-sdk/amazon-bedrock" })

    expect(routeToolAttachment({ model, attachment: attachment("text/plain"), allowNative: false })).toBe("synthetic")
    expect(routeToolAttachment({ model, attachment: attachment("text/css"), allowNative: false })).toBe("placeholder")
  })

  test("extracts base64 payloads for native tool-result content", () => {
    expect(inlineToolAttachment(attachment("image/png"))).toEqual({
      data: "Zm9v",
      mediaType: "image/png",
    })
    expect(inlineToolAttachment({ mime: "image/png", url: "https://example.com/image.png" })).toBeUndefined()
    expect(inlineToolAttachment({ mime: "image/png", url: "data:image/png;base64," })).toBeUndefined()
    expect(inlineToolAttachment({ mime: "image/png", url: "data:audio/wav;base64,Zm9v" })).toBeUndefined()
  })

  test("sanitizes untrusted resource URIs used as attachment names", () => {
    const dataURI = {
      mime: "application/octet-stream",
      url: "data:application/octet-stream;base64,Zm9v",
      filename: "  data:application/octet-stream;base64,AQIDBAUGBwgJ  ",
    }

    expect(toolAttachmentPlaceholder(dataURI)).toBe(
      '[Tool attachment "data URI (application/octet-stream)" (application/octet-stream) was retained but cannot be safely sent to this model/provider.]',
    )
    expect(toolAttachmentPlaceholder(dataURI)).not.toContain("AQIDBAUGBwgJ")
    expect(toolAttachmentFilename(dataURI)).toBeUndefined()
    expect(
      toolAttachmentFilename({
        mime: "image/png",
        url: "data:image/png;base64,Zm9v",
        filename: "mcp://files/screenshot.png?token=secret",
      }),
    ).toBe("screenshot.png")
  })
})
