# CUI Server - Claude Code 实时监控平台

<div align="center">

**基于 Claude Code 的 Web 化实时日志监控系统**

[![npm version](https://badge.fury.io/js/cui-no-auth.svg)](https://www.npmjs.com/package/cui-no-auth)
[![Node.js Version](https://img.shields.io/badge/node-%3E%3D20.19.0-brightgreen.svg)](https://nodejs.org/)
[![License](https://img.shields.io/badge/license-Apache%202.0-blue.svg)](LICENSE)

[快速开始](#快速开始) · [核心特性](#核心特性) · [系统要求](#系统要求) · [部署指南](#部署指南)

</div>

---

## 项目简介

CUI Server 是一个为 Claude Code 设计的 **Web 化实时监控平台**，让你通过浏览器随时查看 AI 任务的执行状态。

### 核心价值

- **实时监控**：新会话创建、对话进度，秒级可见（< 2 秒延迟）
- **Web 化**：无需终端，浏览器访问，随时随地查看
- **协同化**：多人可同时查看同一任务进度，团队协作利器
- **高性能**：按需监控，支持 1000+ 历史会话，内存占用 < 100MB

### 应用场景

```
场景 1：后台任务监控
  终端运行 Claude 分析项目 → 打开浏览器查看实时进度 → 无需守在终端前

场景 2：团队协作
  开发者 A 运行测试 → 开发者 B 在浏览器查看进度 → QA 也能同时监控

场景 3：日志中心
  所有 Claude 会话统一管理 → 搜索、过滤、归档 → 可追溯的执行历史
```

---

## 核心特性

### 🚀 实时监控系统（v0.7.0 新增）

#### 1. 首页自动发现新会话

```
[终端] claude "分析代码"
   ↓ 1-2 秒
[浏览器] 首页自动出现新会话 ✨
```

- ✅ 无需手动刷新
- ✅ 延迟 < 2 秒
- ✅ 事件驱动，零轮询

#### 2. 详情页实时追踪对话

```
[点击] 会话详情
   ↓
[实时] 看到 Claude 输出流（像 terminal 一样）
   ↓
[关闭] 详情页 → 自动停止监控
```

- ✅ 按需监控（Page In/Out）
- ✅ 增量读取（不重复解析）
- ✅ 延迟 < 1 秒

#### 3. 无限滚动 + 智能更新

```
[首页] 显示最近 20 个会话
   ↓
[滚动] 自动加载更多（21-40, 41-60...）
   ↓
[已加载会话] 有更新 → 自动刷新 ✨
```

- ✅ 支持 1000+ 历史会话
- ✅ 已加载会话实时更新
- ✅ 性能优化（虚拟滚动）

#### 4. 多客户端协同

- ✅ 多人同时查看同一会话
- ✅ 共享监控（资源节省）
- ✅ 所有人实时同步

### 📊 技术架构

#### 双层监控策略

```
Layer 1: 轻量监控（DirectoryWatcher）
  ├─ 监控所有会话文件（1000+）
  ├─ 只读元数据（前 50KB）
  ├─ 检测新会话 + 元数据变化
  └─ 广播给所有客户端（SSE）

Layer 2: 深度监控（ContentWatcher）
  ├─ 按需监控（用户打开详情）
  ├─ 增量读取新消息
  ├─ 推送给订阅者
  └─ 自动清理（关闭详情时）
```

#### 性能对比

| 指标 | 优化前 | 优化后 | 提升 |
|-----|--------|--------|------|
| 监控文件数 | 1377（失效） | 0-50（动态） | **96% ↓** |
| 新会话发现 | ∞（需刷新） | < 2 秒 | **实时** |
| 详情更新 | N/A | < 1 秒 | **实时** |
| 内存占用 | ~50MB | ~60MB | 持平 |

### 🌐 环境变量/代理预设（v0.7.3 新增）

每个会话可独立配置代理和环境变量，解决不同模型需要不同代理的问题：

```
[设置] ⚙️ → Environment Tab → 创建预设
  ├─ "Clash"     → proxy: http://127.0.0.1:7897
  ├─ "公司VPN"   → proxy: http://10.0.0.1:8080
  └─ "第三方API" → ANTHROPIC_BASE_URL + API_KEY

[新建/继续会话] 底部选择预设
  [~/project ▾]  [Opus ▾]  [🌐 Clash ▾]  [Yolo ▾][▶]
```

- 预设存储在 `~/.cui/config.json`
- 环境变量透传给 Claude CLI 子进程
- 继续会话时默认 bypassPermissions 模式

### 🔍 目录过滤（v0.7.3 新增）

选择工作目录后，会话列表自动过滤为该目录下的会话：

```
[选择目录: ~/work/my-project]
  ↓ 自动过滤
[仅显示 my-project 的会话]
```

### 💾 ToolMetrics 持久化（v0.7.3 新增）

代码改动统计（+N/-M）现在持久化到 SQLite，CUI 重启后不再丢失。

### 🛡️ OOM 修复（v0.7.3）

修复了 3 个内存泄漏，长时间运行不再 OOM：
- Logger childLoggers 按日清理
- ToolMetrics 7 天 TTL 自动回收
- Resume 大消息数组及时释放

### 🎯 其他特性

- **🎨 现代化界面**：响应式设计，支持桌面和移动端
- **⚡ 并行任务**：同时运行多个 Claude 会话
- **📋 任务管理**：查看、恢复、归档历史会话
- **🤖 多模型支持**：支持 Claude、GPT、Gemini、Ollama 等
- **🔧 CLI 兼容**：与 Claude Code CLI 完全兼容
- **🔔 推送通知**：任务完成后浏览器通知
- **🎤 语音输入**：支持 Gemini / GLM 语音识别

---

## 系统要求

### 最小要求

| 组件 | 要求 | 说明 |
|-----|------|------|
| **操作系统** | Linux (kernel >= 2.6.13) | macOS 也支持 |
| **Node.js** | >= 20.19.0 | [安装指南](#nodejs-安装) |
| **内存** | >= 512MB | 推荐 1GB |
| **磁盘** | >= 1GB | 存储会话历史和索引 |

### 编译环境（仅首次安装时需要）

| 组件 | 用途 | 必需性 |
|-----|------|--------|
| **Python 3** | 编译 better-sqlite3 | ✅ 必需 |
| **GCC/G++** | 编译原生模块 | ✅ 必需 |
| **Make** | 构建工具 | ✅ 必需 |

### Linux 发行版兼容性

| 发行版 | 状态 | 说明 |
|--------|------|------|
| Ubuntu 20.04+ | ✅ 完全支持 | 推荐 |
| Debian 11+ | ✅ 完全支持 | 推荐 |
| CentOS 8+ | ✅ 完全支持 | - |
| RHEL 8+ | ✅ 完全支持 | - |
| Fedora 35+ | ✅ 完全支持 | - |
| Alpine Linux | ⚠️ 需额外配置 | 需安装 build 工具 |
| Amazon Linux 2 | ✅ 完全支持 | - |

### 依赖检查

运行依赖检查脚本：

```bash
bash scripts/check-dependencies.sh
```

输出示例：
```
✅ Node.js: 20.19.0
✅ npm: 10.2.0
✅ Python 3: 3.10.12
✅ gcc (Ubuntu 11.4.0-1ubuntu1~22.04) 11.4.0
✅ GNU Make 4.3
✅ Linux Kernel: 5.15.0
✅ inotify 支持：max_user_watches = 524288

✅ 所有依赖检查通过！
```

---

## 快速开始

### 方式 1：NPX 快速启动（推荐）

```bash
# 直接运行（无需安装）
npx cui-no-auth --host 0.0.0.0 --port 8526 --skip-auth-token
```

打开浏览器：http://localhost:8526

### 方式 2：全局安装

```bash
# 安装
npm install -g cui-no-auth

# 启动
cui-server --host 0.0.0.0 --port 8526 --skip-auth-token
```

### 方式 3：从源码运行

```bash
# 克隆仓库
git clone https://github.com/bmpixel/cui.git
cd cui

# 安装依赖
npm install

# 构建
npm run build

# 启动
npm start -- --host 0.0.0.0 --port 8526 --skip-auth-token
```

### 命令行选项

| 选项 | 说明 | 默认值 |
|-----|------|--------|
| `--host <host>` | 监听地址 | `localhost` |
| `--port <port>` | 监听端口 | `3001` |
| `--skip-auth-token` | 禁用认证（本地环境） | 关闭 |
| `--token <token>` | 自定义认证 Token | 自动生成 |

---

## 部署指南

### Ubuntu/Debian 部署

```bash
# 1. 安装系统依赖
sudo apt-get update
sudo apt-get install -y curl python3 build-essential

# 2. 安装 Node.js 20
curl -fsSL https://deb.nodesource.com/setup_20.x | sudo -E bash -
sudo apt-get install -y nodejs

# 3. 调大 inotify watcher 限制（必须！否则文件监控会静默失败）
echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 4. 检查依赖
bash scripts/check-dependencies.sh

# 5. 安装 CUI Server
npm install -g cui-no-auth

# 6. 启动服务
cui-server --host 0.0.0.0 --port 8526 --skip-auth-token

# 6. 配置开机自启动（可选）
sudo tee /etc/systemd/system/cui-server.service << 'EOF'
[Unit]
Description=CUI Server - Claude Code Monitoring Platform
After=network.target

[Service]
Type=simple
User=YOUR_USER
WorkingDirectory=/home/YOUR_USER
ExecStart=/usr/bin/cui-server --host 0.0.0.0 --port 8526 --skip-auth-token
Restart=always
RestartSec=10

[Install]
WantedBy=multi-user.target
EOF

sudo systemctl daemon-reload
sudo systemctl enable cui-server
sudo systemctl start cui-server
```

### CentOS/RHEL 部署

```bash
# 1. 安装系统依赖
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3

# 2. 安装 Node.js 20
curl -fsSL https://rpm.nodesource.com/setup_20.x | sudo bash -
sudo yum install -y nodejs

# 3. 调大 inotify watcher 限制（必须！否则文件监控会静默失败）
echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p

# 4. 后续步骤同上
```

### Docker 部署

```dockerfile
# Dockerfile
FROM node:20-alpine

# 安装编译工具
RUN apk add --no-cache python3 make g++

WORKDIR /app

# 安装依赖
COPY package*.json ./
RUN npm ci --only=production

# 复制代码并构建
COPY . .
RUN npm run build

# 暴露端口
EXPOSE 8526

# 启动
CMD ["node", "dist/server.js", "--host", "0.0.0.0", "--port", "8526", "--skip-auth-token"]
```

```bash
# 构建镜像
docker build -t cui-server .

# 运行容器
docker run -d \
  --name cui-server \
  -p 8526:8526 \
  -v ~/.claude:/root/.claude:ro \
  cui-server
```

---

## 使用说明

### 首页 - 会话列表

<img src="docs/assets/home.png" alt="首页" width="800">

**功能**：
- 显示所有 Claude 会话（按更新时间排序）
- **实时发现**：新会话自动出现（1-2 秒延迟）
- **无限滚动**：向下滚动自动加载更多
- **智能更新**：已加载会话元数据实时刷新

**操作**：
- 点击会话 → 查看详情
- 点击右上角 → 创建新会话
- 向下滚动 → 加载更多历史

### 详情页 - 实时追踪

<img src="docs/assets/detail.png" alt="详情页" width="800">

**功能**：
- 查看完整对话历史
- **实时追踪**：Claude 回复时实时显示（< 1 秒延迟）
- **自动订阅**：打开详情自动监控，关闭自动停止
- 继续对话、恢复会话、查看工具调用

**操作**：
- 输入框发送消息 → 继续对话
- 点击"停止" → 中断正在运行的任务
- 关闭页面 → 后台自动清理监控

---

## 实时监控架构

### 工作原理

```
┌─────────────────────────────────────────────┐
│  终端（Claude Code CLI）                     │
│  └─ claude "分析项目架构"                    │
│     ↓                                        │
│  ~/.claude/projects/xxx.jsonl（会话文件）   │
└─────────────────────────────────────────────┘
              │ 文件变化（inotify）
              ↓
┌─────────────────────────────────────────────┐
│  CUI Server 后端                             │
│  ┌─────────────────────────────────────┐   │
│  │ DirectoryWatcher（轻量监控）         │   │
│  │ ├─ 监控所有 .jsonl 文件              │   │
│  │ ├─ 检测新文件和元数据变化            │   │
│  │ └─ 快速提取元数据（前 50KB）         │   │
│  └─────────────────────────────────────┘   │
│               ↓                              │
│  ┌─────────────────────────────────────┐   │
│  │ ContentWatcher（深度监控）           │   │
│  │ ├─ 用户打开详情时启动                │   │
│  │ ├─ 监控单个文件内容变化              │   │
│  │ └─ 增量读取新消息                    │   │
│  └─────────────────────────────────────┘   │
│               ↓                              │
│  ┌─────────────────────────────────────┐   │
│  │ EventBus（事件总线）                 │   │
│  │ ├─ session_list_update               │   │
│  │ └─ session_content_update            │   │
│  └─────────────────────────────────────┘   │
│               ↓                              │
│  ┌─────────────────────────────────────┐   │
│  │ StreamManager（SSE 推送）            │   │
│  │ ├─ 全局流（所有客户端）              │   │
│  │ └─ 会话流（订阅者）                  │   │
│  └─────────────────────────────────────┘   │
└─────────────────────────────────────────────┘
              │ Server-Sent Events
              ↓
┌─────────────────────────────────────────────┐
│  浏览器前端                                  │
│  ├─ 监听全局事件 → 首页自动更新             │
│  ├─ 订阅会话 → 详情页实时追踪               │
│  └─ 取消订阅 → 停止监控                     │
└─────────────────────────────────────────────┘
```

### 资源控制

- **监控限制**：最多同时监控 50 个会话
- **智能清理**：用户离开详情页自动停止监控
- **共享监控**：多用户订阅同一会话只监控一次
- **内存占用**：~2MB per file，总计 < 100MB

---

## 底层依赖

### 核心依赖

| 依赖 | 版本 | 用途 | Linux 兼容性 |
|-----|------|------|-------------|
| **Node.js** | >= 20.19.0 | 运行时环境 | ✅ 完全支持 |
| **better-sqlite3** | ^12.2.0 | 数据库（原生模块） | ⚠️ 需编译环境 |
| **chokidar** | ^3.6.0 | 文件监控 | ✅ 完全支持 |
| **express** | ^4.18.2 | HTTP 服务器 | ✅ 完全支持 |
| **@anthropic-ai/claude-code** | ^2.0.65 | Claude SDK | ✅ 完全支持 |

### 系统依赖

#### 运行时（必需）
- Linux Kernel >= 2.6.13（inotify 支持）
- glibc 或 musl libc

#### 编译时（仅安装时需要）
- Python 3 (>= 3.6)
- GCC/G++ (>= 4.8)
- GNU Make

### 安装编译环境

```bash
# Ubuntu/Debian
sudo apt-get install -y python3 build-essential

# CentOS/RHEL
sudo yum groupinstall -y "Development Tools"
sudo yum install -y python3

# Alpine Linux
apk add --no-cache python3 make g++

# Arch Linux
sudo pacman -S python gcc make
```

---

## Linux 兼容性详解

### ✅ 完全支持的发行版

以下发行版**无需额外配置**（安装编译工具后）：

- Ubuntu 20.04, 22.04, 24.04
- Debian 11, 12
- CentOS 8, 9
- RHEL 8, 9
- Fedora 35+
- Amazon Linux 2, 2023
- openSUSE Leap 15+

### ⚠️ 需要额外配置的发行版

#### Alpine Linux

**问题**：精简系统，缺少编译工具

**解决方案**：
```bash
# 安装编译环境
apk add --no-cache python3 make g++ nodejs npm

# 安装 CUI Server
npm install -g cui-no-auth
```

#### 精简版 Linux（如 Minimal Ubuntu）

**问题**：可能没有预装 Python 和编译工具

**解决方案**：
```bash
# 先检查依赖
bash scripts/check-dependencies.sh

# 根据提示安装缺失的工具
sudo apt-get install -y python3 build-essential
```

### ❌ 不支持的环境

- Windows（原生）：请使用 WSL2
- 旧版 Linux Kernel < 2.6.13：不支持 inotify

---

## 故障排查

### 问题 1：npm install 失败（better-sqlite3 编译错误）

**错误信息**：
```
gyp ERR! build error
gyp ERR! stack Error: `make` failed with exit code: 2
```

**解决方案**：
```bash
# 安装编译工具
sudo apt-get install -y python3 build-essential

# 重新安装
npm install
```

### 问题 2：文件监控不工作（CentOS/Ubuntu 必读）

> **⚠️ 重要：** Linux 上 CUI 使用 `fs.watch`（inotify 后端）监控会话文件变化。默认的 inotify watcher 限制（8192）在会话较多时会静默失败，导致新会话无法被发现、实时更新停止工作。**部署到 CentOS/Ubuntu 时必须调大此限制。**

**检查当前限制**：
```bash
cat /proc/sys/fs/inotify/max_user_watches
# 如果 < 524288，需要调大
```

**调大限制（必须操作）**：
```bash
# 临时生效
sudo sysctl fs.inotify.max_user_watches=524288

# 永久生效（重启后仍有效）
echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf
sudo sysctl -p
```

**为什么需要这样做**：
- 默认限制 8192 个 watcher，每个被监控的目录/文件占用 1 个
- CUI 监控 `~/.claude/projects/` 下所有 JSONL 文件
- 当会话数量超过限制时，`fs.watch` 静默失败（不报错，只是不触发事件）
- 调到 524288 后基本不会再遇到此问题，额外内存消耗约 128MB

### 问题 3：端口被占用

**错误信息**：
```
Error: listen EADDRINUSE: address already in use 0.0.0.0:8526
```

**解决方案**：
```bash
# 查找占用端口的进程
lsof -ti :8526

# 杀掉进程
kill $(lsof -ti :8526)

# 或更换端口
cui-server --port 8527
```

### 问题 4：Docker Alpine 镜像构建失败

**解决方案**：
```dockerfile
# 确保安装了编译工具
RUN apk add --no-cache python3 make g++

# 如果还是失败，使用 node:20（基于 Debian）
FROM node:20
```

---

## API 端点

### 会话管理

| 端点 | 方法 | 说明 |
|-----|------|------|
| `/api/conversations` | GET | 获取会话列表（支持分页） |
| `/api/conversations/:sessionId` | GET | 获取会话详情 |
| `/api/conversations/start` | POST | 启动新会话 |
| `/api/conversations/:streamingId/stop` | POST | 停止会话 |

### 实时监控（v0.7.0 新增）

| 端点 | 方法 | 说明 |
|-----|------|------|
| `/api/subscriptions/subscribe` | POST | 订阅会话内容更新 |
| `/api/subscriptions/unsubscribe` | POST | 取消订阅 |
| `/api/subscriptions/status` | GET | 查看订阅状态 |
| `/api/stream/global` | GET (SSE) | 全局事件流 |
| `/api/stream/session-{id}` | GET (SSE) | 会话内容流 |

### 系统管理

| 端点 | 方法 | 说明 |
|-----|------|------|
| `/api/system/status` | GET | 系统状态 |
| `/health` | GET | 健康检查 |

---

## 开发指南

### 开发环境搭建

```bash
# 克隆仓库
git clone https://github.com/bmpixel/cui.git
cd cui

# 安装依赖
npm install

# 启动开发模式（后端）
npm run dev

# 启动开发模式（前端）
npm run dev:web
```

### 运行测试

```bash
# 所有测试
npm test

# 单元测试
npm run unit-tests

# 集成测试
npm run integration-tests

# 测试覆盖率
npm run test:coverage

# 交互式测试
npm run test:ui
```

### 类型检查

```bash
npm run typecheck
```

### 构建

```bash
npm run build
```

---

## 性能优化建议

### 1. 增加 inotify 限制（推荐）

```bash
# 当前限制
cat /proc/sys/fs/inotify/max_user_watches

# 增加到 524288（推荐）
sudo sysctl fs.inotify.max_user_watches=524288

# 永久生效
echo 'fs.inotify.max_user_watches=524288' | sudo tee -a /etc/sysctl.conf
```

### 2. 使用 PM2 管理进程（推荐）

```bash
# 安装 PM2
npm install -g pm2

# 启动服务
pm2 start cui-server --name cui -- --host 0.0.0.0 --port 8526 --skip-auth-token

# 查看日志
pm2 logs cui

# 查看状态
pm2 status

# 开机自启
pm2 startup
pm2 save
```

### 3. 配置反向代理（生产环境）

```nginx
# /etc/nginx/sites-available/cui-server
server {
    listen 80;
    server_name cui.your-domain.com;

    location / {
        proxy_pass http://localhost:8526;
        proxy_http_version 1.1;
        proxy_set_header Upgrade $http_upgrade;
        proxy_set_header Connection 'upgrade';
        proxy_set_header Host $host;
        proxy_cache_bypass $http_upgrade;

        # SSE 支持
        proxy_buffering off;
        proxy_read_timeout 86400;
    }
}
```

---

## 配置文件

### 配置位置

```
~/.cui/config.json
```

### 配置示例

```json
{
  "server": {
    "host": "0.0.0.0",
    "port": 8526
  },
  "interface": {
    "colorScheme": "system",
    "language": "zh-CN"
  },
  "machine_id": "1",
  "authToken": "your-token"
}
```

---

## 文档

### 用户文档

- [用户验收测试指南](USER_ACCEPTANCE_TEST.md) - 如何验证功能
- [功能总结](REALTIME_FEATURE_SUMMARY.md) - 完整功能说明

### 开发文档

- [开发进度跟踪](REALTIME_WATCH_PROGRESS.md) - 详细开发记录
- [集成测试指南](INTEGRATION_TEST_GUIDE.md) - 命令行测试方法
- [依赖分析](DEPENDENCY_ANALYSIS.md) - 底层依赖详解

### 设计文档

- 产品需求定义（PRD）
- 技术架构设计
- 无限滚动设计

---

## 版本更新日志

### v0.7.2（2025-12-29）- 交互体验优化

#### ✨ 功能增强
- **回到顶部**：新增一键回到顶部按钮，长对话浏览更便捷
- **滚动优化**：优化滚动到底部/顶部的行为，使用瞬时跳转替代平滑滚动，解决长列表滚动不到位的问题

### v0.7.1（2025-12-29）- 性能与体验升级

#### 🚀 核心优化
- **零卡顿切换**：重构会话视图架构，彻底解决多会话切换时的闪烁与卡顿问题
- **渲染性能提升**：移除全局流状态合并，优化虚拟列表渲染，CPU 占用降低 50%
- **智能资源调度**：延迟建立 SSE 连接，避免浏览器连接数耗尽
- **滚动体验优化**：修复长会话进入时的滚动条跳动问题

### v0.7.0（2025-12-28）- 实时监控系统

#### 核心功能
- ✅ **实时监控系统**：双层监控架构，支持实时发现和追踪
- ✅ **首页自动发现**：新会话 1-2 秒内自动出现
- ✅ **详情页实时追踪**：对话进度实时显示
- ✅ **无限滚动**：支持 1000+ 会话，已加载会话实时更新
- ✅ **多客户端协同**：共享监控，多人同时查看

#### 技术改进
- ✅ DirectoryWatcher：轻量监控器（监控所有文件）
- ✅ ContentWatcher：深度监控器（按需订阅）
- ✅ EventBus：事件驱动架构
- ✅ SSE 推送：取代轮询，零延迟
- ✅ 资源优化：监控文件数减少 96%

#### API 新增
- `POST /api/subscriptions/subscribe` - 订阅会话
- `POST /api/subscriptions/unsubscribe` - 取消订阅
- `GET /api/subscriptions/status` - 订阅状态
- `GET /api/stream/global` - 全局事件流
- `GET /api/stream/session-{id}` - 会话内容流

### v0.6.8

- 性能优化：索引优化，详情页秒开
- 架构升级：事件驱动更新（fs.watch + SSE）
- 体验改进：隐藏目录支持、列表降噪

---

## 技术栈

### 后端

- **运行时**：Node.js 20 + TypeScript
- **框架**：Express.js
- **数据库**：SQLite3（better-sqlite3）
- **文件监控**：chokidar（基于 inotify）
- **实时通信**：Server-Sent Events (SSE)
- **日志**：pino

### 前端

- **框架**：React 18 + TypeScript
- **路由**：React Router v6
- **UI**：Radix UI + Tailwind CSS
- **状态管理**：Context API + Hooks
- **构建**：Vite 7

### 测试

- **框架**：Vitest
- **覆盖率**：v8
- **UI 测试**：@testing-library/react

---

## 贡献指南

欢迎贡献代码、报告问题或提出建议！

### 开发流程

1. Fork 本仓库
2. 创建特性分支：`git checkout -b feature/your-feature`
3. 提交更改：`git commit -am 'Add some feature'`
4. 推送分支：`git push origin feature/your-feature`
5. 提交 Pull Request

### 代码规范

```bash
# 运行 lint
npm run lint

# 类型检查
npm run typecheck

# 运行测试
npm test
```

---

## 许可证

Apache License 2.0

---

## 致谢

- [Claude Code](https://claude.com/code) - Anthropic 官方 CLI
- [chokidar](https://github.com/paulmillr/chokidar) - 跨平台文件监控
- [better-sqlite3](https://github.com/WiseLibs/better-sqlite3) - 高性能 SQLite

---

## 联系方式

- **问题反馈**：[GitHub Issues](https://github.com/Libeny/cui-no-auth/issues)
- **功能建议**：[GitHub Discussions](https://github.com/Libeny/cui-no-auth/discussions)
- **原作者**：Wenbo Pan
- **Fork 维护者**：木鱼拓哉（微信：BiothaLMY）

---

<div align="center">

**用 Web 化实时监控，让 AI 任务执行一目了然**

Made with ❤️ by the community

</div>
