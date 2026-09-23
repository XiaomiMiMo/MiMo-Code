import { Effect } from "effect"
import { PlannotatorHooks } from "./hooks"
import { Question } from "../../question"

/**
 * Tích hợp Plannotator vào quy trình compose của MiMo-Code.
 */
export const PlannotatorWorkflow = Effect.gen(function* () {
  const hooks = yield* PlannotatorHooks
  const question = yield* Question.Service

  return {
    /**
     * Chèn bước review kế hoạch vào quy trình.
     */
    reviewPlan: (plan: string, taskTitle: string) => 
      Effect.gen(function* () {
        const feedback = yield* hooks.beforeExecution(plan, taskTitle)
        
        if (feedback.approval_status === "approved") {
          return { status: "approved", feedback }
        } else if (feedback.approval_status === "rejected") {
          return { status: "rejected", feedback }
        } else {
          return { status: "dismissed", feedback }
        }
      }),

    /**
     * Chèn bước review mã nguồn vào quy trình.
     */
    reviewCode: (diff: string, description: string) => 
      Effect.gen(function* () {
        const feedback = yield* hooks.afterImplementation(diff, description)
        return feedback
      })
  }
})
