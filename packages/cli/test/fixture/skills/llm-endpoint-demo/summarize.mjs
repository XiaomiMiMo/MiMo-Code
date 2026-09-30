#!/usr/bin/env node
/**
 * A deliberately dumb consumer of an OpenAI-compatible endpoint.
 *
 * It exists to prove one thing end to end: something that knows NOTHING about
 * MiMoCode — no provider config, no auth store, no SDK — can do real model work
 * given only two environment variables. Everything it is allowed to know arrives
 * through `OPENAI_BASE_URL` and `OPENAI_API_KEY`.
 *
 * Exit codes are the contract, because a wrapper has to branch on them:
 *   0  success, completion printed on stdout
 *   2  the key aged out — ask for another and retry (`expired_api_key`)
 *   3  the request failed for some other reason
 *   4  the environment was not configured
 *
 * 2 is separated from 3 on purpose. "Fetch a new key" and "stop retrying" are
 * different instructions, and a caller that cannot tell them apart will either
 * give up on a recoverable failure or hammer an unrecoverable one.
 */

const baseUrl = process.env.OPENAI_BASE_URL
const apiKey = process.env.OPENAI_API_KEY
const model = process.env.OPENAI_MODEL

if (!baseUrl || !apiKey || !model) {
  const missing = [
    !baseUrl && "OPENAI_BASE_URL",
    !apiKey && "OPENAI_API_KEY",
    !model && "OPENAI_MODEL",
  ].filter(Boolean)
  process.stderr.write(`missing environment: ${missing.join(", ")}\n`)
  process.exit(4)
}

const prompt = process.argv.slice(2).join(" ") || "Say hello."

const response = await fetch(`${baseUrl.replace(/\/$/, "")}/chat/completions`, {
  method: "POST",
  headers: { "content-type": "application/json", authorization: `Bearer ${apiKey}` },
  body: JSON.stringify({
    model,
    messages: [{ role: "user", content: prompt }],
    max_tokens: 256,
    // Sent unconditionally, exactly as the official OpenAI clients do. If the
    // endpoint rejected these the whole point of pointing a stock client at it
    // would collapse, so leaving them in keeps this script an honest witness.
    store: false,
    parallel_tool_calls: true,
  }),
})

const text = await response.text()

if (!response.ok) {
  let code
  try {
    code = JSON.parse(text)?.error?.code
  } catch {
    code = undefined
  }
  process.stderr.write(`request failed: ${response.status} ${code ?? "unknown"}\n${text}\n`)
  process.exit(code === "expired_api_key" ? 2 : 3)
}

const body = JSON.parse(text)
const content = body?.choices?.[0]?.message?.content
if (typeof content !== "string") {
  process.stderr.write(`unexpected response shape\n${text}\n`)
  process.exit(3)
}

process.stdout.write(content + "\n")
