# 目录联动过滤 + Proxy 预设

## Feature 1: 目录选择联动 session 列表

**现状**：后端 `projectPath` 过滤已完全实现（SQL WHERE 已有），`api.getConversations` 也支持 `projectPath` 参数。只差前端接线。

### 改动清单

| # | 文件 | 改动 |
|---|------|------|
| 1 | `src/web/chat/contexts/ConversationsContext.tsx` | filters 类型加 `projectPath?` |
| 2 | `src/web/chat/components/Home/Home.tsx` | directory onChange 时带 projectPath 调 loadConversations |

就这两个文件，核心改动约 10 行。

---

## Feature 2: Proxy/Env 预设

### 数据模型

```typescript
// src/types/config.ts
interface EnvPreset {
  id: string;
  name: string;         // "Clash", "公司VPN"
  proxy?: string;       // http://127.0.0.1:7897
  noProxy?: string;
  envVars?: Record<string, string>;
}

// CUIConfig 扩展
envPresets?: EnvPreset[];
```

### 改动清单

**后端：**

| # | 文件 | 改动 |
|---|------|------|
| 3 | `src/types/config.ts` | 加 EnvPreset 类型，CUIConfig 加 envPresets |
| 4 | `src/types/index.ts` | StartConversationRequest 加 envPresetId |
| 5 | `src/services/config-service.ts` | envPresets 验证 |
| 6 | `src/routes/config.routes.ts` | envPresets CRUD API |
| 7 | `src/routes/conversation.routes.ts` | 解析 envPresetId → 展开为 env vars |
| 8 | `src/services/claude-process-manager.ts` | 接收 per-session envOverrides |
| 9 | `src/utils/env-preset.ts`（新建） | expandPreset() 工具函数 |

**前端：**

| # | 文件 | 改动 |
|---|------|------|
| 10 | `src/web/chat/components/PreferencesModal/EnvironmentTab.tsx`（新建） | 预设管理 UI |
| 11 | `src/web/chat/components/PreferencesModal/PreferencesModal.tsx` | 加 Environment tab |
| 12 | `src/web/chat/components/Composer/EnvPresetDropdown.tsx`（新建） | 预设选择下拉 |
| 13 | `src/web/chat/components/Composer/Composer.tsx` | onSubmit 签名加 envPresetId |
| 14 | `src/web/chat/components/Home/Home.tsx` | 传递 envPresetId |
| 15 | `src/web/chat/components/ConversationView/ConversationView.tsx` | resume 时传递 envPresetId |
| 16 | `src/web/chat/services/api.ts` | startConversation 加字段，envPresets CRUD |
