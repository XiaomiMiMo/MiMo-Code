# Hướng dẫn Tích hợp Plannotator vào MiMo-Code

Tài liệu này hướng dẫn cách sử dụng và cấu trúc của module tích hợp Plannotator trong MiMo-Code.

## 1. Cấu trúc thư mục
Module tích hợp nằm tại `packages/opencode/src/integrations/plannotator/`:
- `exporter.ts`: Chuyển đổi kế hoạch MiMo sang Markdown.
- `importer.ts`: Phân tích phản hồi từ Plannotator.
- `review_client.ts`: Giao tiếp với CLI Plannotator.
- `hooks.ts`: Các điểm móc cho quy trình lập kế hoạch và thực thi.
- `skill.ts`: Workflow cấp cao để sử dụng trong MiMo-Code.

## 2. Cách thức hoạt động

### 2.1. Đánh giá kế hoạch (Plan Review)
Khi một kế hoạch được tạo ra, nó sẽ được gửi đến Plannotator qua lệnh `opencode-plan`. Người dùng sẽ thấy một giao diện web để phê duyệt hoặc yêu cầu thay đổi.
- **Approve**: MiMo-Code tiếp tục thực thi.
- **Reject**: MiMo-Code nhận phản hồi và quay lại bước lập kế hoạch.

### 2.2. Đánh giá mã nguồn (Code Review)
Sau khi mã nguồn được viết, MiMo-Code có thể gửi `git diff` đến Plannotator qua lệnh `opencode-review`.

### 2.3. Lưu trữ dữ liệu (Dataset Generation)
Mọi tương tác đều được lưu lại tại `datasets/plannotator_feedback/` dưới dạng JSON để phục vụ việc huấn luyện mô hình trong tương lai.

## 3. Cài đặt
Đảm bảo `plannotator` đã được cài đặt trong hệ thống và có thể truy cập từ dòng lệnh.
```bash
curl -fsSL https://plannotator.ai/install.sh | bash
```

## 4. Sử dụng trong Skill Compose
Bạn có thể gọi `PlannotatorWorkflow.reviewPlan` trong các skill như `compose:plan` để kích hoạt việc đánh giá.

```typescript
import { PlannotatorWorkflow } from "../../integrations/plannotator/skill"

// Trong logic lập kế hoạch
const result = yield* PlannotatorWorkflow.reviewPlan(planContent, taskTitle)
if (result.status === "approved") {
  // Tiếp tục
}
```
