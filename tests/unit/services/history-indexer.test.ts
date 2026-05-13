import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest';
import * as fs from 'fs/promises';
import * as os from 'os';
import * as path from 'path';
import { HistoryIndexer } from '@/services/history-indexer';

vi.mock('@/services/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('HistoryIndexer', () => {
  let tempDir: string;

  beforeEach(async () => {
    tempDir = await fs.mkdtemp(path.join(os.tmpdir(), 'claude-history-indexer-'));
  });

  afterEach(async () => {
    await fs.rm(tempDir, { recursive: true, force: true });
  });

  it('defaults Claude Code scanning to 4 workers', () => {
    const indexer = new HistoryIndexer(mockSessionInfoService() as any);

    expect((indexer as any).scanConcurrency).toBe(4);
  });

  it('processes changed Claude Code session files with bounded concurrency', async () => {
    const projectsDir = path.join(tempDir, 'projects', 'repo');
    await fs.mkdir(projectsDir, { recursive: true });
    await Promise.all(
      Array.from({ length: 5 }, (_, index) =>
        fs.writeFile(path.join(projectsDir, `session-${index}.jsonl`), '{}\n', 'utf-8')
      )
    );

    const sessionInfoService = mockSessionInfoService();
    const indexer = new HistoryIndexer(sessionInfoService as any, { scanConcurrency: 2 });
    (indexer as any).claudeHomePath = tempDir;

    let activeWorkers = 0;
    let maxActiveWorkers = 0;
    vi.spyOn(indexer as any, 'extractMetadata').mockImplementation(async (
      filePath: string,
      sessionId: string,
      mtime: number,
      fileSize: number
    ) => {
      activeWorkers++;
      maxActiveWorkers = Math.max(maxActiveWorkers, activeWorkers);
      await new Promise(resolve => setTimeout(resolve, 20));
      activeWorkers--;

      return {
        sessionId,
        summary: sessionId,
        projectPath: '/repo',
        messageCount: 1,
        totalDuration: 0,
        model: 'claude',
        createdAt: '2026-05-14T00:00:00.000Z',
        updatedAt: '2026-05-14T00:00:01.000Z',
        lastScannedAt: mtime,
        filePath,
        fileSize,
      };
    });

    await (indexer as any).scanAndIndex();

    expect(maxActiveWorkers).toBe(2);
    expect(sessionInfoService.bulkUpsertIndexedMetadata).toHaveBeenCalledWith(
      expect.arrayContaining([
        expect.objectContaining({ sessionId: 'session-0' }),
        expect.objectContaining({ sessionId: 'session-4' }),
      ])
    );
  });
});

function mockSessionInfoService() {
  return {
    getAllSessionInfo: vi.fn().mockResolvedValue({}),
    bulkUpsertIndexedMetadata: vi.fn().mockResolvedValue(undefined),
    getExistingSessionInfo: vi.fn(),
  };
}
