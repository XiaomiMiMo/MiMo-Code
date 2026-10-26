# Báo cáo Kiến trúc: Tích hợp Plannotator vào MiMo-Code

## 1. Tổng quan
Mục tiêu của dự án là tích hợp Plannotator vào MiMo-Code như một lớp đánh giá và lập kế hoạch có sự tham gia của con người (human-in-the-loop). Điều này cho phép người dùng xem xét, chú thích và phê duyệt các kế hoạch do MiMo-Code tạo ra trước khi thực thi, cũng như đánh giá mã nguồn sau khi triển khai.

## 2. Phân tích hiện trạng

### 2.1. MiMo-Code
MiMo-Code là một trợ lý lập trình AI chạy trên terminal, hỗ trợ nhiều agent (build, plan, compose).
- **Quy trình lập kế hoạch (Planning Pipeline):** MiMo-Code sử dụng agent `plan` và các skill trong `compose` (như `compose:plan`) để tạo ra các kế hoạch triển khai dưới dạng Markdown. Các kế hoạch này thường được lưu trong `docs/compose/plans/`.
- **Quy trình thực thi (Execution Pipeline):** Sau khi kế hoạch được tạo, agent `build` hoặc skill `compose:execute` / `compose:subagent` sẽ thực thi các bước trong kế hoạch.
- **Quy trình kiểm tra/xác minh (Verification Pipeline):** Các skill như `compose:review` và `compose:verify` được sử dụng để kiểm tra mã nguồn sau khi thực thi.

### 2.2. Plannotator
Plannotator là một công cụ đánh giá dựa trên trình duyệt dành cho các AI coding agents.
- **Quy trình đánh giá kế hoạch:** Nhận đầu vào là nội dung Markdown của kế hoạch, hiển thị giao diện người dùng để chú thích và trả về quyết định (approve/deny) cùng với phản hồi.
- **Quy trình đánh giá mã nguồn:** Nhận đầu vào là git diff hoặc URL của Pull Request, hiển thị giao diện đánh giá mã nguồn và trả về phản hồi.
- **Điểm tích hợp:** Plannotator cung cấp CLI (ví dụ: `plannotator opencode-plan`, `plannotator opencode-review`) có thể được gọi thông qua các lệnh shell.

## 3. Kiến trúc tích hợp đề xuất

Để đáp ứng yêu cầu giảm thiểu sửa đổi kiến trúc lõi của MiMo-Code, chúng tôi đề xuất xây dựng một module tích hợp (adapter/wrapper) tại `packages/opencode/src/integrations/plannotator/`.

### 3.1. Các thành phần chính

1. **`exporter.ts`**: Chuyển đổi đầu ra kế hoạch của MiMo-Code thành định dạng Markdown tương thích với Plannotator.
2. **`importer.ts`**: Phân tích các chú thích và phản hồi từ Plannotator, chuyển đổi thành cấu trúc dữ liệu mà MiMo-Code có thể hiểu được.
3. **`review_client.ts`**: Wrapper để gọi CLI của Plannotator (sử dụng `ChildProcess` hoặc `CrossSpawnSpawner` của MiMo-Code).
4. **`hooks.ts`**: Cung cấp các điểm móc (hooks) `before_execution(plan)` và `after_implementation(diff)` để chèn vào quy trình làm việc của MiMo-Code.

### 3.2. Quy trình làm việc (Workflow)

```text
User Task
    ↓
MiMo Plan Generation (compose:plan)
    ↓
Plannotator Plan Review (hooks.before_execution)
    ↓
Approval / Revision (importer.ts xử lý phản hồi)
    ↓
MiMo Execution (compose:execute / build agent)
    ↓
Tests (compose:verify)
    ↓
Git Diff Generation (Git.diff)
    ↓
Plannotator Code Review (hooks.after_implementation)
    ↓
MiMo Revision Loop (nếu có phản hồi từ review)
```

## 4. Đánh giá rủi ro và độ phức tạp

- **Rủi ro:** Việc gọi CLI của Plannotator có thể bị chặn (block) luồng thực thi của MiMo-Code nếu không được xử lý bất đồng bộ đúng cách.
- **Độ phức tạp:** Trung bình. Việc tạo module tích hợp khá độc lập, nhưng việc chèn hooks vào quy trình `compose` hiện tại đòi hỏi sự cẩn thận để không làm hỏng các luồng hiện có.
- **Giải pháp:** Sử dụng thư viện `effect` (đang được MiMo-Code sử dụng rộng rãi) để quản lý các tác vụ bất đồng bộ và lỗi khi gọi Plannotator CLI.

## 5. Kế hoạch triển khai

1. Tạo thư mục `packages/opencode/src/integrations/plannotator/`.
2. Triển khai các tệp `exporter.ts`, `importer.ts`, `review_client.ts`, và `hooks.ts`.
3. Cập nhật `packages/opencode/src/skill/compose/.bundle/execute/SKILL.md` hoặc tạo một workflow mới để tích hợp các hooks.
4. Xây dựng pipeline tạo bộ dữ liệu (Dataset Generation) lưu trữ tại `datasets/plannotator_feedback/`.
5. Viết tài liệu hướng dẫn và kiểm thử.
