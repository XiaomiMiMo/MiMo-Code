import { setupTauriBridge } from "./bridge"

// 挂载 Tauri 平台桥接 IPC API
setupTauriBridge()

// 引入渲染层组件与样式 (必须在 setupTauriBridge 之后动态加载)
void import("../../desktop/src/renderer/index")
