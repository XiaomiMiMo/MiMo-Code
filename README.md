<h1 align="center">MiMoCode Desktop (macOS GUI)</h1>

<p align="center">
  <img src="assets/readme/mimocode-banner.png" alt="MiMoCode Desktop" width="700">
</p>

<p align="center"><strong>下一代 macOS 原生 AI 编程助手桌面客户端</strong></p>

---

## 💡 为什么做 GUI？(Why GUI)

传统的终端 UI (TUI) 虽然轻量，但在视觉表达和现代操作系统集成上存在局限：
- **视觉表达受限**：终端无法呈现丰富的图表、毛玻璃质感、富文本工具链以及高精度的微交互动画；
- **多模态传图与 UI 复原**：支持直接拖拽/粘贴截图与图片，高效配合 MiMo 大模型的多模态视觉能力，精准复原、设计与对比 UI 界面；
- **系统级集成缺失**：无法完美利用 macOS 原生窗口管理、快捷键传递、系统托盘 (Systray) 及协议唤醒 (Deep Linking)；
- **交互门槛**：GUI 为开发者提供了直观的鼠标/键盘双重体验、非阻塞弹窗与更清晰的代码探索界面。

---

## 🛠️ 技术做法 (Architecture & How)

- 🏗️ **Electron + SolidJS 桌面端架构 (`packages/desktop`)**：使用 Electron 封装响应式 UI (`packages/app`)，兼具 Web 技术的高颜值与原生 Mac 应用的流畅度。
- ⚡ **嵌入式 Headless Server & Sidecar 进程**：内置编译优化的 `node.js` 服务侧进程，通过高并发 IPC 与 `opencode://` 自定义协议与渲染进程通讯。
- 📦 **全量内联打包与原生 C++ 适配**：采用 ESM 静态打包消除第三方 JS 依赖缺失，并通过智能定位与解引用软链完整集成 `@lydell/node-pty` 原生伪终端模块。
- 🔄 **毫秒级 UI 实时热更新 (HMR)**：排除预编译缓存，配置 `packages/ui` 源码全量监听，实现桌面端渲染进程热重载。

---

## ✨ 优势与亮点 (Advantages & Highlights)

1. 🎨 **沉浸式 macOS 现代设计系统**：
   - 支持系统级 Dark / Light 主题跟随；
   - 全局 Modal 引入高透明度毛玻璃暗化蒙层 (`backdrop-filter: blur(6px)` + `rgba(0, 0, 0, 0.45)`)，搭配 `rounded-2xl` 大圆角卡片。
2. ⚙️ **AI 智能体工具活动 1:1 视觉强化 (Tool Activity UI)**：
   - 结构化呈现：`动作谓词 (已分析/已修改)` + `<扩展名 Tag>` + **`文件名 (加粗)`** + `行号/结果 Pill (#L1-160 / 3 个结果)`；
   - 自动归一化解析入参，精准匹配搜索关键词与行号。
3. 📌 **极简 macOS 系统托盘 (Systray)**：
   - 菜单栏轻量化挂载，支持原生控制项 (`Open MiMoCode`, `Quit ⌘Q`)。
4. 🛡️ **交互防抖与按键保护**：
   - 解决侧边栏 Dropdown 菜单 Hover 时的跳动问题，并增加焦点隔离，彻底防止键盘 `Space` / `Enter` 误触关闭弹窗。

---

## 📸 界面预览 (Screenshots)

<p align="center">
  <!-- 预留截图：桌面端主界面 -->
  <img src="assets/readme/desktop-app-main.png" alt="MiMoCode Desktop App" width="700">
  <br>
  <em>桌面端主界面与会话面板 (Desktop App Main Interface)</em>
</p>

<p align="center">
  <!-- 预留截图：工具调用展开样式 -->
  <img src="assets/readme/tool-activity-preview.png" alt="Tool Activity UI" width="700">
  <br>
  <em>AI 智能体工具活动展开视图 (Tool Activity UI)</em>
</p>

<p align="center">
  <!-- 预留截图：毛玻璃弹窗与菜单 -->
  <img src="assets/readme/backdrop-modal-preview.png" alt="Modal & Backdrop Blur" width="700">
  <br>
  <em>沉浸式毛玻璃确认对话框 (Immersive Glass Backdrop Modal)</em>
</p>

---

## 🚀 快速开始 (Development)

```bash
# 安装依赖
bun ci

# 启动桌面端开发服务
bun run --cwd packages/desktop dev

# 本地制作 macOS .app & .dmg 打包产物
bun run --cwd packages/desktop package:mac
```

---

欢迎共享代码 🎉

hello world
