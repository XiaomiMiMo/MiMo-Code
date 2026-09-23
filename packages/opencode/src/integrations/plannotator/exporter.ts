import { Instance } from "../../project/instance"
import path from "path"

/**
 * Chuyển đổi kế hoạch của MiMo-Code sang định dạng Markdown tương thích với Plannotator.
 */
export function exportPlan(planContent: string, taskTitle: string): string {
  const header = `# Task\n\n${taskTitle}\n\n# Plan\n\n`
  
  // Kiểm tra nếu kế hoạch đã có tiêu đề hoặc định dạng Markdown phù hợp
  if (planContent.trim().startsWith("#")) {
    return `${header}${planContent}`
  }

  return `${header}${planContent}`
}
