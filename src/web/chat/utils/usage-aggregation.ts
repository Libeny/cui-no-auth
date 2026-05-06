import { addTokenUsage, emptyTokenUsage, hasTokenUsage, totalTokens } from '@/utils/token-usage';
import type { ChatMessage, TokenUsageSummary } from '../types';

type UsageAccumulator = {
  total: ReturnType<typeof emptyTokenUsage>;
  byModel: Map<string, TokenUsageSummary['byModel'][number]>;
};

export interface ConversationTurnOutlineItem {
  id: string;
  index: number;
  userMessageId: string;
  responseMessageId?: string;
  prompt: string;
  response: string;
}

export function annotateMessagesWithUsagePresentation(messages: ChatMessage[]): ChatMessage[] {
  const next = messages.map(message => ({
    ...message,
    turnUsageSummary: undefined,
    turnStartMessageId: undefined,
  }));
  const usageKeys = messages.map(getMessageUsageKey);
  const duplicateGroups = new Map<string, number[]>();

  usageKeys.forEach((key, index) => {
    if (!key) return;
    const indices = duplicateGroups.get(key) || [];
    indices.push(index);
    duplicateGroups.set(key, indices);
  });

  for (const indices of duplicateGroups.values()) {
    if (indices.length < 2) continue;

    for (const index of indices.slice(0, -1)) {
      next[index] = {
        ...next[index],
        model: undefined,
        usage: undefined,
      };
    }
  }

  const turnSummaries = new Map<number, UsageAccumulator>();
  const displayIndexByUsageKey = new Map<string, number>();

  for (const [key, indices] of duplicateGroups.entries()) {
    displayIndexByUsageKey.set(key, indices[indices.length - 1]);
  }

  let currentTurn: {
    startMessageId: string;
    usageKeys: Set<string>;
    summary: UsageAccumulator;
    lastUsageIndex?: number;
  } | undefined;

  const flushTurn = () => {
    if (currentTurn?.lastUsageIndex !== undefined && hasTokenUsage(currentTurn.summary.total)) {
      turnSummaries.set(currentTurn.lastUsageIndex, currentTurn.summary);
      next[currentTurn.lastUsageIndex] = {
        ...next[currentTurn.lastUsageIndex],
        turnStartMessageId: currentTurn.startMessageId,
      };
    }
  };

  messages.forEach((message, index) => {
    if (isTurnStartingUserMessage(message)) {
      flushTurn();
      currentTurn = {
        startMessageId: message.messageId,
        usageKeys: new Set(),
        summary: createAccumulator(),
      };
      return;
    }

    if (!currentTurn) return;

    const usageKey = usageKeys[index];
    if (!usageKey || currentTurn.usageKeys.has(usageKey) || !hasTokenUsage(message.usage)) {
      return;
    }

    currentTurn.usageKeys.add(usageKey);
    addUsageToAccumulator(currentTurn.summary, message.usage, message.model);
    const displayIndex = displayIndexByUsageKey.get(usageKey) ?? index;
    currentTurn.lastUsageIndex =
      currentTurn.lastUsageIndex === undefined ? displayIndex : Math.max(currentTurn.lastUsageIndex, displayIndex);
  });

  flushTurn();

  for (const [index, accumulator] of turnSummaries.entries()) {
    next[index] = {
      ...next[index],
      turnUsageSummary: finalizeAccumulator(accumulator),
    };
  }

  return next;
}

export function buildConversationTurnOutline(messages: ChatMessage[]): ConversationTurnOutlineItem[] {
  const items: ConversationTurnOutlineItem[] = [];
  let current:
    | {
        userMessageId: string;
        prompt: string;
        response: string;
        responseMessageId?: string;
      }
    | undefined;

  const flushTurn = () => {
    if (!current) return;

    items.push({
      id: `turn-${current.userMessageId}`,
      index: items.length + 1,
      userMessageId: current.userMessageId,
      responseMessageId: current.responseMessageId,
      prompt: current.prompt,
      response: current.response,
    });
  };

  for (const message of messages) {
    if (isTurnStartingUserMessage(message)) {
      flushTurn();
      current = {
        userMessageId: message.messageId,
        prompt: extractTextContent(message.content) || '(empty prompt)',
        response: '',
      };
      continue;
    }

    if (!current || message.type !== 'assistant') {
      continue;
    }

    const assistantText = extractTextContent(message.content);
    if (assistantText) {
      current.response = assistantText;
    }
    current.responseMessageId = message.messageId;
  }

  flushTurn();

  return items;
}

export function buildUniqueTokenUsageSummary(messages: ChatMessage[]): TokenUsageSummary | undefined {
  const accumulator = createAccumulator();
  const seenUsageKeys = new Set<string>();

  for (const message of messages) {
    const usageKey = getMessageUsageKey(message);
    if (!usageKey || seenUsageKeys.has(usageKey) || !hasTokenUsage(message.usage)) {
      continue;
    }

    seenUsageKeys.add(usageKey);
    addUsageToAccumulator(accumulator, message.usage, message.model);
  }

  if (!hasTokenUsage(accumulator.total)) {
    return undefined;
  }

  return finalizeAccumulator(accumulator);
}

function createAccumulator(): UsageAccumulator {
  return {
    total: emptyTokenUsage(),
    byModel: new Map(),
  };
}

function addUsageToAccumulator(accumulator: UsageAccumulator, usage: NonNullable<ChatMessage['usage']>, model?: string) {
  addTokenUsage(accumulator.total, usage);

  const modelName = model || 'Unknown';
  const existing = accumulator.byModel.get(modelName) || {
    model: modelName,
    messageCount: 0,
    ...emptyTokenUsage(),
  };

  existing.messageCount += 1;
  addTokenUsage(existing, usage);
  accumulator.byModel.set(modelName, existing);
}

function finalizeAccumulator(accumulator: UsageAccumulator): TokenUsageSummary {
  return {
    total: accumulator.total,
    byModel: [...accumulator.byModel.values()].sort((a, b) => {
      const aTotal = totalTokens(a);
      const bTotal = totalTokens(b);
      return bTotal - aTotal || a.model.localeCompare(b.model);
    }),
  };
}

function getMessageUsageKey(message: ChatMessage): string | undefined {
  if (message.type !== 'assistant' || !hasTokenUsage(message.usage)) {
    return undefined;
  }

  const callId = message.modelCallId || message.id || message.messageId;
  const model = message.model || 'Unknown';
  const usage = message.usage;
  return [
    callId,
    model,
    usage.inputTokens,
    usage.outputTokens,
    usage.cacheCreationInputTokens,
    usage.cacheReadInputTokens,
  ].join('|');
}

function isTurnStartingUserMessage(message: ChatMessage): boolean {
  if (message.type !== 'user') {
    return false;
  }

  if (!Array.isArray(message.content)) {
    return true;
  }

  return message.content.some((block: any) => block?.type !== 'tool_result');
}

function extractTextContent(content: ChatMessage['content']): string {
  if (typeof content === 'string') {
    return normalizePreviewText(content);
  }

  if (!Array.isArray(content)) {
    return '';
  }

  return normalizePreviewText(
    content
      .filter((block: any) => block?.type === 'text' && typeof block.text === 'string')
      .map((block: any) => block.text)
      .join('\n')
  );
}

function normalizePreviewText(value: string): string {
  return value.replace(/\s+/g, ' ').trim();
}
