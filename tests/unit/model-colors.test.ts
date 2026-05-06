import { describe, expect, it } from 'vitest';
import { getModelColorFamily } from '@/web/chat/utils/model-colors';

describe('model color family', () => {
  it('classifies official Claude, GPT, Codex, and external models', () => {
    expect(getModelColorFamily('claude-opus-4-7')).toBe('claude');
    expect(getModelColorFamily('gpt-5.5')).toBe('gpt');
    expect(getModelColorFamily('codex-mini-latest')).toBe('gpt');
    expect(getModelColorFamily('o3')).toBe('gpt');
    expect(getModelColorFamily('o3-mini')).toBe('gpt');
    expect(getModelColorFamily('glm-5.1')).toBe('external');
    expect(getModelColorFamily('chatgpt-4o-latest')).toBe('external');
    expect(getModelColorFamily('anthropic/claude-sonnet')).toBe('external');
  });
});
