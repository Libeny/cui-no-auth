import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { CodexHistoryReader } from '@/services/codex/codex-history-reader';

vi.mock('@/services/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('CodexHistoryReader', () => {
  let tempDir: string;
  let reader: CodexHistoryReader;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-history-'));
    reader = new CodexHistoryReader({ codexHomePath: tempDir });
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('defaults Codex scanning to 6 workers', () => {
    expect((reader as any).scanConcurrency).toBe(6);
  });

  it('lists Codex sessions from dated rollout JSONL files', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-123.jsonl', [
      sessionMeta({ id: 'session-123', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-123', 'Build the Codex viewer', '2026-05-06T01:02:04.000Z'),
      assistantMessage('Working on it', '2026-05-06T01:02:05.000Z'),
    ]);

    const result = await reader.listConversations();

    expect(result.total).toBe(1);
    expect(result.conversations[0]).toEqual(
      expect.objectContaining({
        sessionId: 'codex:session-123',
        projectPath: '/repo/app',
        summary: 'Build the Codex viewer',
        messageCount: 0,
        model: 'gpt-5.4',
        createdAt: '2026-05-06T01:02:03.000Z',
        status: 'completed',
      }),
    );
    expect(new Date(result.conversations[0].updatedAt).getTime()).toBeGreaterThan(0);
  });

  it('serves cached conversation metadata while an index scan is already running', async () => {
    const cached = {
      sessionId: 'codex:cached-session',
      rawSessionId: 'cached-session',
      filePath: path.join(tempDir, 'sessions/2026/05/06/rollout-cached-session.jsonl'),
      projectPath: '/repo/cached',
      summary: 'Cached Codex task',
      messageCount: 3,
      totalDuration: 0,
      model: 'gpt-5.4',
      createdAt: '2026-05-06T01:02:03.000Z',
      updatedAt: '2026-05-06T01:02:06.000Z',
      fileSize: 123,
      lastScannedAt: 456,
    };

    (reader as any).metadataCache = new Map([[cached.sessionId, cached]]);
    (reader as any).scanPromise = new Promise(() => {});

    const result = await reader.listConversations();

    expect(result.total).toBe(1);
    expect(result.conversations[0]).toEqual(
      expect.objectContaining({
        sessionId: 'codex:cached-session',
        projectPath: '/repo/cached',
        summary: 'Cached Codex task',
      }),
    );
  });

  it('lists Codex conversations from persistent index without scanning JSONL files', async () => {
    const sessionInfoService = {
      getCodexConversations: vi.fn().mockResolvedValue({
        conversations: [
          indexedSessionInfo({
            sessionId: 'codex:indexed-session',
            summary: 'Indexed Codex task',
            projectPath: '/repo/indexed',
            model: 'gpt-5.5',
            messageCount: 7,
            filePath: path.join(tempDir, 'sessions/2026/05/06/rollout-indexed-session.jsonl'),
            fileSize: 321,
            lastScannedAt: 987,
            createdAt: '2026-05-06T01:02:03.000Z',
            updatedAt: '2026-05-06T01:02:09.000Z',
          }),
        ],
        total: 1,
      }),
    };
    reader = new CodexHistoryReader({ codexHomePath: tempDir, sessionInfoService: sessionInfoService as any });
    const scanSpy = vi.spyOn(reader as any, 'scanSessionMetadata');

    const result = await reader.listConversations({ limit: 20, offset: 0 });

    expect(result.total).toBe(1);
    expect(result.conversations[0]).toEqual(expect.objectContaining({
      sessionId: 'codex:indexed-session',
      projectPath: '/repo/indexed',
      summary: 'Indexed Codex task',
      messageCount: 0,
      model: 'gpt-5.5',
    }));
    expect(scanSpy).not.toHaveBeenCalled();
  });

  it('reuses fresh indexed Codex metadata during scans without reparsing unchanged JSONL files', async () => {
    const relativePath = '2026/05/06/rollout-session-fresh.jsonl';
    await writeSessionFile(tempDir, relativePath, [
      sessionMeta({ id: 'session-fresh', cwd: '/repo/fresh', model: 'gpt-5.5', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-fresh', 'Use cached metadata', '2026-05-06T01:02:04.000Z'),
      assistantMessage('Done', '2026-05-06T01:02:05.000Z'),
    ]);
    const filePath = path.join(tempDir, 'sessions', relativePath);
    const stats = await fs.stat(filePath);
    const sessionInfoService = {
      getCodexConversations: vi.fn().mockResolvedValue({
        conversations: [
          indexedSessionInfo({
            sessionId: 'codex:session-fresh',
            summary: 'Use cached metadata',
            projectPath: '/repo/fresh',
            model: 'gpt-5.5',
            messageCount: 2,
            filePath,
            fileSize: stats.size,
            lastScannedAt: stats.mtimeMs,
            createdAt: '2026-05-06T01:02:03.000Z',
            updatedAt: '2026-05-06T01:02:05.000Z',
          }),
        ],
        total: 1,
      }),
      bulkUpsertIndexedMetadata: vi.fn(),
    };
    reader = new CodexHistoryReader({ codexHomePath: tempDir, sessionInfoService: sessionInfoService as any });
    const extractSpy = vi.spyOn(reader as any, 'extractMetadata');

    const metadata = await reader.listMetadata();

    expect(metadata).toHaveLength(1);
    expect(metadata[0]).toEqual(expect.objectContaining({
      sessionId: 'codex:session-fresh',
      filePath,
      fileSize: stats.size,
      lastScannedAt: stats.mtimeMs,
    }));
    expect(extractSpy).not.toHaveBeenCalled();
    expect(sessionInfoService.bulkUpsertIndexedMetadata).not.toHaveBeenCalled();
  });

  it('skips parsing heavy reasoning records when extracting list metadata', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-heavy-reasoning.jsonl', [
      sessionMeta({ id: 'session-heavy-reasoning', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-heavy-reasoning', 'Summarize without parsing COT', '2026-05-06T01:02:04.000Z'),
      {
        timestamp: '2026-05-06T01:02:05.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: `heavy-cot-marker-${'x'.repeat(1024)}`,
        },
      },
      assistantMessage('Done', '2026-05-06T01:02:06.000Z'),
    ]);
    const parseSpy = vi.spyOn(JSON, 'parse');

    await reader.listConversations();

    expect(parseSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('heavy-cot-marker'))).toBe(false);
    parseSpy.mockRestore();
  });

  it('uses fast metadata mode for large Codex files without parsing later message lines', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-large-fast.jsonl', [
      sessionMeta({ id: 'session-large-fast', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-large-fast', 'Open this large COT quickly', '2026-05-06T01:02:04.000Z'),
      assistantMessage(`large-message-marker-${'x'.repeat(1024 * 1024 + 1)}`, '2026-05-06T01:02:06.000Z'),
    ]);
    const parseSpy = vi.spyOn(JSON, 'parse');

    const result = await reader.listConversations();

    expect(result.conversations[0]).toEqual(expect.objectContaining({
      sessionId: 'codex:session-large-fast',
      summary: 'Open this large COT quickly',
    }));
    expect(parseSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('large-message-marker'))).toBe(false);
    parseSpy.mockRestore();
  });

  it('maps Codex messages and shell tools into ConversationMessage records', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-abc.jsonl', [
      sessionMeta({ id: 'session-abc', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-abc', 'Run tests', '2026-05-06T01:02:04.000Z'),
      reasoningEvent('2026-05-06T01:02:05.000Z'),
      assistantMessage('I will run the test command.', '2026-05-06T01:02:06.000Z'),
      functionCall('call-1', 'exec_command', { cmd: 'npm test', workdir: '/repo/app' }, '2026-05-06T01:02:07.000Z'),
      tokenCountEvent({
        input_tokens: 1200,
        cached_input_tokens: 400,
        output_tokens: 70,
      }, '2026-05-06T01:02:07.500Z', {
        input_tokens: 300,
        cached_input_tokens: 100,
        output_tokens: 20,
      }),
      execEnd('call-1', { stdout: 'ok\n', stderr: '', exit_code: 0 }, '2026-05-06T01:02:08.000Z'),
      functionOutput('call-1', 'ok\n', '2026-05-06T01:02:09.000Z'),
    ]);

    const messages = await reader.fetchConversation('codex:session-abc');

    expect(messages.map((message) => message.type)).toEqual(['user', 'assistant', 'user']);
    expect(messages.map((message) => message.model)).toEqual([undefined, 'gpt-5.4', undefined]);
    expect(messages[0].message).toEqual({ role: 'user', content: 'Run tests' });
    expect(messages[1].message).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'text', text: 'I will run the test command.' },
        {
          type: 'tool_use',
          id: 'call-1',
          name: 'Bash',
          input: { command: 'npm test', cwd: '/repo/app' },
        },
      ],
    });
    expect(messages[1].usage).toEqual({
      inputTokens: 200,
      outputTokens: 20,
      cacheCreationInputTokens: 0,
      cacheReadInputTokens: 100,
    });
    expect(messages[2].message).toMatchObject({
      role: 'user',
      content: [
        {
          type: 'tool_result',
          tool_use_id: 'call-1',
          content: 'ok\n',
          is_error: false,
        },
      ],
    });
  });

  it('skips synthetic environment context user messages', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-context.jsonl', [
      sessionMeta({ id: 'session-context', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-context', '<environment_context>\n  <cwd>/repo/app</cwd>\n</environment_context>', '2026-05-06T01:02:04.000Z'),
      userMessage('session-context', 'Show me Codex sessions', '2026-05-06T01:02:05.000Z'),
      assistantMessage('Here are the sessions.', '2026-05-06T01:02:06.000Z'),
    ]);

    const result = await reader.listConversations();
    const messages = await reader.fetchConversation('codex:session-context');

    expect(result.conversations[0].summary).toBe('Show me Codex sessions');
    expect(messages).toHaveLength(2);
    expect(JSON.stringify(messages)).not.toContain('environment_context');
  });

  it('strips leading launcher instructions from Codex list summaries', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-important.jsonl', [
      sessionMeta({ id: 'session-important', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage(
        'session-important',
        [
          'IMPORTANT: 不要读取或执行 ~/.claude/ 下的任何文件。只关注仓库代码。',
          '',
          '你正在解决 git merge 冲突。',
          '',
          '请解决所有冲突。',
        ].join('\n'),
        '2026-05-06T01:02:04.000Z',
      ),
      assistantMessage('Working on it', '2026-05-06T01:02:05.000Z'),
    ]);

    const result = await reader.listConversations();

    expect(result.conversations[0].summary).toBe('你正在解决 git merge 冲突。  请解决所有冲突。');
  });

  it('does not expose encrypted reasoning content as readable message text', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-private.jsonl', [
      sessionMeta({ id: 'session-private', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-private', 'Question', '2026-05-06T01:02:04.000Z'),
      reasoningEvent('2026-05-06T01:02:05.000Z'),
      assistantMessage('Answer', '2026-05-06T01:02:06.000Z'),
    ]);

    const messages = await reader.fetchConversation('codex:session-private');
    const serialized = JSON.stringify(messages);

    expect(serialized).not.toContain('sealed-cot');
    expect(messages).toHaveLength(2);
  });

  it('does not parse encrypted reasoning content when loading conversation details', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-private-fast.jsonl', [
      sessionMeta({ id: 'session-private-fast', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-private-fast', 'Question', '2026-05-06T01:02:04.000Z'),
      {
        timestamp: '2026-05-06T01:02:05.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [],
          encrypted_content: `encrypted-detail-marker-${'x'.repeat(1024)}`,
        },
      },
      assistantMessage('Answer', '2026-05-06T01:02:06.000Z'),
    ]);
    const parseSpy = vi.spyOn(JSON, 'parse');

    const details = await reader.fetchConversationDetails('session-private-fast');

    expect(details.messages).toHaveLength(2);
    expect(JSON.stringify(details.messages)).not.toContain('encrypted-detail-marker');
    expect(parseSpy.mock.calls.some(([line]) => typeof line === 'string' && line.includes('encrypted-detail-marker'))).toBe(false);
    parseSpy.mockRestore();
  });

  it('maps reasoning summaries when Codex records a readable summary', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-summary.jsonl', [
      sessionMeta({ id: 'session-summary', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-summary', 'Question', '2026-05-06T01:02:04.000Z'),
      {
        timestamp: '2026-05-06T01:02:05.000Z',
        type: 'response_item',
        payload: {
          type: 'reasoning',
          summary: [{ type: 'summary_text', text: 'Checked repository shape.' }],
          encrypted_content: 'sealed-cot',
        },
      },
      assistantMessage('Answer', '2026-05-06T01:02:06.000Z'),
    ]);

    const messages = await reader.fetchConversation('codex:session-summary');

    expect(messages[1].message).toMatchObject({
      role: 'assistant',
      content: [
        { type: 'thinking', thinking: 'Checked repository shape.' },
        { type: 'text', text: 'Answer' },
      ],
    });
    expect(JSON.stringify(messages)).not.toContain('sealed-cot');
  });

  it('extracts Codex token counts into conversation usage summary', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-tokens.jsonl', [
      sessionMeta({ id: 'session-tokens', cwd: '/repo/app', model: 'gpt-5.5', timestamp: '2026-05-06T01:02:03.000Z' }),
      userMessage('session-tokens', 'Question', '2026-05-06T01:02:04.000Z'),
      assistantMessage('Answer', '2026-05-06T01:02:05.000Z'),
      tokenCountEvent({
        input_tokens: 1000,
        cached_input_tokens: 250,
        output_tokens: 80,
      }, '2026-05-06T01:02:06.000Z'),
    ]);

    const details = await reader.fetchConversationDetails('session-tokens');

    expect(details.usageSummary).toEqual({
      total: {
        inputTokens: 750,
        outputTokens: 80,
        cacheCreationInputTokens: 0,
        cacheReadInputTokens: 250,
      },
      byModel: [
        {
          model: 'gpt-5.5',
          messageCount: 1,
          inputTokens: 750,
          outputTokens: 80,
          cacheCreationInputTokens: 0,
          cacheReadInputTokens: 250,
        },
      ],
    });
  });

  it('uses the active Codex turn model only on usage-bearing assistant messages', async () => {
    await writeSessionFile(tempDir, '2026/05/06/rollout-2026-05-06T01-02-03-session-model-switch.jsonl', [
      sessionMeta({ id: 'session-model-switch', cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:03.000Z' }),
      turnContext({ cwd: '/repo/app', model: 'gpt-5.4', timestamp: '2026-05-06T01:02:04.000Z' }),
      userMessage('session-model-switch', 'First question', '2026-05-06T01:02:05.000Z'),
      assistantMessage('First answer', '2026-05-06T01:02:06.000Z'),
      tokenCountEvent({ input_tokens: 100, output_tokens: 10 }, '2026-05-06T01:02:07.000Z', { input_tokens: 100, output_tokens: 10 }),
      turnContext({ cwd: '/repo/app', model: 'gpt-5.5', timestamp: '2026-05-06T01:02:08.000Z' }),
      assistantMessage('Second answer', '2026-05-06T01:02:09.000Z'),
      tokenCountEvent({ input_tokens: 200, output_tokens: 20 }, '2026-05-06T01:02:10.000Z', { input_tokens: 100, output_tokens: 10 }),
    ]);

    const messages = await reader.fetchConversation('codex:session-model-switch');

    expect(messages.map((message) => ({
      type: message.type,
      model: message.model,
      hasUsage: Boolean(message.usage),
    }))).toEqual([
      { type: 'user', model: undefined, hasUsage: false },
      { type: 'assistant', model: 'gpt-5.4', hasUsage: true },
      { type: 'assistant', model: 'gpt-5.5', hasUsage: true },
    ]);
  });
});

async function writeSessionFile(homePath: string, relativePath: string, entries: unknown[]): Promise<void> {
  const filePath = path.join(homePath, 'sessions', relativePath);
  await fs.mkdir(path.dirname(filePath), { recursive: true });
  await fs.writeFile(filePath, entries.map((entry) => JSON.stringify(entry)).join('\n'));
}

function sessionMeta({
  id,
  cwd,
  model,
  timestamp,
}: {
  id: string;
  cwd: string;
  model: string;
  timestamp: string;
}) {
  return {
    timestamp,
    type: 'session_meta',
    payload: {
      id,
      cwd,
      model_provider: { model },
      timestamp,
      cli_version: '1.0.0',
    },
  };
}

function userMessage(sessionId: string, text: string, timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'user',
      content: [{ type: 'input_text', text }],
      session_id: sessionId,
    },
  };
}

function assistantMessage(text: string, timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'message',
      role: 'assistant',
      content: [{ type: 'output_text', text }],
      phase: 'commentary',
    },
  };
}

function turnContext({
  cwd,
  model,
  timestamp,
}: {
  cwd: string;
  model: string;
  timestamp: string;
}) {
  return {
    timestamp,
    type: 'turn_context',
    payload: {
      cwd,
      model,
    },
  };
}

function indexedSessionInfo({
  sessionId,
  summary,
  projectPath,
  model,
  messageCount,
  filePath,
  fileSize,
  lastScannedAt,
  createdAt,
  updatedAt,
}: {
  sessionId: string;
  summary: string;
  projectPath: string;
  model: string;
  messageCount: number;
  filePath: string;
  fileSize: number;
  lastScannedAt: number;
  createdAt: string;
  updatedAt: string;
}) {
  return {
    sessionId,
    custom_name: '',
    created_at: createdAt,
    updated_at: updatedAt,
    version: 1,
    pinned: false,
    archived: false,
    continuation_session_id: '',
    initial_commit_head: '',
    permission_mode: 'default',
    summary,
    project_path: projectPath,
    message_count: messageCount,
    total_duration: 0,
    model,
    last_scanned_at: lastScannedAt,
    file_path: filePath,
    file_size: fileSize,
  };
}

function reasoningEvent(timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'reasoning',
      summary: [],
      encrypted_content: 'sealed-cot',
    },
  };
}

function tokenCountEvent(totalTokenUsage: Record<string, number>, timestamp: string, lastTokenUsage?: Record<string, number>) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'token_count',
      info: {
        total_token_usage: totalTokenUsage,
        ...(lastTokenUsage ? { last_token_usage: lastTokenUsage } : {}),
      },
    },
  };
}

function functionCall(callId: string, name: string, args: Record<string, unknown>, timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call',
      name,
      call_id: callId,
      arguments: JSON.stringify(args),
    },
  };
}

function execEnd(
  callId: string,
  output: { stdout: string; stderr: string; exit_code: number },
  timestamp: string,
) {
  return {
    timestamp,
    type: 'event_msg',
    payload: {
      type: 'exec_command_end',
      call_id: callId,
      stdout: output.stdout,
      stderr: output.stderr,
      exit_code: output.exit_code,
      status: output.exit_code === 0 ? 'completed' : 'failed',
    },
  };
}

function functionOutput(callId: string, output: string, timestamp: string) {
  return {
    timestamp,
    type: 'response_item',
    payload: {
      type: 'function_call_output',
      call_id: callId,
      output,
    },
  };
}
