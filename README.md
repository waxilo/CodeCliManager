# CodeCliManager

一个跨平台的 **Claude Code 桌面管理工具**，基于 [Tauri v2](https://v2.tauri.app/) 构建。提供直观的图形界面来管理 Claude Code 会话，支持多模型切换、实时流式对话、API 配置管理等功能。

![CodeCliManager 主界面](public/1783497953868.png)

## ✨ 功能特性

### 核心功能

- **💬 实时流式对话** — 思考过程（Thinking）与回答内容（Answer）分离展示，一目了然
- **🤖 Claude Code GUI** — 图形化管理 Claude Code 会话，告别命令行参数记忆
- **📂 会话管理** — 新建、重命名、删除会话，自动扫描本地会话文件

### AI 增强

- **🧠 模型选择器** — 下拉切换模型（Opus / Sonnet / Haiku / 自定义），自动写入配置文件
- **🔧 多 API 配置** — 支持官方 Claude 订阅与自定义第三方 API，多套配置一键切换
- **📊 上下文指示器** — 实时显示 Token 用量，支持一键压缩上下文
- **⏹️ 任务中断** — 按 `ESC` 键随时中止正在运行的 AI 任务

### 交互体验

- **📝 Markdown 渲染** — 代码语法高亮（highlight.js），代码块一键复制
- **📁 工作目录** — 每个会话可选择独立的工作目录，支持 @ 引用拖入文件
- **📎 文件导入** — 拖拽或点击导入文件/文件夹到工作目录
- **🖼️ 图片粘贴** — 聊天中直接粘贴图片，自动保存并引用
- **💻 终端恢复** — 一键在外部终端中恢复当前会话
- **🎨 暗色/亮色主题** — 跟随系统或手动切换，自动持久化偏好
- **🪟 可调侧边栏** — 侧边栏宽度可拖拽调整，支持折叠

## 🖥️ 平台支持

| 平台    | 架构                  | 状态 |
| ------- | --------------------- | ---- |
| macOS   | Apple Silicon (ARM64) | ✅    |
| macOS   | Intel (x64)           | ✅    |
| Windows | x64                   | ✅    |

## 📦 安装

### macOS

从 [Releases](https://github.com/sloanwang/CodeCliManager/releases) 下载对应的 `.dmg` 文件安装。

> ⚠️ 首次打开如提示"未验证开发者"，请执行以下命令，或在「系统设置 → 隐私与安全性」中允许运行：
>
> ```bash
> xattr -cr /Applications/CodeCliManager.app
> ```

### Windows

从 [Releases](https://github.com/sloanwang/CodeCliManager/releases) 下载 `.msi` 或 `.exe` 安装包。

## 🚀 开发

### 环境要求

- [Node.js](https://nodejs.org/) >= 18
- [Rust](https://www.rust-lang.org/) 稳定版工具链
- [Claude Code CLI](https://docs.anthropic.com/zh-CN/docs/claude-code)（通过 npm 全局安装）

### 快速开始

```bash
# 克隆仓库
git clone https://github.com/sloanwang/CodeCliManager.git
cd CodeCliManager

# 安装前端依赖
npm install

# 启动开发模式（热重载）
npm run tauri dev
```

### 构建

```bash
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`。

### 发布

```bash
# macOS
./fast_push_mac.sh

# Windows PowerShell
.\fast_push_win.ps1
```

推送 `v*` 格式的 tag 后，GitHub Actions 会自动触发构建并创建 Release。

## 🏗️ 技术架构

| 层级        | 技术                                                                                                                           |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------ |
| 桌面框架    | [Tauri v2](https://v2.tauri.app/)                                                                                              |
| 前端        | TypeScript + [Vite](https://vitejs.dev/)                                                                                       |
| 后端        | Rust                                                                                                                           |
| 数据存储    | SQLite（[rusqlite](https://github.com/rusqlite/rusqlite)）                                                                     |
| Markdown    | [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) + [highlight.js](https://highlightjs.org/) |
| HTTP 客户端 | [reqwest](https://docs.rs/reqwest/)                                                                                            |

## 📁 项目结构

```
CodeCliManager/
├── src/                        # 前端源代码
│   ├── main.ts                 # 主应用逻辑（聊天、会话、主题）
│   ├── markdown.ts             # Markdown 渲染、语法高亮
│   ├── styles.css              # 全局样式
│   └── theme.css               # 主题变量（暗色/亮色）
├── src-tauri/                  # Tauri 后端
│   ├── src/
│   │   ├── main.rs             # Rust 入口
│   │   ├── lib.rs              # 核心逻辑：会话管理、流式处理、API 配置
│   │   └── model_fetch.rs      # 模型列表拉取
│   ├── Cargo.toml              # Rust 依赖
│   └── tauri.conf.json         # Tauri 配置
├── .github/workflows/          # CI/CD
│   ├── ci.yml                  # PR 构建检查
│   └── release.yml             # 自动发布
├── index.html                  # 入口 HTML
├── package.json                # 前端依赖与脚本
├── vite.config.ts              # Vite 构建配置
└── tsconfig.json               # TypeScript 配置
```

## 🔄 CI/CD

- **CI**（`ci.yml`）：PR 合并到 `main` 分支时自动构建 macOS ARM64/x64 和 Windows x64
- **Release**（`release.yml`）：推送 `v*` tag 或手动触发时构建所有平台并创建 GitHub Release

## 📝 License

MIT
