import { Effect } from "effect"
import { makeReviewClient } from "./review_client"
import { exportPlan } from "./exporter"
import { importFeedback, PlannotatorFeedback } from "./importer"
import { AppFileSystem } from "../../file"
import path from "path"

export const PlannotatorHooks = Effect.gen(function* () {
  const client = yield* makeReviewClient
  const fsys = yield* AppFileSystem.Service

  const saveToDataset = (data: any) => Effect.gen(function* () {
    const datasetDir = "datasets/plannotator_feedback"
    yield* fsys.mkdir(datasetDir, { recursive: true })
    const filename = `${Date.now()}.json`
    yield* fsys.write(path.join(datasetDir, filename), JSON.stringify(data, null, 2))
  })

  return {
    beforeExecution: (plan: string, taskTitle: string) => 
      Effect.gen(function* () {
        const exportedPlan = exportPlan(plan, taskTitle)
        const output = yield* client.submitPlan(exportedPlan)
        const feedback = importFeedback(output)
        
        yield* saveToDataset({
          type: "plan_review",
          task: taskTitle,
          original_plan: plan,
          review_comments: feedback.comments.join("\n"),
          approval: feedback.approval_status === "approved"
        })

        return feedback
      }),

    afterImplementation: (diff: string, description: string) => 
      Effect.gen(function* () {
        const output = yield* client.submitDiff(diff, description)
        const feedback = importFeedback(output)

        yield* saveToDataset({
          type: "code_review",
          code_diff: diff,
          review_comments: feedback.comments.join("\n"),
          approval: feedback.approval_status === "approved"
        })

        return feedback
      })
  }
})
