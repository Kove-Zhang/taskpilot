# Task Pilot

Task Pilot 是一款基于 Tauri + React 构建的现代化桌面效率工具。它能够像 Spotlight 或 uTools 一样随时唤出，利用 AI 大模型的能力，从您杂乱的文本、剪贴板、截图甚至各种文档中智能提取结构化的待办事项（To-Do），并一键同步至您的 Notion 数据库。

## ✨ 核心特性

- **🚀 沉浸式桌面体验**：无边框透明背景设计，随用随唤。点击外部区域自动隐藏，不打扰您的正常工作流。
- **🧠 AI 智能提取**：接入兼容 OpenAI 格式的大模型 API，将毫无头绪的文字、会议记录一键转化为清晰的待办列表。
- **🖼️ 视觉与 OCR 支持**：支持直接截取屏幕或粘贴图片，通过大模型视觉能力识别并提取图片中的任务信息。
- **📄 多格式文件解析**：支持直接拖拽 PDF、Word (DOCX)、Excel (XLSX/XLS)、CSV、Markdown 及 TXT 等常见文档进行内容解析。
- **📝 Notion 无缝同步**：结构化的任务将直接推送到您指定的 Notion Database，实现任务管理闭环。
- **✨ AI 智能润色**：内置 Prompt 优化助手，帮助您更好地向 AI 表达提取诉求，确保提取结果精准符合业务规范。
- **🕰️ 本地历史记录**：自动记录任务处理历史，随时防丢查阅或重载以往的提取结果。
- **🔒 安全与隐私**：所有 API Key、Notion Token 均严格保存在本地系统中，绝不在代码和云端留存任何敏感密钥。

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

## 📄 许可证

本项目基于 MIT 协议开源。
