import { describe, expect, it } from 'vitest';
import { fuzzyTextMatch } from '@/web/chat/utils/fuzzy-search';

describe('web fuzzy search', () => {
  it('matches empty queries so the unfiltered list stays visible', () => {
    expect(fuzzyTextMatch('任意内容', '')).toBe(true);
    expect(fuzzyTextMatch('任意内容', '   ')).toBe(true);
  });

  it('matches case-insensitive substrings in prompt and response text', () => {
    expect(fuzzyTextMatch('Agent 管家已经启动', '管家')).toBe(true);
    expect(fuzzyTextMatch('Codex conversation ready', 'CODEX')).toBe(true);
  });

  it('matches fuzzy character sequences across whitespace and punctuation', () => {
    expect(fuzzyTextMatch('Codex conversation ready', 'ccr')).toBe(true);
    expect(fuzzyTextMatch('prompt: 查 task 输出\nresponse: 已完成', 'tsk已完')).toBe(true);
  });

  it('requires every query token to match', () => {
    expect(fuzzyTextMatch('prompt 更新 cui response 发布 npm', 'cui npm')).toBe(true);
    expect(fuzzyTextMatch('prompt 更新 cui response 发布 npm', 'cui discord')).toBe(false);
  });
});
