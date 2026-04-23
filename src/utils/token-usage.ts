import type { TokenUsage, TokenUsageByModel, TokenUsageSummary } from '@/types/index.js';

type RawTokenUsage = {
  input_tokens?: unknown;
  output_tokens?: unknown;
  cache_creation_input_tokens?: unknown;
  cache_read_input_tokens?: unknown;
};

export const emptyTokenUsage = (): TokenUsage => ({
  inputTokens: 0,
  outputTokens: 0,
  cacheCreationInputTokens: 0,
  cacheReadInputTokens: 0,
});

export function normalizeTokenUsage(raw: unknown): TokenUsage | undefined {
  if (!raw || typeof raw !== 'object') {
    return undefined;
  }

  const usage = raw as RawTokenUsage;
  const normalized: TokenUsage = {
    inputTokens: toNumber(usage.input_tokens),
    outputTokens: toNumber(usage.output_tokens),
    cacheCreationInputTokens: toNumber(usage.cache_creation_input_tokens),
    cacheReadInputTokens: toNumber(usage.cache_read_input_tokens),
  };

  return hasTokenUsage(normalized) ? normalized : undefined;
}

export function hasTokenUsage(usage?: TokenUsage): usage is TokenUsage {
  if (!usage) {
    return false;
  }

  return (
    usage.inputTokens > 0 ||
    usage.outputTokens > 0 ||
    usage.cacheCreationInputTokens > 0 ||
    usage.cacheReadInputTokens > 0
  );
}

export function addTokenUsage(target: TokenUsage, usage?: TokenUsage): TokenUsage {
  if (!usage) {
    return target;
  }

  target.inputTokens += usage.inputTokens;
  target.outputTokens += usage.outputTokens;
  target.cacheCreationInputTokens += usage.cacheCreationInputTokens;
  target.cacheReadInputTokens += usage.cacheReadInputTokens;
  return target;
}

export function buildTokenUsageSummary(messages: Array<{ usage?: TokenUsage; model?: string }>): TokenUsageSummary | undefined {
  const total = emptyTokenUsage();
  const byModel = new Map<string, TokenUsageByModel>();

  for (const message of messages) {
    if (!hasTokenUsage(message.usage)) {
      continue;
    }

    addTokenUsage(total, message.usage);

    const model = message.model || 'Unknown';
    const existing = byModel.get(model) || {
      model,
      messageCount: 0,
      ...emptyTokenUsage(),
    };

    existing.messageCount += 1;
    addTokenUsage(existing, message.usage);
    byModel.set(model, existing);
  }

  if (!hasTokenUsage(total)) {
    return undefined;
  }

  return {
    total,
    byModel: [...byModel.values()].sort((a, b) => {
      const aTotal = totalTokens(a);
      const bTotal = totalTokens(b);
      return bTotal - aTotal || a.model.localeCompare(b.model);
    }),
  };
}

export function totalTokens(usage: TokenUsage): number {
  return (
    usage.inputTokens +
    usage.outputTokens +
    usage.cacheCreationInputTokens +
    usage.cacheReadInputTokens
  );
}

function toNumber(value: unknown): number {
  return typeof value === 'number' && Number.isFinite(value) ? value : 0;
}
