import { describe, it, expect, beforeEach } from 'vitest';
import { SessionInfoService } from '@/services/session-info-service';

describe('SessionInfoService with SQLite', () => {
  let service: SessionInfoService;

  beforeEach(async () => {
    SessionInfoService.resetInstance();
    service = new SessionInfoService(':memory:');
    await service.initialize();
  });

  it('should create and retrieve session info', async () => {
    const info = await service.getSessionInfo('sess1');
    expect(info.custom_name).toBe('');
    await service.updateCustomName('sess1', 'Test');
    const updated = await service.getSessionInfo('sess1');
    expect(updated.custom_name).toBe('Test');
  });

  it('should update session fields', async () => {
    await service.updateSessionInfo('sess2', { pinned: true });
    const info = await service.getSessionInfo('sess2');
    expect(info.pinned).toBe(true);
  });

  it('should delete session', async () => {
    await service.updateSessionInfo('sess3', { custom_name: 'Del' });
    await service.deleteSession('sess3');
    const all = await service.getAllSessionInfo();
    expect(all['sess3']).toBeUndefined();
  });

  it('should return all sessions', async () => {
    await service.updateSessionInfo('a', { custom_name: 'A' });
    await service.updateSessionInfo('b', { custom_name: 'B' });
    const all = await service.getAllSessionInfo();
    expect(Object.keys(all).sort()).toEqual(['a', 'b']);
  });

  it('should archive all sessions', async () => {
    await service.updateSessionInfo('a', { custom_name: 'A' });
    await service.updateSessionInfo('b', { custom_name: 'B' });
    const count = await service.archiveAllSessions();
    expect(count).toBe(2);
    const all = await service.getAllSessionInfo();
    expect(all['a'].archived).toBe(true);
    expect(all['b'].archived).toBe(true);
  });

  it('should sync missing sessions', async () => {
    const inserted = await service.syncMissingSessions(['x', 'y']);
    expect(inserted).toBe(2);
    const all = await service.getAllSessionInfo();
    expect(Object.keys(all).sort()).toEqual(['x', 'y']);
  });

  it('should provide stats', async () => {
    await service.updateSessionInfo('s', { custom_name: 'S' });
    const stats = await service.getStats();
    expect(stats.sessionCount).toBe(1);
    expect(stats.lastUpdated).toBeTypeOf('string');
  });

  it('should not return Codex-prefixed placeholder rows in Claude conversation lists', async () => {
    await service.bulkUpsertIndexedMetadata([
      {
        sessionId: 'claude-session',
        summary: 'Claude task',
        projectPath: '/repo',
        messageCount: 1,
        totalDuration: 0,
        model: 'claude',
        lastScannedAt: 1,
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:01.000Z',
      },
      {
        sessionId: 'codex:ghost-session',
        summary: 'No summary available',
        projectPath: '',
        messageCount: 0,
        totalDuration: 0,
        model: 'Unknown',
        lastScannedAt: 1,
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:02.000Z',
      },
    ]);

    const result = await service.getConversations({ limit: 20, offset: 0, sortBy: 'updated', order: 'desc' });

    expect(result.total).toBe(1);
    expect((result.conversations[0] as any).sessionId).toBe('claude-session');
  });

  it('should return only indexed Codex sessions in Codex conversation lists', async () => {
    await service.bulkUpsertIndexedMetadata([
      {
        sessionId: 'claude-session',
        summary: 'Claude task',
        projectPath: '/repo/claude',
        messageCount: 1,
        totalDuration: 0,
        model: 'claude',
        lastScannedAt: 1,
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:01.000Z',
        filePath: '/tmp/claude.jsonl',
        fileSize: 100,
      },
      {
        sessionId: 'codex:indexed-session',
        summary: 'Codex task',
        projectPath: '/repo/codex',
        messageCount: 3,
        totalDuration: 0,
        model: 'gpt-5.5',
        lastScannedAt: 2,
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:02.000Z',
        filePath: '/tmp/codex.jsonl',
        fileSize: 200,
      },
    ]);

    const result = await (service as any).getCodexConversations({ limit: 20, offset: 0, sortBy: 'updated', order: 'desc' });

    expect(result.total).toBe(1);
    expect(result.conversations[0]).toEqual(expect.objectContaining({
      sessionId: 'codex:indexed-session',
      summary: 'Codex task',
      project_path: '/repo/codex',
      model: 'gpt-5.5',
      file_path: '/tmp/codex.jsonl',
      file_size: 200,
    }));
  });

  it('should not return empty placeholder rows in conversation lists', async () => {
    await service.syncMissingSessions(['019df918-b3b9-7682-8aad-8586dc93cf76']);
    await service.bulkUpsertIndexedMetadata([
      {
        sessionId: 'claude-session',
        summary: 'Claude task',
        projectPath: '/repo',
        messageCount: 1,
        totalDuration: 0,
        model: 'claude',
        lastScannedAt: 1,
        createdAt: '2026-05-06T00:00:00.000Z',
        updatedAt: '2026-05-06T00:00:01.000Z',
      },
    ]);

    const result = await service.getConversations({ limit: 20, offset: 0, sortBy: 'updated', order: 'desc' });

    expect(result.total).toBe(1);
    expect((result.conversations[0] as any).sessionId).toBe('claude-session');
  });
});
