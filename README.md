# CodeCliManager

一个跨平台的 **Claude Code 桌面客户端与会话管理工具**，基于 [Tauri 2](https://v2.tauri.app/) 构建。它把 Claude Code 的终端会话、模型/API 配置、文件上下文和权限交互整合到桌面界面中，同时保留在外部终端继续使用同一会话的能力。

![CodeCliManager 主界面](public/1783497953868.png)

## ✨ 功能特性

### Claude Code 对话与会话

- **实时流式对话**：实时展示 Thinking、回答和工具调用结果，支持常驻会话连续追问。
- **模型切换**：在会话中选择 Claude Code 模型；切换模型时会自动处理会话重启和历史模型信息同步。
- **会话管理**：自动读取本地 Claude Code 会话，支持新建、选择、重命名、删除和按工作目录批量清理会话。
- **工作区分组**：按项目目录组织会话，显示运行状态、会话数量和最近活动。
- **搜索与导出**：搜索会话，并将单个会话导出为 Markdown。
- **重试与中断**：支持重新生成、撤销最近一轮，以及使用停止按钮或 `Esc` 中断正在运行的任务。
- **外部终端恢复**：在项目目录中打开终端，或直接执行 `claude --resume` 恢复当前会话。

### 模型、API 与 Kiro

- **多套 API 配置**：管理官方 Claude API 和自定义第三方 API 配置，快速切换当前配置。
- **模型列表同步**：从当前 API 服务获取可用模型，也支持手动选择和保存默认模型。
- **配置导入**：支持从 `cc-switch` 导入 Claude 相关配置方案。
- **Kiro 本地代理**：读取已登录 Kiro IDE 的凭据，在本地启动兼容 Anthropic Messages API 的 Kiro 代理，并同步 Kiro 模型列表。
- **用量与余额信息**：在支持的服务上显示余额或用量；Kiro 和 DeepSeek 等服务的状态可在配置页查看。

> Kiro 功能需要先在本机完成 Kiro IDE 登录。CodeCliManager 不提供或绕过 Kiro 账号登录。

### 文件、Markdown 与工具交互

- **文件上下文**：拖拽或选择文件/文件夹导入当前工作区，并在输入框中使用文件引用。
- **图片粘贴**：直接将剪贴板图片粘贴到聊天输入区，自动保存并作为上下文引用。
- **文件预览**：浏览项目文件、查看文本内容和图片；支持在文件管理器或 Shell 中打开路径。
- **Markdown 渲染**：使用 `marked` 渲染 Markdown，使用 `highlight.js` 展示代码高亮，并提供代码块复制。
- **MCP 管理**：在界面中查看、新增、编辑和删除 Claude Code 的 MCP 服务器配置（用户级 `~/.claude.json`）。
- **权限与交互**：对 Claude Code 的工具权限请求进行允许/拒绝，并支持 `AskUserQuestion` 等交互式问题。
- **权限模式**：在设置中切换 Claude Code 的权限确认策略。

### 桌面体验与更新

- **暗色/亮色主题**：支持手动切换并持久化主题偏好。
- **可调侧边栏**：侧边栏宽度可拖拽调整，也支持折叠；窗口较窄时自动适配。
- **项目状态栏**：显示当前项目的 Git 分支，以及可用时的 API 余额/用量信息。
- **应用自动更新**：从 GitHub Releases 获取签名更新包，在设置中检查、下载和安装新版本。
- **Claude Code 更新**：检查本机 Claude Code CLI 版本，并根据安装方式执行静默更新或提示授权。

## 🖥️ 平台支持

| 平台 | 架构 | 安装包 |
| --- | --- | --- |
| macOS | Apple Silicon (ARM64) | `.dmg` |
| macOS | Intel (x64) | `.dmg` |
| Windows | x64 | `.msi` / NSIS `.exe` |

## 📦 安装

从 [GitHub Releases](https://github.com/waxilo/CodeCliManager/releases) 下载对应平台的安装包。

### macOS

Apple Silicon Mac 下载 ARM64 版本，Intel Mac 下载 x64 版本。首次打开如果 macOS 提示“无法验证开发者”，可以在“系统设置 → 隐私与安全性”中允许打开；也可以执行：

```bash
xattr -cr /Applications/CodeCliManager.app
```

### Windows

根据需要下载 `.msi` 安装包或 NSIS `.exe` 安装包。

### 使用前准备

CodeCliManager 通过本机 Claude Code CLI 执行会话。首次使用前请安装并完成 Claude Code 登录/配置：

```bash
npm install -g @anthropic-ai/claude-code
claude --version
```

应用会从常见安装位置查找 `claude`/`claude.exe`。如果使用自定义安装路径，请确保 Claude Code 位于系统 PATH，或使用应用能识别的用户级安装目录。

## 🚀 开发

### 环境要求

- [Node.js](https://nodejs.org/) 18 或更高版本
- [Rust](https://www.rust-lang.org/) stable 工具链
- macOS 开发需要 Xcode Command Line Tools
- Windows 开发需要 Microsoft C++ Build Tools 和 WebView2
- 本机已安装并配置 Claude Code CLI

### 快速开始

```bash
git clone https://github.com/waxilo/CodeCliManager.git
cd CodeCliManager
npm install
npm run tauri dev
```

仅启动前端 Vite 开发服务器：

```bash
npm run dev
```

### 构建与检查

```bash
# TypeScript 类型检查并构建前端
npm run build

# 构建 Tauri 安装包
npm run tauri build
```

构建产物位于 `src-tauri/target/release/bundle/`，前端静态产物位于 `dist/`。

## 🔖 提交与发布

### 快速提交

快速提交脚本只负责暂存、提交、同步远程和推送，不会升版本或创建 tag：

```bash
# macOS
./fast_push_mac.sh
./fast_push_mac.sh "fix: 说明"

# Windows PowerShell
.\\fast_push_win.ps1
.\\fast_push_win.ps1 "fix: 说明"
```

Windows 也提供 `.bat` 脚本，可在命令提示符中使用对应的 `fast_push_win.bat`。

### 发布新版本

发布脚本会递增 patch 版本、提交版本变更、推送并创建 `v*` tag；GitHub Actions 随后构建并创建 Release：

```bash
# macOS
./fast_release_mac.sh

# Windows PowerShell
.\\fast_release_win.ps1
```

Windows 也提供 `fast_release_win.bat`。

Release workflow 会构建并发布：

- macOS ARM64 `.dmg` 和 updater `.app.tar.gz`
- macOS x64 `.dmg` 和 updater `.app.tar.gz`
- Windows x64 `.msi`、NSIS `.exe` 及 updater 签名
- `latest.json` 更新清单

### 自动更新签名密钥

应用内更新使用 Tauri updater 签名。首次配置发布环境时生成一对签名密钥，并将公钥写入 `src-tauri/tauri.conf.json` 的 `plugins.updater.pubkey`：

```bash
npx tauri signer generate --ci -p "你的私钥密码" -w ~/.tauri/codecli-manager.key
cat ~/.tauri/codecli-manager.key.pub
```

将私钥和密码配置为 GitHub Actions Secrets：

```bash
gh secret set TAURI_SIGNING_PRIVATE_KEY < ~/.tauri/codecli-manager.key
gh secret set TAURI_SIGNING_PRIVATE_KEY_PASSWORD --body "你的私钥密码"
```

> 请勿将私钥提交到仓库。私钥或密码丢失后，无法继续发布可被现有安装自动更新的新版本。

## 🏗️ 技术架构

| 层级 | 技术 |
| --- | --- |
| 桌面框架 | [Tauri 2](https://v2.tauri.app/) |
| 前端 | TypeScript + [Vite](https://vitejs.dev/) |
| 后端 | Rust |
| 数据存储 | SQLite（`rusqlite`）及 Claude Code 本地会话文件 |
| Markdown | [marked](https://marked.js.org/) + [DOMPurify](https://github.com/cure53/DOMPurify) + [highlight.js](https://highlightjs.org/) |
| HTTP 客户端 | [reqwest](https://docs.rs/reqwest/) |
| 更新 | Tauri updater + GitHub Releases |

## 📁 项目结构

```text
CodeCliManager/
├── src/
│   ├── api/                    # Tauri invoke API 封装
│   ├── app/                    # 应用启动、Shell 和窗口渲染
│   ├── events/                 # 会话与后端事件处理
│   ├── features/
│   │   ├── api-config/         # API 配置、配置方案与 Kiro
│   │   ├── chat/               # 对话、模型、流式输出和消息渲染
│   │   ├── conversations/      # 会话加载、选择、编辑、导出和删除
│   │   ├── files/              # 文件导入、预览和附件
│   │   ├── mcp/                # MCP 服务器配置
│   │   ├── permissions/        # 权限请求与交互式问题
│   │   ├── settings/           # 设置页
│   │   ├── sidebar/            # 工作区和会话侧边栏
│   │   ├── status-bar/         # Git 分支与余额/用量状态
│   │   └── updates/            # 应用和 Claude Code 更新
│   ├── state/                  # 前端应用状态
│   ├── styles/                 # 分模块 CSS
│   ├── types/                  # TypeScript 类型
│   └── main.ts                 # 前端入口
├── src-tauri/
│   ├── src/
│   │   ├── claude/             # Claude CLI 启动、流式事件和更新
│   │   ├── commands/           # Tauri 命令入口
│   │   ├── config/              # API、MCP 和本地配置读写
│   │   ├── fs/                  # 文件、目录和 Git 操作
│   │   ├── history/             # Claude 会话历史解析与持久化
│   │   ├── kiro/                # Kiro 认证、转换和本地 HTTP 代理
│   │   ├── session/             # 常驻会话与进程生命周期
│   │   └── lib.rs               # Tauri 应用与命令注册
│   ├── Cargo.toml               # Rust 依赖
│   └── tauri.conf.json          # Tauri、窗口和更新配置
├── .github/workflows/
│   ├── ci.yml                   # 多平台构建检查
│   └── release.yml              # 构建、签名并发布 Release
├── fast_*.sh / fast_*.ps1       # macOS/Windows 提交与发布脚本
├── package.json                 # 前端依赖与 npm scripts
├── vite.config.ts              # Vite 配置
└── tsconfig.json                # TypeScript 配置
```

## 🔄 CI/CD

- **CI**：支持手动触发和提交触发，构建 macOS ARM64、macOS x64 与 Windows x64，关闭 updater 签名以进行构建检查。
- **Release**：支持推送 `v*` tag 或手动触发，构建三种平台产物，生成签名文件和 `latest.json`，并创建或更新 GitHub Release。

## 📝 License

MIT
