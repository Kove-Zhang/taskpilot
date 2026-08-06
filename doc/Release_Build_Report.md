# Release 版本编译报告

**编译时间**: 2026-08-04  
**构建状态**: 成功 (Success)  

---

## 1. 产物列表

### 独立可执行程序 (Executable)
- [app.exe](file:///c:/MyCode/Tempdir/Taskpliot/task-pilot/src-tauri/target/release/app.exe)

### 安装包产物 (Bundles)
1. **NSIS 安装程序 (Setup EXE)**:
   - [task-pilot_0.1.0_x64-setup.exe](file:///c:/MyCode/Tempdir/Taskpliot/task-pilot/src-tauri/target/release/bundle/nsis/task-pilot_0.1.0_x64-setup.exe)
2. **MSI 安装包**:
   - [task-pilot_0.1.0_x64_en-US.msi](file:///c:/MyCode/Tempdir/Taskpliot/task-pilot/src-tauri/target/release/bundle/msi/task-pilot_0.1.0_x64_en-US.msi)

---

## 2. 编译耗时与指标

- **前端 (Vite + TypeScript)**: ~5.36 秒
- **后端 (Rust Release Profile)**: ~54.27 秒
- **打包格式**: NSIS (.exe) 与 MSI (.msi)

---

## 3. 构建环境与命令
- **打包命令**: `pwsh -Command "npx tauri build"`
- **包含组件**: React 19, TypeScript, TailwindCSS v4, Tauri 2.x
