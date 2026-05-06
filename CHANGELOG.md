# 更新日志

## v0.7.7 (2026-05-07)

### 改进
- **Codex token usage 展示对齐 Claude Code**：
  - Codex 不再把会话模型标签复制到每条消息
  - 仅在可归属到 assistant 响应的 usage 上展示模型和 token 用量
  - 对 Claude split assistant blocks 做 usage 去重，避免同一次模型调用重复展示
- **按 turn 聚合 token 用量**：
  - 每轮 response 底部显示 `Turn total`
  - 支持按模型聚合显示同一轮中的多模型 usage
  - token 顺序统一为 `in · out · cache read · cache write`
- **Turns 导航**：
  - 新增左侧 `Turns` 入口，按 User / Response 预览每一轮
  - 点击 User 或 Response 可稳定跳转到对应消息
  - 面板宽度和高度受限，长内容省略，避免横向滚动和遮挡底部输入框

### 修复
- Codex 会话底部输入框恢复显示，但保持只读禁用状态
- 工具卡片不再重复展示模型标签
- 修复虚拟列表跳转到上文时可能因测量修正导致定位不准的问题

## v0.7.6 (2026-05-06)

### 新功能
- **Codex 历史会话浏览**：
  - 新增 `CodexHistoryReader`，读取 `~/.codex/sessions/**/rollout-*.jsonl`
  - 新增 `CodexHistoryIndexer`，按 15 秒轮询把 Codex 会话变化广播到首页
  - 新增 `/api/codex-conversations` 和 `/api/codex-conversations/:sessionId`
  - Codex session 使用 `codex:` 前缀隔离，避免和 Claude sessionId 冲突
- **Codex 消息映射**：
  - 支持 Codex user / assistant message 映射到现有会话消息结构
  - 支持 reasoning summary、function_call、function_call_output、exec_command_end
  - 支持 Codex token usage 汇总和单条 assistant 消息用量展示
- **首页来源过滤**：
  - 新增 `全部 / Claude Code / Codex` 来源选择
  - Claude 与 Codex 会话可合并排序、去重和分页
  - Codex 会话在列表中显示独立来源 badge
- **Codex 只读详情页**：
  - Codex 会话可从首页进入详情页查看完整历史
  - Codex 会话隐藏续聊输入框、归档、置顶和重命名等 Claude 专属操作
  - 模型标签按 Claude / GPT-Codex / 外部模型分色展示

### 改进
- Claude 会话列表过滤掉 `codex:` 前缀和空占位 session，避免历史列表混入无效记录
- Codex JSONL 解析允许忽略尾部坏行，适配仍在写入中的会话文件
- 新增 Codex reader、indexer、route 和模型配色单元测试

### 注意事项
- Codex 会话目前是只读历史浏览，不支持从 CUI 中继续 Codex 会话
- Docker 部署如果需要浏览 Codex 历史，需要额外挂载 `~/.codex:/root/.codex:ro`
- 本地全量 unit test 依赖 `better-sqlite3` 原生模块，需要确保 `node_modules` 与当前 Node.js ABI 一致

## v0.7.4 (2026-04-20)

### 新功能
- **sub-agent 过程钻取**：
  - 主会话里的 `Agent(...)` 工具块保留原结果区块
  - 新增 `查看 sub-agent 执行进展 / 查看 sub-agent 执行过程` 链接
  - 点击后进入独立 sub-agent 会话页，不再在主会话顶部单独渲染 `SUB-AGENTS` 区域
- **消息显示增强**：
  - 会话页显示消息时间
  - assistant 消息与 tool 区块显示对应模型
- **目录选择器增强**：
  - 新增 `全部目录`
  - 目录选择以绝对路径为主展示
  - 支持模糊搜索和直接输入路径
- **session 页手动刷新**：
  - 支持下滑刷新
  - 右侧浮动按钮新增 `刷新`
  - 刷新结果提示：`已更新`、`已更新，请向下滑`、`暂无最新消息`
- **首页刷新反馈**：
  - 右上角新增列表刷新按钮
  - 自动更新时提示 `列表已更新 / 列表已更新，请向上查看`
  - 手动刷新时提示 `列表已更新 / 暂无最新消息`

### 改进
- **首页列表更新机制优化**：
  - `index_update` 改为 15 秒节流
  - 增加 `session_list_update` 增量 patch，减少全量 reload
- **SSE 与索引广播解耦**：
  - `HistoryIndexer` 不再直接广播 SSE
  - 改为 `SessionUpdateBus -> SessionUpdateBroadcaster` 批量广播
- **session 内容刷新机制重构**：
  - 启动时全量扫描 `~/.claude/projects`
  - 之后每 15 秒执行一次目录发现 + 文件轮询
  - 基于 `filePath + lastMtime + fileSize` 判断内容变更
  - 对 session 页面广播 `session_content_update`，保证完整消息落盘后会自动刷新

### 修复
- 去掉前端未接通后端的 `/api/subscriptions/subscribe` / `unsubscribe` 假链路
- 修复 session 页某些情况下只依赖 top 100 列表回查、导致自动刷新不稳定的问题
- 增加 `file_size` 持久化字段，重启后轮询状态可恢复
- 多个首页/详情页同时打开时，列表更新和会话更新职责分离更清晰
- 为 `sub-agent` 增加独立 API 与详情页，不再把 sidechain 混进首页列表

## v0.7.3 (2026-03-29)

### 新功能
- **环境变量/代理预设**：每个会话可独立配置代理和环境变量
  - 设置页新增 Environment 标签页，管理代理预设
  - 输入框底部新增预设下拉选择器（新建会话和继续会话均支持）
  - 预设存储在 `~/.cui/config.json`，环境变量透传给 Claude CLI 子进程
- **目录过滤**：选择工作目录后，会话列表自动过滤为该目录下的会话
  - 过滤状态在 SSE 刷新、归档、置顶、重命名操作后保持不变
- **继续会话优化**：
  - 默认使用 bypassPermissions 权限模式
  - 检测 resume 失败（返回新 sessionId）时提示用户
  - 同 sessionId resume 直接连接流，不再空导航
- **语音识别服务抽象**：支持 GLM 语音识别

### 修复
- **内存泄漏修复**（3 处）：
  - Logger 子日志器缓存：按日清理，隔天自动释放
  - ToolMetrics 缓存：7 天保留期，每小时自动回收过期条目
  - ConversationConfig：进程关闭时主动释放历史消息大数组
- **目录过滤丢失**：TaskList 的归档/置顶/重命名操作不再覆盖当前过滤条件
- **ToolMetrics 持久化**：代码改动统计（+N/-M）持久化到 SQLite，重启后不丢失
- **环境预设验证**：保存时校验预设结构，防止存入无效数据

### 部署提醒
- **CentOS/Ubuntu 必须**调大 `fs.inotify.max_user_watches` 至 524288（详见 README）

---

## v0.7.2 (2026-01-03)

### 新功能
- 滚动交互体验优化

---

## v0.7.1 (2026-01-03)

### 新功能
- 性能优化，零延迟切换

---

## v0.6.8

### 新功能
- 会话列表显示 session ID

---

## v0.6.7

### 新功能
- 事件驱动更新、SQLite 索引、UI 改进
- SQLite 索引实现历史记录冷加载，解决 OOM 问题并优化启动速度

---

## v0.6.6

### 新功能
- 支持 `--skip-auth-token` 参数跳过登录
- 灵活的认证系统，支持无认证模式
