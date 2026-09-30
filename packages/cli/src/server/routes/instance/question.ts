import { Hono } from "hono"
import { describeRoute, validator } from "hono-openapi"
import { resolver } from "hono-openapi"
import { QuestionID } from "@/question/schema"
import { Question } from "@/question"
import z from "zod"
import { errors } from "../../error"
import { lazy } from "@/util/lazy"
import { jsonRequest } from "./trace"

const Reply = z.object({
  answers: Question.Answer.zod
    .array()
    .describe("User answers in order of questions (each answer is an array of selected labels)"),
})

export const QuestionRoutes = lazy(() =>
  new Hono()
    .get(
      "/",
      describeRoute({
        summary: "List pending questions",
        description: "Get all pending question requests across all sessions.",
        operationId: "question.list",
        responses: {
          200: {
            description: "List of pending questions",
            content: {
              "application/json": {
                schema: resolver(Question.Request.zod.array()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("QuestionRoutes.list", c, function* () {
          const svc = yield* Question.Service
          return yield* svc.list()
        }),
    )
    .get(
      "/never-ask",
      describeRoute({
        summary: "Get never-ask state",
        description:
          "Whether the question tool auto-resolves to a [Never-Ask] directive instead of blocking for a user.",
        operationId: "question.neverAsk",
        responses: {
          200: {
            description: "Current never-ask state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
        },
      }),
      async (c) =>
        jsonRequest("QuestionRoutes.neverAsk", c, function* () {
          const svc = yield* Question.Service
          return yield* svc.neverAsk()
        }),
    )
    .post(
      "/never-ask",
      describeRoute({
        summary: "Set never-ask state",
        description:
          "Enable or disable never-ask: the question tool stays visible but returns a [Never-Ask] directive so the model resolves decisions itself.",
        operationId: "question.setNeverAsk",
        responses: {
          200: {
            description: "Updated never-ask state",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400),
        },
      }),
      validator("json", z.object({ enabled: z.boolean().describe("Whether never-ask is enabled") })),
      async (c) =>
        jsonRequest("QuestionRoutes.setNeverAsk", c, function* () {
          const svc = yield* Question.Service
          yield* svc.setNeverAsk(c.req.valid("json").enabled)
          return yield* svc.neverAsk()
        }),
    )
    .post(
      "/:requestID/reply",
      describeRoute({
        summary: "Reply to question request",
        description: "Provide answers to a question request from the AI assistant.",
        operationId: "question.reply",
        responses: {
          200: {
            description: "Question answered successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: QuestionID.zod,
        }),
      ),
      validator("json", Reply),
      async (c) =>
        jsonRequest("QuestionRoutes.reply", c, function* () {
          const params = c.req.valid("param")
          const json = c.req.valid("json")
          const svc = yield* Question.Service
          yield* svc.reply({
            requestID: params.requestID,
            answers: json.answers,
          })
          return true
        }),
    )
    .post(
      "/:requestID/reject",
      describeRoute({
        summary: "Reject question request",
        description: "Reject a question request from the AI assistant.",
        operationId: "question.reject",
        responses: {
          200: {
            description: "Question rejected successfully",
            content: {
              "application/json": {
                schema: resolver(z.boolean()),
              },
            },
          },
          ...errors(400, 404),
        },
      }),
      validator(
        "param",
        z.object({
          requestID: QuestionID.zod,
        }),
      ),
      async (c) =>
        jsonRequest("QuestionRoutes.reject", c, function* () {
          const params = c.req.valid("param")
          const svc = yield* Question.Service
          yield* svc.reject(params.requestID)
          return true
        }),
    ),
)
