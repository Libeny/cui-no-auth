import { describe, expect, it } from 'vitest';
import { formatMessageUsage } from '@/web/chat/utils/token-format';

describe('token usage formatting', () => {
  it('prints cache read before cache write', () => {
    expect(formatMessageUsage({
      inputTokens: 67_000,
      outputTokens: 7_600,
      cacheReadInputTokens: 2_400_000,
      cacheCreationInputTokens: 0,
    })).toBe('67k in · 7.6k out · 2.4M cache read · 0 cache write');
  });
});
