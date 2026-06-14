export const RETRY_STATUS_MESSAGE_LIMIT = 80

export function formatRetryStatusMessage(message: string) {
  if (message.includes("exceeded your current quota") && message.includes("gemini")) {
    return {
      message: "gemini is way too hot right now",
      truncated: false,
    }
  }

  const singleLine = message.replace(/\s+/g, " ").trim()
  const truncated = singleLine.length > RETRY_STATUS_MESSAGE_LIMIT

  return {
    message: truncated ? singleLine.slice(0, RETRY_STATUS_MESSAGE_LIMIT) + "..." : singleLine,
    truncated: truncated || singleLine !== message,
  }
}
