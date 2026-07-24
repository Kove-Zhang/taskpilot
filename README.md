# Task Pilot

Task Pilot 是一款基于 Tauri + React 构建的现代化桌面效率工具。它能够像 Spotlight 或 uTools 一样随时唤出，利用 AI 大模型的能力，从您杂乱的文本、剪贴板、截图甚至各种文档中智能提取结构化的待办事项（To-Do），并一键同步至您的 Notion 数据库。

## ✨ 核心特性

- **🚀 沉浸式桌面体验**：无边框透明背景设计，随用随唤。点击外部区域自动隐藏，不打扰您的正常工作流。
- **🧠 深度大模型支持与“防思考”黑魔法**：完美兼容 o1、o3-mini、claude-3.7、deepseek-reasoner 等支持深度推理的模型。支持在设置中一键开启/关闭**深度思考模式**。关闭时底层会自动注入降级参数与独创的 `/no_think` 末端压制指令，极大提升响应速度并节省 Token。
- **🖼️ 视觉与 OCR 支持**：支持直接截取屏幕或粘贴图片，通过大模型视觉能力识别并提取图片中的任务信息。点击缩略图可开启高清灯箱预览，细节一览无遗。
- **📄 纯本地离线文档解析**：支持直接拖拽 PDF、Word (DOCX)、Excel (XLSX/XLS)、CSV、Markdown 及 TXT 等常见文档进行解析。所有解析逻辑（包括 PDF Worker）均 100% 本地打包执行，**无任何外部 CDN 依赖，保障数据绝对安全与隐私**。
- **📝 Notion 动态属性映射**：自动获取您 Notion Database 的所有字段（Properties）。支持您自由勾选需要同步的字段、自定义 AI 提取提示词，并通过可视化的**沙盒 UI 预览**和拖拽排序来自由拼装您的专属待办结构。
- **✨ AI 智能润色与写作**：内置 Prompt 优化助手，并在提取待办后支持基于 AI 生成项目总结、跟进邮件或行动计划。
- **⌨️ 快捷键自定义**：支持用户随时在设置中重定义全局唤醒快捷键，防止与系统快捷键冲突，并且支持一键恢复默认。
- **🕰️ 本地历史与原图追溯**：自动记录任务处理历史，不仅防丢，更支持在历史记录中重新查阅提取前的原始文本材料与历史截图。
- **🔒 高级安全与排错架构**：所有敏感数据采用 Rust 底层 `Aes256Gcm` 硬件加密保存在本地。同时配备了全参数透明的本地底层日志系统（Logger），为您排查大模型 API 调用问题保驾护航。

## 🛠️ 技术栈

- **桌面端核心**：[Tauri v2](https://v2.tauri.app/) (Rust)
- **前端框架**：React 18 + TypeScript + Vite
- **状态管理**：Zustand
- **样式方案**：Tailwind CSS + 玻璃拟态 (Glassmorphism) UI 设计
- **Markdown渲染**：React Markdown + Tailwind Typography
- **文件解析引擎**：pdfjs-dist (PDF), mammoth (Word), xlsx (Excel/CSV)

## 📦 安装与开发

### 环境依赖
确保您的电脑已安装：
- [Node.js](https://nodejs.org/) (>= 18)
- [Rust](https://www.rust-lang.org/tools/install) (>= 1.70)

### 本地运行
```bash
# 1. 克隆项目
git clone https://github.com/Kove-Zhang/taskpilot.git
cd taskpilot

# 2. 安装前端依赖
npm install

# 3. 启动开发调试环境
npm run tauri dev
```

### 构建打包
```bash
# 编译并打包出适用于您当前操作系统的桌面安装包 (.exe / .dmg / .AppImage)
npm run tauri build
```

## ⚙️ 初始化配置

初次启动应用后，请点击界面右上角的“设置 ⚙️”按钮进行基本配置：

1. **大模型设置**：填入兼容 OpenAI API 标准的接口地址 (Base URL)、API Key 及模型名称。
2. **提取关注点**：设定您个人的核心诉求（例如：“务必提取负责人和截止时间”），或使用系统内置的 **AI 智能润色** 帮您完善 Prompt。
3. **Notion 集成**：
   - 填入您的 Notion Integration Token。
   - 填入目标 Database ID。
   - **注意**：请务必在您的 Notion 目标 Database 页面右上角的 `Connections` 菜单中，将该 Integration 添加为允许访问。
4. **系统、日志与控制**：可在此查阅或修改应用的全局唤醒快捷键（默认 `Alt+Space`），控制是否“允许大模型进入深度思考模式”，以及开启本地日志（将打印发送给大模型的全量 Payload）以便高级排查。

## 📄 许可证

本项目基于 MIT 协议开源。
