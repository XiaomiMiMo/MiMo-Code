import { afterEach, describe, expect } from "bun:test"
import { Effect } from "effect"
import path from "path"
import { Instance } from "../../src/project/instance"
import { Session } from "../../src/session"
import { MessageV2 } from "../../src/session/message-v2"
import { SessionPrompt } from "../../src/session/prompt"
import { Log } from "../../src/util"
import { provideTmpdirServer } from "../fixture/fixture"
import { testEffect } from "../lib/effect"
import { withEnv } from "../lib/env"
import { makeLayer, providerCfg, ref } from "../workflow/lib"

withEnv({ MIMOCODE_DISABLE_BUILTIN_SKILLS: "true", MIMOCODE_DISABLE_COMPOSE_SKILLS: "true" })

void Log.init({ print: false })

afterEach(async () => {
  await Instance.disposeAll()
})

const it = testEffect(makeLayer())

function writeSkill(dir: string, name: string, marker: string) {
  return Effect.promise(() =>
    Bun.write(
      path.join(dir, ".mimocode", "skill", name, "SKILL.md"),
      `---\nname: ${name}\ndescription: ${name} used by multi-skill injection tests.\n---\n\n# ${name}\n\n${marker}\n`,
    ),
  )
}

const injected = (parts: MessageV2.WithParts["parts"]) =>
  parts.flatMap((p) => (p.type === "text" ? (p.text.match(/^<skill_content name="([^"]+)">/)?.[1] ?? []) : []))

// A skill invoked as a slash command routes through SessionPrompt.command,
// while any further skill named in the same message is only reachable by the
// mention scan in insertReminders. Both must end up injected: skill bodies have
// a single owner, so invoking one skill cannot suppress the others.
describe("skill command with additional mentions", () => {
  it.live(
    "injects every mentioned skill when the message is a skill command",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          yield* writeSkill(dir, "skill-alpha", "ALPHA_BODY_MARKER")
          yield* writeSkill(dir, "skill-beta", "BETA_BODY_MARKER")
          yield* Effect.promise(() => Bun.write(path.join(dir, "notes.txt"), "attachment payload\n"))
          yield* llm.text("ok")

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "skill command multi" })

          yield* prompt.command({
            sessionID: session.id,
            command: "skill-alpha",
            arguments: "review @notes.txt and use /skill-beta as well",
            model: `${ref.providerID}/${ref.modelID}`,
          })

          const msgs = yield* sessions.messages({ sessionID: session.id })
          const user = msgs.find((m) => m.info.role === "user")
          expect(user).toBeDefined()

          expect(injected(user!.parts).toSorted()).toEqual(["skill-alpha", "skill-beta"])

          const text = user!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
          expect(text).toContain("ALPHA_BODY_MARKER")
          expect(text).toContain("BETA_BODY_MARKER")
          expect(text).toContain("explicitly referenced multiple skills")
          expect(text).toContain("review @notes.txt")

          // The attachments resolved from the arguments must survive alongside the visible text.
          expect(user!.parts.flatMap((p) => (p.type === "file" ? [p.filename] : []))).toContain("notes.txt")

          yield* sessions.remove(session.id)
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )

  it.live(
    "a lone skill command injects exactly one body and keeps the visible invocation",
    () =>
      provideTmpdirServer(
        Effect.fnUntraced(function* ({ dir, llm }) {
          yield* writeSkill(dir, "skill-alpha", "ALPHA_BODY_MARKER")
          yield* writeSkill(dir, "skill-beta", "BETA_BODY_MARKER")
          yield* llm.text("ok")

          const prompt = yield* SessionPrompt.Service
          const sessions = yield* Session.Service
          const session = yield* sessions.create({ title: "skill command lone" })

          yield* prompt.command({
            sessionID: session.id,
            command: "skill-alpha",
            arguments: "",
            model: `${ref.providerID}/${ref.modelID}`,
          })

          const msgs = yield* sessions.messages({ sessionID: session.id })
          const user = msgs.find((m) => m.info.role === "user")
          expect(user).toBeDefined()

          expect(injected(user!.parts)).toEqual(["skill-alpha"])

          const visible = user!.parts.filter((p) => p.type === "text" && !p.synthetic)
          expect(visible.map((p) => (p.type === "text" ? p.text : ""))).toContain("/skill-alpha")

          const text = user!.parts.flatMap((p) => (p.type === "text" ? [p.text] : [])).join("\n")
          expect(text).not.toContain("BETA_BODY_MARKER")
          expect(text).not.toContain("explicitly referenced multiple skills")

          yield* sessions.remove(session.id)
        }),
        { git: true, config: providerCfg },
      ),
    30_000,
  )
})
