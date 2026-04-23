import type { TokenUsage } from '../types';

export function formatTokenCount(value: number): string {
  if (value >= 1_000_000) {
    return `${trimNumber(value / 1_000_000)}M`;
  }

  if (value >= 1_000) {
    return `${trimNumber(value / 1_000)}k`;
  }

  return String(value);
}

export function formatMessageUsage(usage: TokenUsage): string {
  return [
    `${formatTokenCount(usage.inputTokens)} in`,
    `${formatTokenCount(usage.outputTokens)} out`,
    `${formatTokenCount(usage.cacheCreationInputTokens)} cache write`,
    `${formatTokenCount(usage.cacheReadInputTokens)} cache read`,
  ].join(' · ');
}

function trimNumber(value: number): string {
  const rounded = value >= 10 ? value.toFixed(0) : value.toFixed(1);
  return rounded.replace(/\.0$/, '');
}
