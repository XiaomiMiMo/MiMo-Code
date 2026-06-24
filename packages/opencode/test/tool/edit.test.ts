import { afterAll, afterEach, describe, test, expect } from "bun:test"
import path from "path"
import fs from "fs/promises"
import { Effect, Layer, ManagedRuntime } from "effect"
import { EditTool } from "../../src/tool/edit"
import { Instance } from "../../src/project/instance"
import { tmpdir } from "../fixture/fixture"
import { LSP } from "../../src/lsp"
import { AppFileSystem } from "@mimo-ai/shared/filesystem"
import { Format } from "../../src/format"
import { Agent } from "../../src/agent/agent"
import { Bus } from "../../src/bus"
import { BusEvent } from "../../src/bus/bus-event"
import { Truncate } from "../../src/tool"
import { SessionID, MessageID, PartID } from "../../src/session/schema"
import type { MessageV2 } from "../../src/session/message-v2"

const baseCtx = {
  sessionID: SessionID.make("ses_test-edit-session"),
  messageID: MessageID.make(""),
  callID: "",
  agent: "build",
  abort: AbortSignal.any([]),
  messages: [] as MessageV2.WithParts[],
  metadata: () => Effect.void,
  ask: () => Effect.void,
}

type EditCtx = typeof baseCtx

function withRead(filePath: string, ctx: EditCtx = baseCtx): EditCtx {
  const messageID = MessageID.make("msg_read")
  return {
    ...ctx,
    messages: [
      {
        info: {
          id: messageID,
          sessionID: ctx.sessionID,
          role: "assistant",
        },
        parts: [
          {
            id: PartID.make("part_read"),
            messageID,
            sessionID: ctx.sessionID,
            type: "tool",
            tool: "read",
            callID: "call_read",
            state: {
              status: "completed",
              input: { file_path: filePath },
              output: "",
              title: `Read ${filePath}`,
              metadata: {},
              time: { start: 0, end: 0 },
            },
          },
        ],
      },
    ] as unknown as MessageV2.WithParts[],
  }
}

const ctx = baseCtx

afterEach(async () => {
  await Instance.disposeAll()
})

const runtime = ManagedRuntime.make(
  Layer.mergeAll(
    LSP.defaultLayer,
    AppFileSystem.defaultLayer,
    Format.defaultLayer,
    Bus.layer,
    Truncate.defaultLayer,
    Agent.defaultLayer,
  ),
)

afterAll(async () => {
  await runtime.dispose()
})

const resolve = () =>
  runtime.runPromise(
    Effect.gen(function* () {
      const info = yield* EditTool
      return yield* info.init()
    }),
  )

const subscribeBus = <D extends BusEvent.Definition>(def: D, callback: () => unknown) =>
  runtime.runPromise(Bus.Service.use((bus) => bus.subscribeCallback(def, callback)))

async function onceBus<D extends BusEvent.Definition>(def: D) {
  const result = Promise.withResolvers<void>()
  const unsub = await subscribeBus(def, () => {
    unsub()
    result.resolve()
  })
  return {
    wait: result.promise,
    unsub,
  }
}

describe("tool.edit", () => {
  describe("creating new files", () => {
    test("creates new file when oldString is empty", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "newfile.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          const result = await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "",
                new_string: "new content",
              },
              ctx,
            ),
          )

          expect(result.metadata.diff).toContain("new content")

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("new content")
        },
      })
    })

    test("creates new file with nested directories", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nested", "dir", "file.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "",
                new_string: "nested file",
              },
              ctx,
            ),
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("nested file")
        },
      })
    })

    test("emits add event for new files", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "new.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { FileWatcher } = await import("../../src/file/watcher")

          const updated = await onceBus(FileWatcher.Event.Updated)

          try {
            const edit = await resolve()
            await Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "",
                  new_string: "content",
                },
                ctx,
              ),
            )

            await updated.wait
          } finally {
            updated.unsub()
          }
        },
      })
    })
  })

  describe("editing existing files", () => {
    test("replaces text in existing file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "existing.txt")
      await fs.writeFile(filepath, "old content here", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          const result = await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "old content",
                new_string: "new content",
              },
              withRead(filepath),
            ),
          )

          expect(result.output).toContain("Edit applied successfully")

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("new content here")
        },
      })
    })

    test("throws error when file does not exist", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "nonexistent.txt")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await expect(
            Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "old",
                  new_string: "new",
                },
                withRead(filepath),
              ),
            ),
          ).rejects.toThrow("not found")
        },
      })
    })

    test("throws error when oldString equals newString", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await expect(
            Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "same",
                  new_string: "same",
                },
                ctx,
              ),
            ),
          ).rejects.toThrow("identical")
        },
      })
    })

    test("throws error when oldString not found in file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "actual content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await expect(
            Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "not in file",
                  new_string: "replacement",
                },
                withRead(filepath),
              ),
            ),
          ).rejects.toThrow()
        },
      })
    })

    test("replaces all occurrences with replaceAll option", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "foo bar foo baz foo", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "foo",
                new_string: "qux",
                replace_all: true,
              },
              withRead(filepath),
            ),
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("qux bar qux baz qux")
        },
      })
    })

    test("emits change event for existing files", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "original", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const { FileWatcher } = await import("../../src/file/watcher")

          const updated = await onceBus(FileWatcher.Event.Updated)

          try {
            const edit = await resolve()
            await Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "original",
                  new_string: "modified",
                },
                withRead(filepath),
              ),
            )

            await updated.wait
          } finally {
            updated.unsub()
          }
        },
      })
    })
  })

  describe("edge cases", () => {
    test("handles multiline replacements", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "line1\nline2\nline3", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "line2",
                new_string: "new line 2\nextra line",
              },
              withRead(filepath),
            ),
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("line1\nnew line 2\nextra line\nline3")
        },
      })
    })

    test("handles CRLF line endings", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "line1\r\nold\r\nline3", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "old",
                new_string: "new",
              },
              withRead(filepath),
            ),
          )

          const content = await fs.readFile(filepath, "utf-8")
          expect(content).toBe("line1\r\nnew\r\nline3")
        },
      })
    })

    test("throws error when oldString equals newString", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "content", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await expect(
            Effect.runPromise(
              edit.execute(
                {
                  file_path: filepath,
                  old_string: "",
                  new_string: "",
                },
                ctx,
              ),
            ),
          ).rejects.toThrow("identical")
        },
      })
    })

    test("throws error when path is directory", async () => {
      await using tmp = await tmpdir()
      const dirpath = path.join(tmp.path, "adir")
      await fs.mkdir(dirpath)

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          await expect(
            Effect.runPromise(
              edit.execute(
                {
                  file_path: dirpath,
                  old_string: "old",
                  new_string: "new",
                },
                withRead(dirpath),
              ),
            ),
          ).rejects.toThrow("directory")
        },
      })
    })

    test("tracks file diff statistics", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "line1\nline2\nline3", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          const result = await Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "line2",
                new_string: "new line a\nnew line b",
              },
              withRead(filepath),
            ),
          )

          expect(result.metadata.filediff).toBeDefined()
          expect(result.metadata.filediff.file).toBe(filepath)
          expect(result.metadata.filediff.additions).toBeGreaterThan(0)
        },
      })
    })
  })

  describe("line endings", () => {
    const old = "alpha\nbeta\ngamma"
    const next = "alpha\nbeta-updated\ngamma"
    const alt = "alpha\nbeta\nomega"

    const normalize = (text: string, ending: "\n" | "\r\n") => {
      const normalized = text.replaceAll("\r\n", "\n")
      if (ending === "\n") return normalized
      return normalized.replaceAll("\n", "\r\n")
    }

    const count = (content: string) => {
      const crlf = content.match(/\r\n/g)?.length ?? 0
      const lf = content.match(/\n/g)?.length ?? 0
      return {
        crlf,
        lf: lf - crlf,
      }
    }

    const expectLf = (content: string) => {
      const counts = count(content)
      expect(counts.crlf).toBe(0)
      expect(counts.lf).toBeGreaterThan(0)
    }

    const expectCrlf = (content: string) => {
      const counts = count(content)
      expect(counts.lf).toBe(0)
      expect(counts.crlf).toBeGreaterThan(0)
    }

    type Input = {
      content: string
      old_string: string
      new_string: string
      replace_all?: boolean
    }

    const apply = async (input: Input) => {
      await using tmp = await tmpdir({
        init: async (dir) => {
          await Bun.write(path.join(dir, "test.txt"), input.content)
        },
      })

      return await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          const filePath = path.join(tmp.path, "test.txt")
          await Effect.runPromise(
            edit.execute(
              {
                file_path: filePath,
                old_string: input.old_string,
                new_string: input.new_string,
                replace_all: input.replace_all,
              },
              withRead(filePath),
            ),
          )
          return await Bun.file(filePath).text()
        },
      })
    }

    test("preserves LF with LF multi-line strings", async () => {
      const content = normalize(old + "\n", "\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\n"),
        new_string: normalize(next, "\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\n"))
      expectLf(output)
    })

    test("preserves CRLF with CRLF multi-line strings", async () => {
      const content = normalize(old + "\n", "\r\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\r\n"),
        new_string: normalize(next, "\r\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\r\n"))
      expectCrlf(output)
    })

    test("preserves LF when old/new use CRLF", async () => {
      const content = normalize(old + "\n", "\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\r\n"),
        new_string: normalize(next, "\r\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\n"))
      expectLf(output)
    })

    test("preserves CRLF when old/new use LF", async () => {
      const content = normalize(old + "\n", "\r\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\n"),
        new_string: normalize(next, "\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\r\n"))
      expectCrlf(output)
    })

    test("preserves LF when newString uses CRLF", async () => {
      const content = normalize(old + "\n", "\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\n"),
        new_string: normalize(next, "\r\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\n"))
      expectLf(output)
    })

    test("preserves CRLF when newString uses LF", async () => {
      const content = normalize(old + "\n", "\r\n")
      const output = await apply({
        content,
        old_string: normalize(old, "\r\n"),
        new_string: normalize(next, "\n"),
      })
      expect(output).toBe(normalize(next + "\n", "\r\n"))
      expectCrlf(output)
    })

    test("preserves LF with mixed old/new line endings", async () => {
      const content = normalize(old + "\n", "\n")
      const output = await apply({
        content,
        old_string: "alpha\nbeta\r\ngamma",
        new_string: "alpha\r\nbeta\nomega",
      })
      expect(output).toBe(normalize(alt + "\n", "\n"))
      expectLf(output)
    })

    test("preserves CRLF with mixed old/new line endings", async () => {
      const content = normalize(old + "\n", "\r\n")
      const output = await apply({
        content,
        old_string: "alpha\r\nbeta\ngamma",
        new_string: "alpha\nbeta\r\nomega",
      })
      expect(output).toBe(normalize(alt + "\n", "\r\n"))
      expectCrlf(output)
    })

    test("replaceAll preserves LF for multi-line blocks", async () => {
      const blockOld = "alpha\nbeta"
      const blockNew = "alpha\nbeta-updated"
      const content = normalize(blockOld + "\n" + blockOld + "\n", "\n")
      const output = await apply({
        content,
        old_string: normalize(blockOld, "\n"),
        new_string: normalize(blockNew, "\n"),
        replace_all: true,
      })
      expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\n"))
      expectLf(output)
    })

    test("replaceAll preserves CRLF for multi-line blocks", async () => {
      const blockOld = "alpha\nbeta"
      const blockNew = "alpha\nbeta-updated"
      const content = normalize(blockOld + "\n" + blockOld + "\n", "\r\n")
      const output = await apply({
        content,
        old_string: normalize(blockOld, "\r\n"),
        new_string: normalize(blockNew, "\r\n"),
        replace_all: true,
      })
      expect(output).toBe(normalize(blockNew + "\n" + blockNew + "\n", "\r\n"))
      expectCrlf(output)
    })
  })

  describe("concurrent editing", () => {
    test("preserves concurrent edits to different sections of the same file", async () => {
      await using tmp = await tmpdir()
      const filepath = path.join(tmp.path, "file.txt")
      await fs.writeFile(filepath, "top = 0\nmiddle = keep\nbottom = 0\n", "utf-8")

      await Instance.provide({
        directory: tmp.path,
        fn: async () => {
          const edit = await resolve()
          let asks = 0
          const firstAsk = Promise.withResolvers<void>()
          const delayedCtx = {
            ...withRead(filepath),
            ask: () =>
              Effect.gen(function* () {
                asks++
                if (asks !== 1) return
                firstAsk.resolve()
                yield* Effect.promise(() => Bun.sleep(50))
              }),
          }

          const promise1 = Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "top = 0",
                new_string: "top = 1",
              },
              delayedCtx,
            ),
          )

          await firstAsk.promise

          const promise2 = Effect.runPromise(
            edit.execute(
              {
                file_path: filepath,
                old_string: "bottom = 0",
                new_string: "bottom = 2",
              },
              delayedCtx,
            ),
          )

          const results = await Promise.allSettled([promise1, promise2])
          expect(results[0]?.status).toBe("fulfilled")
          expect(results[1]?.status).toBe("fulfilled")
          expect(await fs.readFile(filepath, "utf-8")).toBe("top = 1\nmiddle = keep\nbottom = 2\n")
        },
      })
    })
  })
})
