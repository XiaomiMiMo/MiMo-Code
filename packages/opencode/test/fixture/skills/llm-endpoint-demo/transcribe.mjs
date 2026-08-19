#!/usr/bin/env node
/**
 * Transcribe an audio file through the endpoint, using nothing but a base_url and a token.
 *
 * The companion to `speak.mjs`, and together they close the loop: synthesize text to audio,
 * feed those exact bytes back, get text. A skill that can do both round trips needs no
 * provider credential at any point — which is the property the whole endpoint exists for.
 *
 * Exit codes are distinct on purpose, because a caller has to tell "ask for a new token"
 * apart from "stop retrying" apart from "the model is wrong for this":
 *   0  transcript written to stdout
 *   1  misconfigured (a variable this script needs was not set)
 *   2  token expired — reissue and retry with the SAME base_url
 *   3  token invalid or revoked — do not retry
 *   4  the endpoint refused the request (wrong model kind, unsupported field, bad upload)
 *   5  upstream failed
 */

import { readFileSync } from "node:fs"

const baseUrl = process.env.OPENAI_BASE_URL
const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_ASR_MODEL

if (!baseUrl || !apiKey || !model) {
  console.error("set OPENAI_BASE_URL, OPENAI_API_KEY and OPENAI_ASR_MODEL")
  process.exit(1)
}

const file = process.argv[2]
if (!file) {
  console.error("usage: transcribe.mjs <audio-file>")
  process.exit(1)
}

// Multipart, because that is what `openai.audio.transcriptions.create({ file, model })`
// builds — this script deliberately speaks the same wire shape a stock client would, so a
// passing test says something about real clients rather than about this script.
const form = new FormData()
form.set("file", new File([readFileSync(file)], file.split("/").pop() ?? "audio.wav", { type: "audio/wav" }))
form.set("model", model)
if (process.env.OPENAI_ASR_LANGUAGE) form.set("language", process.env.OPENAI_ASR_LANGUAGE)

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/audio/transcriptions`, {
  method: "POST",
  headers: { authorization: `Bearer ${apiKey}` },
  body: form,
})

if (!response.ok) {
  const body = await response.text()
  let code
  try {
    code = JSON.parse(body)?.error?.code
  } catch {
    code = undefined
  }
  console.error(`transcription failed: ${response.status} ${body}`)
  if (response.status === 401) process.exit(code === "expired_api_key" ? 2 : 3)
  if (response.status >= 400 && response.status < 500) process.exit(4)
  process.exit(5)
}

const { text } = await response.json()
if (typeof text !== "string" || text.length === 0) {
  console.error("endpoint returned no transcript")
  process.exit(5)
}
process.stdout.write(text)
