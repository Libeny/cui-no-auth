# 环境变量 & 代理设置功能方案（Per-Session）

## 核心思路

用户使用不同模型可能需要不同代理/API 配置。所以**每个 session 启动时让用户选择环境预设**，和选 Model、选 PermissionMode 一样的交互模式。

---

## 一、用户体验

### Composer 底部新增 "Env" 下拉（和 Model/Permission 同级）

```
┌───────────────────────────────────────────────┐
│  Tell Claude what to do...                     │
│                                                │
│  [~/project ▾]  [Opus ▾]  [🌐 Proxy ▾]       │ ← 新增
│                                    [Ask ▾][▶] │
└───────────────────────────────────────────────┘
```

点击 "🌐 Proxy" 下拉：
```
┌──────────────────────────────┐
│ ✓ Direct (无代理)            │  ← 默认
│   Clash (127.0.0.1:7897)    │  ← 用户预设
│   公司VPN (10.0.0.1:8080)   │  ← 用户预设
│ ──────────────────────────── │
│   ⚙ Manage Presets...       │  ← 打开管理面板
└──────────────────────────────┘
```

### PreferencesModal → "Environment" Tab（管理预设）

```
┌─────────────────────────────────────────────┐
│  Environment Presets                         │
├─────────────────────────────────────────────┤
│                                             │
│  [+ New Preset]                             │
│                                             │
│  ┌─ Clash ─────────────────────────────┐   │
│  │ Proxy: http://127.0.0.1:7897       │   │
│  │ Vars:  (none)                       │   │
│  │                       [Edit] [Del]  │   │
│  └─────────────────────────────────────┘   │
│                                             │
│  ┌─ OpenAI Compatible ─────────────────┐   │
│  │ Proxy: (none)                       │   │
│  │ Vars:  ANTHROPIC_BASE_URL=https://..│   │
│  │        ANTHROPIC_API_KEY=sk-••••    │   │
│  │                       [Edit] [Del]  │   │
│  └─────────────────────────────────────┘   │
│                                             │
└─────────────────────────────────────────────┘
```

编辑预设时：
```
┌─────────────────────────────────────────────┐
│  Edit Preset: Clash                          │
├─────────────────────────────────────────────┤
│  Name:  [Clash                           ]  │
│                                             │
│  ── Proxy ──────────────────────────────── │
│  URL:   [http://127.0.0.1:7897          ]  │
│  ☑ Apply to http, https, all_proxy         │
│                                             │
│  ── Extra Environment Variables ─────────  │
│  ┌──────────────────┬──────────────────┐   │
│  │ Key              │ Value            │   │
│  ├──────────────────┼──────────────────┤   │
│  │ ANTHROPIC_BASE.. │ https://...      │   │
│  │ [+ Add Variable] │                  │   │
│  └──────────────────┴──────────────────┘   │
│                                             │
│              [Save]  [Cancel]               │
└─────────────────────────────────────────────┘
```

---

## 二、数据模型

### 2.1 配置（`~/.cui/config.json`）

```typescript
// src/types/config.ts 扩展
interface EnvPreset {
  id: string;           // uuid
  name: string;         // 显示名 "Clash", "OpenAI Compatible"
  proxy?: string;       // 代理 URL，自动展开为 http_proxy/https_proxy/all_proxy
  noProxy?: string;     // no_proxy 排除列表
  envVars?: Record<string, string>;  // 自定义环境变量 (ANTHROPIC_BASE_URL 等)
}

interface CUIConfig {
  // ... 现有字段 ...
  envPresets?: EnvPreset[];
}
```

### 2.2 对话请求（`StartConversationRequest`）

```typescript
// src/types/index.ts 扩展
interface StartConversationRequest {
  // ... 现有字段 ...
  envPresetId?: string;   // 选中的预设 ID，"direct" 表示无代理
}
```

---

## 三、后端链路

```
前端 Composer: 用户选 envPresetId
  ↓
POST /api/conversations/start { ..., envPresetId: "uuid-xxx" }
  ↓
conversation.routes.ts:
  if (envPresetId && envPresetId !== 'direct') {
    const preset = configService.getConfig().envPresets
      .find(p => p.id === envPresetId);
    requestEnvVars = expandPreset(preset);
  }
  ↓
processManager.startConversation({ ..., envOverrides: requestEnvVars })
  ↓
spawnProcess() 中:
  env = {
    ...process.env,       // 系统环境
    ...requestEnvVars,    // 本次 session 的环境变量
    CUI_STREAMING_ID: streamingId
  }
  ↓
Claude CLI 子进程（带正确的代理设置）
```

### expandPreset 逻辑

```typescript
function expandPreset(preset: EnvPreset): Record<string, string> {
  const env: Record<string, string> = {};

  if (preset.proxy) {
    env.http_proxy = preset.proxy;
    env.https_proxy = preset.proxy;
    env.all_proxy = preset.proxy;
    env.HTTP_PROXY = preset.proxy;
    env.HTTPS_PROXY = preset.proxy;
  }
  if (preset.noProxy) {
    env.no_proxy = preset.noProxy;
    env.NO_PROXY = preset.noProxy;
  }
  if (preset.envVars) {
    Object.assign(env, preset.envVars);
  }

  return env;
}
```

---

## 四、实现清单

### Phase 1: 后端 + 数据层（~1.5h）

| # | 任务 | 文件 |
|---|------|------|
| 1 | `EnvPreset` 类型定义 | `src/types/config.ts` |
| 2 | ConfigService: envPresets 验证 + CRUD | `src/services/config-service.ts` |
| 3 | config.routes: GET/POST/PUT/DELETE envPresets | `src/routes/config.routes.ts` |
| 4 | `StartConversationRequest` 加 `envPresetId` | `src/types/index.ts` |
| 5 | conversation.routes: 解析 envPresetId → envOverrides | `src/routes/conversation.routes.ts` |
| 6 | ProcessManager: 接收 per-session envOverrides | `src/services/claude-process-manager.ts` |
| 7 | `expandPreset()` 工具函数 | `src/utils/env-preset.ts`（新建） |

### Phase 2: 前端 UI（~2h）

| # | 任务 | 文件 |
|---|------|------|
| 8 | EnvPresetDropdown 组件（Composer 底栏） | 新建 `Composer/EnvPresetDropdown.tsx` |
| 9 | Composer: 加 envPresetId state + onSubmit 传递 | `Composer.tsx` |
| 10 | PreferencesModal: Environment Tab | 新建 `PreferencesModal/EnvironmentTab.tsx` |
| 11 | 预设编辑对话框（name + proxy + vars） | 同上 |
| 12 | api.ts: CRUD envPresets + startConversation 加字段 | `services/api.ts` |
| 13 | Home/ChatApp: 传递 envPresets 数据给 Composer | `Home.tsx` / `ChatApp.tsx` |

### 安全

- API Key 类字段在前端显示时 mask
- 日志中过滤含 KEY/TOKEN/SECRET 的 env 值
- envOverrides 不允许覆盖 CUI_STREAMING_ID
