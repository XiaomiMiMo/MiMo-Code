#!/usr/bin/env node
/**
 * The speech half of the demo: text in, audio bytes out, over the same local
 * endpoint and the same throwaway token as the chat half.
 *
 * Kept as its own script rather than a flag on `summarize.mjs` because that is how
 * a real skill is shaped — one action per entry point — and because it keeps the
 * exit-code contract per action rather than overloading one.
 *
 * Exit codes:
 *   0  success; wrote the audio file, printed "<bytes> <content-type> <path>"
 *   2  the key aged out — ask for another and retry (`expired_api_key`)
 *   3  the request failed for some other reason
 *   4  the environment was not configured
 *   5  this model/provider cannot synthesize speech (`unsupported_capability`)
 *
 * 5 is separate from 3 because it is not a transient failure and not a key
 * problem: no amount of retrying or re-issuing fixes it. The fix is to choose a
 * different model, which is a decision for whoever configured the task.
 */

import { writeFile } from "node:fs/promises"

const baseUrl = process.env.OPENAI_BASE_URL
const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_TTS_MODEL
const out = process.env.OPENAI_TTS_OUT

if (!baseUrl || !apiKey || !model || !out) {
  const missing = [
    !baseUrl && "OPENAI_BASE_URL",
    !apiKey && "OPENAI_API_KEY",
    !model && "OPENAI_TTS_MODEL",
    !out && "OPENAI_TTS_OUT",
  ].filter(Boolean)
  process.stderr.write(`missing environment: ${missing.join(", ")}\n`)
  process.exit(4)
}

const text = process.argv.slice(2).join(" ") || "Hello from the demo skill."

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/speech`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    input: text,
    voice: process.env.OPENAI_TTS_VOICE || "alloy",
    response_format: process.env.OPENAI_TTS_FORMAT || "wav",
  }),
})

if (!response.ok) {
  const body = await response.text()
  let code
  try {
    code = JSON.parse(body)?.error?.code
  } catch {
    code = undefined
  }
  process.stderr.write(`request failed: ${response.status} ${code ?? "unknown"}\n${body}\n`)
  if (code === "expired_api_key") process.exit(2)
  if (code === "unsupported_capability") process.exit(5)
  process.exit(3)
}

const audio = Buffer.from(await response.arrayBuffer())
if (audio.byteLength === 0) {
  process.stderr.write("endpoint returned an empty body\n")
  process.exit(3)
}

await writeFile(out, audio)
// The content type is reported rather than assumed: the provider decides what it
// actually produced, which may not be the format that was requested.
process.stdout.write(`${audio.byteLength} ${response.headers.get("content-type")} ${out}\n`)
