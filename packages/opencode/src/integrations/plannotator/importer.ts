/**
 * Phân tích phản hồi từ Plannotator.
 */
export interface PlannotatorFeedback {
  comments: string[]
  changes_requested: string[]
  approval_status: "approved" | "rejected" | "dismissed"
}

export function importFeedback(plannotatorOutput: any): PlannotatorFeedback {
  const decision = plannotatorOutput.decision
  const feedback = plannotatorOutput.feedback || ""
  
  const result: PlannotatorFeedback = {
    comments: [],
    changes_requested: [],
    approval_status: "dismissed"
  }

  if (decision === "submitted") {
    result.approval_status = plannotatorOutput.result?.approved ? "approved" : "rejected"
    if (feedback) {
      result.comments.push(feedback)
      if (result.approval_status === "rejected") {
        result.changes_requested.push(feedback)
      }
    }
  } else if (decision === "dismissed") {
    result.approval_status = "dismissed"
  }

  return result
}
