import type { ConversationMessage, TokenUsage, TokenUsageSummary } from '@/types/index.js';
import { hasTokenUsage } from '@/utils/token-usage.js';
import {
  type CodexExecCommandEndEvent,
  type CodexFunctionCallOutputPayload,
  type CodexFunctionCallPayload,
  type CodexJsonlEntry,
  type CodexMessagePayload,
  type CodexReasoningPayload,
  type CodexSessionMetadata,
  type CodexTokenCountEvent,
  fromCodexSessionId,
  toCodexSessionId,
} from './codex-types.js';

type MessageRole = 'user' | 'assistant';

export function mapCodexEntriesToConversationMessages(
  sessionId: string,
  entries: CodexJsonlEntry[],
  metadata?: Partial<CodexSessionMetadata>,
): ConversationMessage[] {
  const rawSessionId = fromCodexSessionId(sessionId);
  const externalSessionId = toCodexSessionId(rawSessionId);
  const messages: ConversationMessage[] = [];
  const completedToolResults = new Set<string>();
  const seenTokenUsageEvents = new Set<string>();

  entries.forEach((entry, index) => {
    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') return;

    if (entry.type === 'response_item' && 'type' in payload) {
      if (payload.type === 'message') {
        const message = mapMessagePayload(payload as CodexMessagePayload);
        if (!message) return;
        messages.push({
          uuid: buildMessageId(externalSessionId, index, message.role),
          type: message.role,
          message: {
            role: message.role,
            content: message.content,
          } as any,
          timestamp: entry.timestamp || '',
          sessionId: externalSessionId,
          model: metadata?.model,
          cwd: metadata?.projectPath,
          version: metadata?.model,
        });
        return;
      }

      if (payload.type === 'reasoning') {
        const summary = extractReasoningSummary(payload as CodexReasoningPayload);
        if (!summary) return;
        messages.push({
          uuid: buildMessageId(externalSessionId, index, 'assistant'),
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [{ type: 'thinking', thinking: summary }],
          } as any,
          timestamp: entry.timestamp || '',
          sessionId: externalSessionId,
          model: metadata?.model,
          cwd: metadata?.projectPath,
        });
        return;
      }

      if (payload.type === 'function_call') {
        const toolUse = mapFunctionCall(payload as CodexFunctionCallPayload);
        if (!toolUse) return;
        messages.push({
          uuid: buildMessageId(externalSessionId, index, 'assistant'),
          type: 'assistant',
          message: {
            role: 'assistant',
            content: [toolUse],
          } as any,
          timestamp: entry.timestamp || '',
          sessionId: externalSessionId,
          model: metadata?.model,
          cwd: metadata?.projectPath,
        });
        return;
      }

      if (payload.type === 'function_call_output') {
        const toolResult = mapFunctionCallOutput(payload as CodexFunctionCallOutputPayload);
        if (!toolResult || completedToolResults.has(toolResult.tool_use_id)) return;
        completedToolResults.add(toolResult.tool_use_id);
        messages.push({
          uuid: buildMessageId(externalSessionId, index, 'user'),
          type: 'user',
          message: {
            role: 'user',
            content: [toolResult],
          } as any,
          timestamp: entry.timestamp || '',
          sessionId: externalSessionId,
          model: metadata?.model,
          cwd: metadata?.projectPath,
        });
      }
    }

    if (entry.type === 'event_msg' && 'type' in payload && payload.type === 'exec_command_end') {
      const toolResult = mapExecCommandEnd(payload as CodexExecCommandEndEvent);
      if (!toolResult || completedToolResults.has(toolResult.tool_use_id)) return;
      completedToolResults.add(toolResult.tool_use_id);
      messages.push({
        uuid: buildMessageId(externalSessionId, index, 'user'),
        type: 'user',
        message: {
          role: 'user',
          content: [toolResult],
        } as any,
        timestamp: entry.timestamp || '',
        sessionId: externalSessionId,
        model: metadata?.model,
        cwd: metadata?.projectPath,
      });
    }

    if (entry.type === 'event_msg' && 'type' in payload && payload.type === 'token_count') {
      const usage = extractCodexLastTokenUsage(payload);
      if (!usage) return;

      const signature = buildTokenUsageEventSignature(payload, usage);
      if (seenTokenUsageEvents.has(signature)) return;
      seenTokenUsageEvents.add(signature);

      const target = findLatestAssistantMessageWithoutUsage(messages);
      if (target) {
        target.usage = usage;
      }
    }
  });

  return messages;
}

export function extractCodexSessionMetadata(filePath: string, entries: CodexJsonlEntry[]): CodexSessionMetadata | null {
  let rawSessionId = '';
  let projectPath = '';
  let model = 'Codex';
  let createdAt = '';
  let updatedAt = '';
  let firstUserMessage = '';
  let messageCount = 0;

  for (const entry of entries) {
    if (entry.timestamp) {
      if (!createdAt) createdAt = entry.timestamp;
      updatedAt = entry.timestamp;
    }

    const payload = entry.payload;
    if (!payload || typeof payload !== 'object') continue;

    if (entry.type === 'session_meta') {
      const sessionMeta = payload as { id?: string; cwd?: string; timestamp?: string; model?: string; model_provider?: { model?: string } };
      rawSessionId ||= sessionMeta.id || '';
      projectPath ||= sessionMeta.cwd || '';
      model = sessionMeta.model_provider?.model || sessionMeta.model || model;
      createdAt ||= sessionMeta.timestamp || entry.timestamp || '';
    }

    if (entry.type === 'turn_context') {
      const turnContext = payload as { cwd?: string; model?: string };
      projectPath ||= turnContext.cwd || '';
      model = turnContext.model || model;
    }

    if (entry.type === 'response_item' && 'type' in payload && payload.type === 'message') {
      const message = mapMessagePayload(payload as CodexMessagePayload);
      if (message) {
        messageCount++;
        if (message.role === 'user' && !firstUserMessage) {
          firstUserMessage = typeof message.content === 'string'
            ? message.content
            : '';
        }
      }
    }
  }

  if (!rawSessionId) {
    rawSessionId = inferSessionIdFromFilePath(filePath);
  }

  if (!rawSessionId) return null;

  const fallbackTime = new Date().toISOString();
  return {
    sessionId: toCodexSessionId(rawSessionId),
    rawSessionId,
    filePath,
    projectPath,
    summary: truncateSummary(firstUserMessage) || 'Codex session',
    messageCount,
    totalDuration: 0,
    model,
    createdAt: createdAt || fallbackTime,
    updatedAt: updatedAt || createdAt || fallbackTime,
  };
}

export function extractCodexTokenUsageSummary(entries: CodexJsonlEntry[], model = 'Codex'): TokenUsageSummary | undefined {
  let latestUsage: TokenUsage | undefined;
  let tokenCountEvents = 0;

  for (const entry of entries) {
    const payload = entry.payload;
    if (entry.type !== 'event_msg' || !payload || typeof payload !== 'object') continue;
    if (!('type' in payload) || payload.type !== 'token_count') continue;

    const info = 'info' in payload ? payload.info : undefined;
    const totalTokenUsage = info && typeof info === 'object' && 'total_token_usage' in info
      ? (info as { total_token_usage?: unknown }).total_token_usage
      : undefined;
    const usage = normalizeCodexTokenUsage(totalTokenUsage);
    if (!usage) continue;

    latestUsage = usage;
    tokenCountEvents += 1;
  }

  if (!latestUsage) return undefined;

  return {
    total: latestUsage,
    byModel: [
      {
        model,
        messageCount: tokenCountEvents || 1,
        ...latestUsage,
      },
    ],
  };
}

function extractCodexLastTokenUsage(payload: CodexTokenCountEvent): TokenUsage | undefined {
  const info = payload.info;
  const lastTokenUsage = info && typeof info === 'object' && 'last_token_usage' in info
    ? (info as { last_token_usage?: unknown }).last_token_usage
    : undefined;

  return normalizeCodexTokenUsage(lastTokenUsage);
}

function buildTokenUsageEventSignature(payload: CodexTokenCountEvent, usage: TokenUsage): string {
  const info = payload.info;
  const totalTokenUsage = info && typeof info === 'object' && 'total_token_usage' in info
    ? (info as { total_token_usage?: unknown }).total_token_usage
    : undefined;

  return JSON.stringify({
    totalTokenUsage,
    usage,
  });
}

function findLatestAssistantMessageWithoutUsage(messages: ConversationMessage[]): ConversationMessage | undefined {
  for (let index = messages.length - 1; index >= 0; index -= 1) {
    const message = messages[index];
    if (message.type === 'assistant' && !message.usage) {
      return message;
    }
  }

  return undefined;
}

function mapMessagePayload(payload: CodexMessagePayload): { role: MessageRole; content: any } | null {
  if (payload.role !== 'user' && payload.role !== 'assistant') {
    return null;
  }

  const text = extractText(payload.content || []);
  if (!text) return null;

  if (payload.role === 'user') {
    if (isSyntheticUserText(text)) return null;
    return {
      role: 'user',
      content: text,
    };
  }

  return {
    role: 'assistant',
    content: [{ type: 'text', text }],
  };
}

function isSyntheticUserText(text: string): boolean {
  const trimmed = text.trim();
  return trimmed.startsWith('<environment_context>') || trimmed.startsWith('<user_instructions>');
}

function mapFunctionCall(payload: CodexFunctionCallPayload): any | null {
  if (!payload.call_id || !payload.name) return null;
  const args = parseArguments(payload.arguments);

  if (payload.name === 'exec_command') {
    return {
      type: 'tool_use',
      id: payload.call_id,
      name: 'Bash',
      input: {
        command: typeof args.cmd === 'string' ? args.cmd : '',
        cwd: typeof args.workdir === 'string' ? args.workdir : typeof args.cwd === 'string' ? args.cwd : undefined,
      },
    };
  }

  return {
    type: 'tool_use',
    id: payload.call_id,
    name: payload.name,
    input: args,
  };
}

function mapExecCommandEnd(payload: CodexExecCommandEndEvent): any | null {
  if (!payload.call_id) return null;
  const output = payload.formatted_output || payload.aggregated_output || [payload.stdout, payload.stderr].filter(Boolean).join('');
  return {
    type: 'tool_result',
    tool_use_id: payload.call_id,
    content: output || '',
    is_error: typeof payload.exit_code === 'number' ? payload.exit_code !== 0 : payload.status === 'failed',
  };
}

function mapFunctionCallOutput(payload: CodexFunctionCallOutputPayload): any | null {
  if (!payload.call_id) return null;
  return {
    type: 'tool_result',
    tool_use_id: payload.call_id,
    content: stringifyOutput(payload.output),
    is_error: false,
  };
}

function extractReasoningSummary(payload: CodexReasoningPayload): string {
  const summary = payload.summary;
  if (!summary) return '';

  if (typeof summary === 'string') {
    return summary.trim();
  }

  if (Array.isArray(summary)) {
    return summary
      .map((item) => {
        if (typeof item === 'string') return item;
        if (item && typeof item === 'object' && 'text' in item && typeof item.text === 'string') return item.text;
        if (item && typeof item === 'object' && 'summary' in item && typeof item.summary === 'string') return item.summary;
        return '';
      })
      .filter(Boolean)
      .join('\n')
      .trim();
  }

  return '';
}

function extractText(content: Array<{ type?: string; text?: string }>): string {
  return content
    .filter((block) => block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
    .map((block) => block.text || '')
    .filter(Boolean)
    .join('\n')
    .trim();
}

function parseArguments(value: unknown): Record<string, unknown> {
  if (!value) return {};
  if (typeof value === 'object' && !Array.isArray(value)) return value as Record<string, unknown>;
  if (typeof value !== 'string') return {};
  try {
    const parsed = JSON.parse(value);
    return parsed && typeof parsed === 'object' && !Array.isArray(parsed) ? parsed : {};
  } catch {
    return {};
  }
}

function normalizeCodexTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') return undefined;
  const usage = raw as Record<string, unknown>;
  const cachedInputTokens = toFiniteNumber(usage.cached_input_tokens ?? usage.cache_read_input_tokens);
  const cacheCreationInputTokens = toFiniteNumber(usage.cache_creation_input_tokens);
  const rawInputTokens = toFiniteNumber(usage.input_tokens);
  const outputTokens = toFiniteNumber(usage.output_tokens);
  const inputTokens = Math.max(0, rawInputTokens - cachedInputTokens - cacheCreationInputTokens);
  const normalized = {
    inputTokens,
    outputTokens,
    cacheCreationInputTokens,
    cacheReadInputTokens: cachedInputTokens,
  };

  return hasTokenUsage(normalized) ? normalized : undefined;
}

function toFiniteNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}

function stringifyOutput(output: unknown): string {
  if (typeof output === 'string') return output;
  if (output === undefined || output === null) return '';
  try {
    return JSON.stringify(output, null, 2);
  } catch {
    return String(output);
  }
}

function inferSessionIdFromFilePath(filePath: string): string {
  const fileName = filePath.split('/').pop() || '';
  return fileName.replace(/^rollout-/, '').replace(/\.jsonl$/, '');
}

function truncateSummary(summary: string): string {
  const cleaned = sanitizeCodexSummaryText(summary).replace(/\n/g, ' ');
  return cleaned.length > 100 ? `${cleaned.slice(0, 100)}...` : cleaned;
}

export function sanitizeCodexSummaryText(summary: string): string {
  const trimmed = summary.trim();
  if (!trimmed) return '';

  if (trimmed.startsWith('IMPORTANT:')) {
    return trimmed.replace(/^IMPORTANT:[\s\S]*?(?:\n\s*\n|$)/, '').trim();
  }

  return trimmed;
}

function buildMessageId(sessionId: string, index: number, role: string): string {
  return `${sessionId}:${index}:${role}`;
}
