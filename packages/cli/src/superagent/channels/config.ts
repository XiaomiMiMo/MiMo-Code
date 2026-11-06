import { readFile, realpath } from "node:fs/promises"
import z from "zod"
import * as Channels from "../channel"
import { GithubChannel, GithubConfig } from "./github"
import { FeishuChannel, FeishuConfig } from "./feishu"

const Config = z
  .array(z.discriminatedUnion("kind", [GithubConfig, FeishuConfig]))
  .refine((items) => new Set(items.map((i) => i.id)).size === items.length, "Channel IDs must be unique")
const installed = new Set<string>()
export async function loadConfiguredChannels(directory?: string) {
  const file = process.env.MIMOCODE_SUPERAGENT_CHANNELS
  if (!file) return
  const config = Config.parse(JSON.parse(await readFile(file, "utf8")))
  const entries = await Promise.all(
    config.map(async (item) => ({ ...item, directory: await realpath(item.directory) })),
  )
  try {
    for (const entry of entries) {
      if (directory && entry.directory !== directory) continue
      if (installed.has(entry.id)) continue
      await Channels.register({
        id: entry.id,
        directory: entry.directory,
        allowedSenders:
          entry.kind === "github" ? entry.allowedSenders.map((s) => s.toLowerCase()) : entry.allowedSenders,
        allowedThreads: entry.kind === "github" ? [entry.repository] : entry.chats,
        adapter: entry.kind === "github" ? new GithubChannel(entry) : new FeishuChannel(entry),
      })
      installed.add(entry.id)
    }
  } catch (error) {
    await stopConfiguredChannels()
    throw error
  }
}
export async function stopConfiguredChannels() {
  for (const id of installed) await Channels.unregister(id)
  installed.clear()
}
