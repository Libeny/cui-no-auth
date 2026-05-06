import { describe, it, expect, vi } from 'vitest';
import { CodexHistoryIndexer } from '@/services/codex/codex-history-indexer';

vi.mock('@/services/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('CodexHistoryIndexer', () => {
  it('defaults to a 30 second polling interval', () => {
    const indexer = new CodexHistoryIndexer({ listMetadata: vi.fn() } as any);

    expect((indexer as any).intervalMs).toBe(30000);
  });

  it('publishes created and modified events based on file state', async () => {
    const reader = {
      listMetadata: vi.fn()
        .mockResolvedValueOnce([
          metadata('codex:session-1', '/tmp/session-1.jsonl', 100, 1, '2026-05-06T00:00:00Z'),
        ])
        .mockResolvedValueOnce([
          metadata('codex:session-1', '/tmp/session-1.jsonl', 200, 2, '2026-05-06T00:00:01Z'),
        ]),
    };
    const bus = { publish: vi.fn() };
    const indexer = new CodexHistoryIndexer(reader as any, { intervalMs: 1000 });
    indexer.setSessionUpdateBus(bus as any);

    await indexer.runScanCycleForTest();
    await indexer.runScanCycleForTest();

    expect(bus.publish).toHaveBeenNthCalledWith(1, expect.objectContaining({
      sessionId: 'codex:session-1',
      eventType: 'created',
    }));
    expect(bus.publish).toHaveBeenNthCalledWith(2, expect.objectContaining({
      sessionId: 'codex:session-1',
      eventType: 'modified',
    }));
  });
});

function metadata(
  sessionId: string,
  filePath: string,
  fileSize: number,
  lastScannedAt: number,
  updatedAt: string,
) {
  return {
    sessionId,
    rawSessionId: sessionId.replace(/^codex:/, ''),
    filePath,
    projectPath: '/repo',
    summary: 'Codex task',
    messageCount: 1,
    totalDuration: 0,
    model: 'gpt-5.4',
    createdAt: '2026-05-06T00:00:00Z',
    updatedAt,
    fileSize,
    lastScannedAt,
  };
}
