import { Question } from "@/question"
import { QuestionID } from "@/question/schema"
import { Effect, Layer, Schema } from "effect"
import { HttpApi, HttpApiBuilder, HttpApiEndpoint, HttpApiGroup, OpenApi } from "effect/unstable/httpapi"

const root = "/question"

export const QuestionApi = HttpApi.make("question")
  .add(
    HttpApiGroup.make("question")
      .add(
        HttpApiEndpoint.get("list", root, {
          success: Schema.Array(Question.Request),
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.list",
            summary: "List pending questions",
            description: "Get all pending question requests across all sessions.",
          }),
        ),
        HttpApiEndpoint.post("reply", `${root}/:requestID/reply`, {
          params: { requestID: QuestionID },
          payload: Question.Reply,
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reply",
            summary: "Reply to question request",
            description: "Provide answers to a question request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.post("reject", `${root}/:requestID/reject`, {
          params: { requestID: QuestionID },
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.reject",
            summary: "Reject question request",
            description: "Reject a question request from the AI assistant.",
          }),
        ),
        HttpApiEndpoint.get("neverAsk", `${root}/never-ask`, {
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.neverAsk",
            summary: "Get never-ask state",
            description:
              "Whether the question tool auto-resolves to a [Never-Ask] directive instead of blocking for a user.",
          }),
        ),
        HttpApiEndpoint.post("setNeverAsk", `${root}/never-ask`, {
          payload: Schema.Struct({ enabled: Schema.Boolean }),
          success: Schema.Boolean,
        }).annotateMerge(
          OpenApi.annotations({
            identifier: "question.setNeverAsk",
            summary: "Set never-ask state",
            description:
              "Enable or disable never-ask: the question tool stays visible but returns a [Never-Ask] directive so the model resolves decisions itself.",
          }),
        ),
      )
      .annotateMerge(
        OpenApi.annotations({
          title: "question",
          description: "Question routes.",
        }),
      ),
  )
  .annotateMerge(
    OpenApi.annotations({
      title: "opencode HttpApi",
      version: "0.0.1",
      description: "Effect HttpApi surface for instance routes.",
    }),
  )

export const questionHandlers = Layer.unwrap(
  Effect.gen(function* () {
    const svc = yield* Question.Service

    const list = Effect.fn("QuestionHttpApi.list")(function* () {
      return yield* svc.list()
    })

    const reply = Effect.fn("QuestionHttpApi.reply")(function* (ctx: {
      params: { requestID: QuestionID }
      payload: Question.Reply
    }) {
      yield* svc.reply({
        requestID: ctx.params.requestID,
        answers: ctx.payload.answers,
      })
      return true
    })

    const reject = Effect.fn("QuestionHttpApi.reject")(function* (ctx: { params: { requestID: QuestionID } }) {
      yield* svc.reject(ctx.params.requestID)
      return true
    })

    const neverAsk = Effect.fn("QuestionHttpApi.neverAsk")(function* () {
      return yield* svc.neverAsk()
    })

    const setNeverAsk = Effect.fn("QuestionHttpApi.setNeverAsk")(function* (ctx: { payload: { enabled: boolean } }) {
      yield* svc.setNeverAsk(ctx.payload.enabled)
      return yield* svc.neverAsk()
    })

    return HttpApiBuilder.group(QuestionApi, "question", (handlers) =>
      handlers
        .handle("list", list)
        .handle("reply", reply)
        .handle("reject", reject)
        .handle("neverAsk", neverAsk)
        .handle("setNeverAsk", setNeverAsk),
    )
  }),
).pipe(Layer.provide(Question.defaultLayer))
