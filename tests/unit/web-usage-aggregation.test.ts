import { describe, expect, it } from 'vitest';
import {
  annotateMessagesWithUsagePresentation,
  buildConversationTurnMembership,
  buildConversationTurnOutline,
} from '@/web/chat/utils/usage-aggregation';
import type { ChatMessage, TokenUsage } from '@/web/chat/types';

const usage = (
  inputTokens: number,
  outputTokens: number,
  cacheCreationInputTokens = 0,
  cacheReadInputTokens = 0
): TokenUsage => ({
  inputTokens,
  outputTokens,
  cacheCreationInputTokens,
  cacheReadInputTokens,
});

const message = (overrides: Partial<ChatMessage> & Pick<ChatMessage, 'id' | 'type'>): ChatMessage => ({
  messageId: overrides.id,
  content: '',
  timestamp: '2026-05-07T00:00:00.000Z',
  ...overrides,
});

describe('usage aggregation presentation', () => {
  it('shows duplicated Claude block usage only on the last assistant entry and counts the turn once', () => {
    const messages = annotateMessagesWithUsagePresentation([
      message({ id: 'user-1', type: 'user', content: '请修改这个文件' }),
      message({
        id: 'assistant-thinking',
        type: 'assistant',
        modelCallId: 'msg_01',
        model: 'claude-sonnet-4-5',
        usage: usage(100, 10, 5, 40),
      }),
      message({
        id: 'assistant-tool',
        type: 'assistant',
        modelCallId: 'msg_01',
        model: 'claude-sonnet-4-5',
        usage: usage(100, 10, 5, 40),
      }),
    ]);

    expect(messages[1].usage).toBeUndefined();
    expect(messages[1].model).toBeUndefined();
    expect(messages[2].usage).toEqual(usage(100, 10, 5, 40));
    expect(messages[2].model).toBe('claude-sonnet-4-5');
    expect(messages[0].turnUsageSummary).toBeUndefined();
    expect(messages[2].turnStartMessageId).toBe('user-1');
    expect(messages[2].turnUsageSummary).toEqual({
      total: usage(100, 10, 5, 40),
      byModel: [
        {
          model: 'claude-sonnet-4-5',
          messageCount: 1,
          ...usage(100, 10, 5, 40),
        },
      ],
    });
  });

  it('aggregates all unique assistant calls in a user turn across tool results and models', () => {
    const messages = annotateMessagesWithUsagePresentation([
      message({ id: 'user-1', type: 'user', content: '先查再总结' }),
      message({
        id: 'assistant-tool',
        type: 'assistant',
        modelCallId: 'msg_01',
        model: 'claude-sonnet-4-5',
        usage: usage(300, 20, 0, 90),
      }),
      message({
        id: 'tool-result',
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' } as any],
      }),
      message({
        id: 'assistant-final',
        type: 'assistant',
        modelCallId: 'codex-call-1',
        model: 'gpt-5.5',
        usage: usage(80, 30, 0, 10),
      }),
    ]);

    expect(messages[0].turnUsageSummary).toBeUndefined();
    expect(messages[3].turnStartMessageId).toBe('user-1');
    expect(messages[3].turnUsageSummary).toEqual({
      total: usage(380, 50, 0, 100),
      byModel: [
        {
          model: 'claude-sonnet-4-5',
          messageCount: 1,
          ...usage(300, 20, 0, 90),
        },
        {
          model: 'gpt-5.5',
          messageCount: 1,
          ...usage(80, 30, 0, 10),
        },
      ],
    });
    expect(messages[2].turnUsageSummary).toBeUndefined();
  });

  it('builds a turn outline from user prompts and final assistant responses', () => {
    const messages = annotateMessagesWithUsagePresentation([
      message({
        id: 'user-1',
        type: 'user',
        content: [{ type: 'text', text: '第一轮问题' } as any],
      }),
      message({
        id: 'assistant-tool',
        type: 'assistant',
        content: [{ type: 'tool_use', id: 'tool-1', name: 'Read', input: {} } as any],
      }),
      message({
        id: 'tool-result',
        type: 'user',
        content: [{ type: 'tool_result', tool_use_id: 'tool-1', content: 'ok' } as any],
      }),
      message({
        id: 'assistant-final',
        type: 'assistant',
        content: [{ type: 'text', text: '第一轮最终回复' } as any],
      }),
      message({ id: 'user-2', type: 'user', content: '第二轮问题' }),
      message({ id: 'assistant-2', type: 'assistant', content: '第二轮回复' }),
    ]);

    expect(buildConversationTurnOutline(messages)).toEqual([
      {
        id: 'turn-user-1',
        index: 1,
        userMessageId: 'user-1',
        responseMessageId: 'assistant-final',
        prompt: '第一轮问题',
        response: '第一轮最终回复',
      },
      {
        id: 'turn-user-2',
        index: 2,
        userMessageId: 'user-2',
        responseMessageId: 'assistant-2',
        prompt: '第二轮问题',
        response: '第二轮回复',
      },
    ]);
  });

  it('maps every visible message to the active user turn for scroll synchronization', () => {
    const messages = [
      message({ id: 'system-before', type: 'system', content: 'system note' }),
      message({ id: 'user-1', type: 'user', content: '第一轮问题' }),
      message({ id: 'assistant-tool', type: 'assistant', content: '第一轮工具调用' }),
      message({ id: 'assistant-final', type: 'assistant', content: '第一轮最终回复' }),
      message({ id: 'user-2', type: 'user', content: '第二轮问题' }),
      message({ id: 'assistant-2', type: 'assistant', content: '第二轮回复' }),
    ];

    const outline = buildConversationTurnOutline(messages);

    expect(buildConversationTurnMembership(messages, outline)).toEqual({
      'user-1': 'turn-user-1',
      'assistant-tool': 'turn-user-1',
      'assistant-final': 'turn-user-1',
      'user-2': 'turn-user-2',
      'assistant-2': 'turn-user-2',
    });
  });
});
