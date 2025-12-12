<div align="center" style="margin-bottom: 40px;">
  <img src="docs/assets/logo.png" alt="cui logo" width="150">
</div>

# cui: Common Agent UI (No Auth Version)

[![npm version](https://badge.fury.io/js/cui-no-auth.svg)](https://www.npmjs.com/package/cui-no-auth)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.0.0-brightgreen.svg)](https://nodejs.org/)
[![TypeScript](https://img.shields.io/badge/TypeScript-007ACC?logo=typescript&logoColor=white)](https://www.typescriptlang.org/)
[![Built with React](https://img.shields.io/badge/React-20232A?logo=react&logoColor=61DAFB)](https://reactjs.org/)
[![codecov](https://codecov.io/gh/BMPixel/cui/branch/main/graph/badge.svg)](https://codecov.io/gh/BMPixel/cui)
[![CI](https://github.com/BMPixel/cui/actions/workflows/ci.yml/badge.svg)](https://github.com/BMPixel/cui/actions/workflows/ci.yml)

> **Note:** This is a fork of `cui-server` that includes a flag to bypass authentication and performance optimizations.

## 更新说明 (v0.6.7)

### 1. 架构升级：全栈事件驱动更新 (Event-Driven Architecture)
彻底废弃了基于轮询 (Polling) 的更新机制，引入了基于文件系统监听 (`fs.watch`) 和 SSE (Server-Sent Events) 的实时推送架构。
- **零负载待机**：在没有文件写入时，CPU 和网络消耗几乎为零。
- **秒级实时响应**：一旦检测到日志更新，后端立即通过 SSE 广播通知前端，界面刷新延迟降至 <200ms。
- **Showcase 模式增强**：详情页和列表页均支持无人值守的实时自动更新，完美支持大屏展示或后台任务监控。

### 2. 性能飞跃：详情页加载优化 (O(N) -> O(1))
解决了随着历史记录增多导致详情页打开缓慢的问题。
- **索引优化**：后台 Indexer 现在会将日志文件的绝对路径缓存到 SQLite 数据库中。
- **极速读取**：读取会话详情时不再遍历扫描整个 `projects` 目录，而是直接命中文件路径，实现毫秒级打开。

### 3. 体验与稳定性改进
- **绝对路径显示**：任务列表现在显示完整的项目工作路径，而非简写的目录名。
- **隐藏目录支持**：修复了无法访问或列出隐藏目录 (如 `.temp_repos`) 的问题。
- **列表降噪**：自动过滤内部产生的 `agent-*.jsonl` 子任务日志，保持任务列表纯净。
- **Crash Fix**：修复了 SSE 连接断开时可能导致的 `Response is no longer writable` 报错。

---

## 更新说明 (v0.6.6)

### 1. 性能优化：基于 SQLite 的冷加载策略
在 AI Coding Infrastructure 的背景下，`.claude/projects` 目录下的历史记录日志往往非常庞大（包含大量代码 diff 和上下文）。
- **旧版本**：启动时尝试一次性加载所有历史记录到内存，导致启动极慢甚至 OOM (内存溢出)。
- **新版本**：引入了后台 Indexer 和 SQLite 索引。
  - 列表页直接查询数据库，启动速度不再受历史记录大小影响。
  - 仅在查看具体会话时流式加载文件内容，极大降低内存占用。
  - 首次启动时会在后台自动建立索引，可能会有短暂延迟，之后均为秒开。

### 2. 免登录体验优化 (No-Auth Fix)
修复了 `--skip-auth-token` 模式下的用户体验。
- 现在当前端检测到服务器开启了免登录模式时，会自动跳过 Token 输入界面，直接进入应用。
- 适合本地受信任环境快速开发使用。

---

A modern web UI for your agents. Start the server and access your agents anywhere in your browser. Common Agent UI is powered by [Claude Code SDK](https://claude.ai/code) and supports all kind of LLMs with the most powerful agentic tools.

<div align="center">
  <img src="docs/assets/demo.gif" alt="Demo" width="100%">
</div>

## Highlights

- **🎨 Modern Design**: Polished, responsive UI that works anywhere
- **⚡ Parallel Background Agents**: Stream multiple sessions simultaneously
- **📋 Manage Tasks**: Access all your conversations and fork/resume/archive them
- **🤖 Multi-Model Support**: Enjoy power of agentic workflows with any model
- **🔧 Claude Code Parity**: Familiar autocompletion and interaction with CLI
- **🔔 Push Notifications**: Get notified when your agents are finished
- **🎤 Dictation**: Precise dictation powered by Gemini 2.5 Flash

## Getting Started


1. With Node.js >= 20.19.0, start the server:

    ```bash
    npx cui-no-auth --skip-auth-token
    ```
    or install it globally:
    ```bash
    npm install -g cui-no-auth
    ```

2. Open http://localhost:3001/ in your browser.
    - If you used `--skip-auth-token`, you will enter the app directly.
    - Otherwise, use the token displayed in the output.

3. Choose a model provider:
    - cui works out of the box with if you have logged in to Claude Code or have a valid Anthropic API key in your environment.
    - Or you can go to `settings -> provider` and choose a model provider. cui use [claude-code-router](https://github.com/musistudio/claude-code-router) configurations, supporting different model providers from openrouter to ollama.
4. (Optional) Configure the settings for notifications and dictation.

## Usage

### CLI Options

- `--port <number>`: Specify the port to run the server on (default: 3001 or random available).
- `--host <string>`: Specify the host to bind to (default: localhost).
- `--token <string>`: Specify a custom authentication token.
- `--skip-auth-token`: **(New)** Disable authentication completely. Useful for local trusted environments.

Example:
```bash
cui-server --host 0.0.0.0 --port 8527 --skip-auth-token
```

### Tasks

- **Start a New Task**

  cui automatically scans your existing Claude Code history in `~/.claude/` and displays it on the home page, allowing you to resume any of your previous tasks. The dropdown menu in the input area shows all your previous working directories.

- **Fork a Task**

  To create a branch from an existing task (only supported for tasks started from cui), navigate to the "History" tab on the home page, find the session you want to fork, and resume it with new messages.

- **Manage Tasks**

  Feel free to close the page after starting a task—it will continue running in the background. When running multiple tasks (started from cui), you can check their status in the "Tasks" tab. You can also archive tasks by clicking the "Archive" button. Archived tasks remain accessible in the "Archived" tab.

### Dictation

cui uses [Gemini 2.5 Flash](https://deepmind.google/models/gemini/flash/) to provide highly accurate dictation, particularly effective for long sentences. To enable this feature, you'll need a [Gemini API key](https://aistudio.google.com/apikey) with generous free-tier usage. Set the `GOOGLE_API_KEY` environment variable before starting the server. Note that using this feature will share your audio data with Google.

### Notifications

You can receive push notifications when your task is finished or when Claude is waiting for your permission to use tools. Notifications are sent using either [ntfy](https://ntfy.sh/) or native [web-push](https://www.npmjs.com/package/web-push). To receive them, follow the instructions in the settings.

### Keyboard Shortcuts

More keyboard shortcuts are coming. Currently available:

- `Enter`: Enter a new line
- `Command/Ctrl + Enter`: Send message
- `/`: List all commands
- `@`: List all files in the current working directory

All inline syntaxes like `/init` or `@file.txt` are supported just like in the CLI.

### Remote Access

1. Open `~/.cui/config.json` to set the `server.host` (0.0.0.0) and `server.port`. Alternatively, you can use `--host` and `--port` flags when starting the server.
2. Ensure you use a secure auth token if accessing the server from outside your local network. The auth token is generated when you start the server and can be changed in the `~/.cui/config.json` file.
3. Recommended: Use HTTPS to access the server. You can use a reverse proxy like [Caddy](https://caddyserver.com/) to set this up. On iOS, the dictation feature is only available when using HTTPS.

### Configuration

All configuration and data are stored in `~/.cui/`.

- `config.json` - Server and interface settings
- `session-info.db` - Session metadata

To uninstall cui, simply delete the `~/.cui/` directory and remove the package with `npm uninstall -g cui-no-auth`.

## Contributing

The best way to contribute is to suggest improvements or report bugs in the [issues](https://github.com/BMPixel/cui/issues) and give us a star ⭐!

Before submitting a PR, please make sure you (or your fellow AI) have read [CONTRIBUTING.md](docs/CONTRIBUTING.md).

## Future Roadmap

- **智能任务状态检测**: 目前历史任务默认显示为“完成”。计划升级 Indexer 以分析日志中的退出码或错误信息，从而在列表中明确标记“失败/报错”的任务。
- **本地 LLM 摘要生成**: 既然上游 CLI 的摘要不可靠，计划引入轻量级本地 LLM (如 Gemini Flash) 对长对话进行重新总结，生成更准确的任务标题。