import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import * as BashInteractive from "@/tool/bash-interactive"
import z from "zod"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const ReplyInput = z.object({
  output: z.string().describe("Captured output from the interactive command"),
  exitCode: z.number().describe("Exit code of the interactive command"),
})

export const BashInteractiveRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending interactive bash requests",
        description: "Get all pending interactive bash requests waiting for user interaction.",
        operationId: "bash.interactive.list",
        responses: {
          200: {
            description: "List of pending interactive requests",
            content: {
              "application/json": {
                schema: resolver(
                  z.array(
                    z.object({
                      id: z.string(),
                      command: z.string(),
                      cwd: z.string(),
                      description: z.string(),
                    }),
                  ),
                ),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("BashInteractiveRoutes.list", c, function* () {
          const svc = yield* BashInteractive.Service
          return yield* svc.list()
        }),
    )
    .post(
      "/:id/reply",
      describeRoute({
        summary: "Reply to interactive bash request",
        description: "Provide the result of an interactive bash command execution.",
        operationId: "bash.interactive.reply",
        responses: {
          200: {
            description: "Reply accepted",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator("param", z.object({ id: z.string() })),
      validator("json", ReplyInput),
      async (c) =>
        jsonRequest("BashInteractiveRoutes.reply", c, function* () {
          const params = c.req.valid("param")
          const json = c.req.valid("json")
          const svc = yield* BashInteractive.Service
          yield* svc.reply({
            id: params.id,
            output: json.output,
            exitCode: json.exitCode,
          })
          return true
        }),
    ),
)
