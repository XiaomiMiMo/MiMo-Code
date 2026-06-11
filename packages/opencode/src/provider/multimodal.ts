import type { ModelMessage } from "ai"
import { generateText } from "ai"
import type * as Provider from "./provider"
import { Log } from "@/util"

const log = Log.create({ service: "multimodal" })

interface MultimodalPart {
  type: "image" | "file"
  data: string
  mediaType: string
  filename?: string
}

function extractMultimodalParts(messages: ModelMessage[]): {
  parts: MultimodalPart[]
  messages: ModelMessage[]
} {
  const parts: MultimodalPart[] = []
  const cleaned = messages.map((msg) => {
    if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

    const newContent = msg.content.map((part) => {
      if (part.type === "image") {
        const imageStr = String(part.image)
        const mime = imageStr.startsWith("data:")
          ? imageStr.split(";")[0].replace("data:", "")
          : "image/png"
        parts.push({
          type: "image",
          data: imageStr,
          mediaType: mime,
        })
        return {
          type: "text" as const,
          text: `[Image: processing with vision model...]`,
        }
      }
      if (part.type === "file") {
        const mime = part.mediaType
        if (mime.startsWith("image/") || mime === "application/pdf") {
          parts.push({
            type: "file",
            data: typeof part.data === "string" ? part.data : String(part.data),
            mediaType: mime,
            filename: part.filename,
          })
          return {
            type: "text" as const,
            text: `[File "${part.filename}": processing with vision model...]`,
          }
        }
      }
      return part
    })
    return { ...msg, content: newContent }
  })
  return { parts, messages: cleaned }
}

function buildVisionPrompt(parts: MultimodalPart[]): string {
  const descriptions: string[] = []
  for (const part of parts) {
    if (part.type === "image") {
      descriptions.push("Please describe this image in detail, including any text, code, diagrams, or other relevant content.")
    } else if (part.type === "file") {
      if (part.mediaType === "application/pdf") {
        descriptions.push(`Please describe the content of this PDF file "${part.filename}" in detail.`)
      } else {
        descriptions.push(`Please describe the content of this file "${part.filename}" in detail.`)
      }
    }
  }
  return descriptions.join("\n\n")
}

export async function processMultimodalWithVision(
  messages: ModelMessage[],
  visionModel: Provider.Model,
  getLanguage: (model: Provider.Model) => Promise<any>,
): Promise<ModelMessage[]> {
  const { parts, messages: cleanedMessages } = extractMultimodalParts(messages)

  if (parts.length === 0) return messages

  log.info("processing multimodal content with vision model", {
    modelID: visionModel.id,
    partCount: parts.length,
  })

  try {
    const language = await getLanguage(visionModel)
    const prompt = buildVisionPrompt(parts)

    const visionMessages: ModelMessage[] = [
      {
        role: "user",
        content: [
          ...parts.map((part) => {
            if (part.type === "image") {
              return {
                type: "image" as const,
                image: part.data,
              }
            }
            return {
              type: "file" as const,
              data: part.data,
              mediaType: part.mediaType,
              filename: part.filename,
            }
          }),
          {
            type: "text" as const,
            text: prompt,
          },
        ],
      },
    ]

    const result = await generateText({
      model: language,
      messages: visionMessages,
      maxTokens: 4096,
    })

    const description = result.text
    const usage = result.usage
    log.info("vision model processing complete", {
      descriptionLength: description.length,
      promptTokens: usage.promptTokens,
      completionTokens: usage.completionTokens,
      totalTokens: usage.totalTokens,
    })

    // 在描述末尾附加用量信息，方便主模型和用户看到开销
    const usageTag = `\n[vision: ${visionModel.id} | ${usage.promptTokens} in / ${usage.completionTokens} out / ${usage.totalTokens} total]`

    return cleanedMessages.map((msg) => {
      if (msg.role !== "user" || !Array.isArray(msg.content)) return msg

      const newContent = msg.content.map((part) => {
        if (part.type === "text" && typeof part.text === "string") {
          if (part.text.includes("[Image: processing with vision model...]")) {
            return {
              type: "text" as const,
              text: part.text.replace(
                "[Image: processing with vision model...]",
                `[Image description from vision model]:\n${description}${usageTag}`,
              ),
            }
          }
          if (part.text.includes("[File") && part.text.includes("processing with vision model...]")) {
            return {
              type: "text" as const,
              text: part.text.replace(
                /processing with vision model\.\.\.\]/,
                `processed by vision model]:\n${description}${usageTag}`,
              ),
            }
          }
        }
        return part
      })
      return { ...msg, content: newContent }
    })
  } catch (error) {
    log.error("vision model processing failed", { error })
    return messages
  }
}

export function shouldUseVisionModel(
  model: Provider.Model,
  visionModelRef: string | undefined,
): boolean {
  if (!visionModelRef) return false
  if (model.capabilities.input.image) return false
  return true
}

export function getVisionModel(
  visionModelRef: string,
  providers: Record<string, Provider.Info>,
): Provider.Model | undefined {
  const [providerID, ...rest] = visionModelRef.split("/")
  const modelID = rest.join("/")
  if (!providerID || !modelID) return undefined

  const provider = providers[providerID]
  if (!provider) return undefined
  return provider.models[modelID]
}

export * as Multimodal from "./multimodal"
