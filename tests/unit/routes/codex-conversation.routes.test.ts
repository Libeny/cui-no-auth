import { describe, it, expect, beforeEach, vi } from 'vitest';
import express from 'express';
import request from 'supertest';
import { createCodexConversationRoutes } from '@/routes/codex-conversation.routes';
import { CUIError } from '@/types';

vi.mock('@/services/logger.js', () => ({
  createLogger: vi.fn(() => ({
    info: vi.fn(),
    error: vi.fn(),
    fatal: vi.fn(),
    warn: vi.fn(),
    debug: vi.fn(),
  })),
}));

describe('Codex conversation routes', () => {
  let app: express.Application;
  let reader: {
    listConversations: ReturnType<typeof vi.fn>;
    fetchConversationDetails: ReturnType<typeof vi.fn>;
  };

  beforeEach(() => {
    app = express();
    app.use(express.json());
    reader = {
      listConversations: vi.fn(),
      fetchConversationDetails: vi.fn(),
    };

    app.use('/api/codex-conversations', createCodexConversationRoutes(reader as any));
    app.use((err: any, _req: any, res: any, _next: any) => {
      res.status(err.statusCode || 500).json({ error: err.message, code: err.code });
    });
  });

  it('lists Codex conversations using query filters', async () => {
    reader.listConversations.mockResolvedValue({
      conversations: [
        {
          provider: 'codex',
          sessionId: 'codex:session-1',
          projectPath: '/repo',
          summary: 'Test Codex',
          sessionInfo: { custom_name: '', created_at: '2026-05-06T00:00:00Z', updated_at: '2026-05-06T00:00:00Z', version: 1, pinned: false, archived: false, continuation_session_id: '', initial_commit_head: '', permission_mode: 'default' },
          createdAt: '2026-05-06T00:00:00Z',
          updatedAt: '2026-05-06T00:00:00Z',
          messageCount: 1,
          totalDuration: 0,
          model: 'gpt-5.4',
          status: 'completed',
        },
      ],
      total: 1,
    });

    const response = await request(app)
      .get('/api/codex-conversations?limit=10&offset=5&sortBy=updated&order=desc&projectPath=/repo');

    expect(response.status).toBe(200);
    expect(response.body.total).toBe(1);
    expect(response.body.conversations[0].sessionId).toBe('codex:session-1');
    expect(reader.listConversations).toHaveBeenCalledWith({
      limit: 10,
      offset: 5,
      sortBy: 'updated',
      order: 'desc',
      projectPath: '/repo',
    });
  });

  it('returns Codex conversation details', async () => {
    reader.fetchConversationDetails.mockResolvedValue({
      messages: [],
      summary: 'Codex details',
      projectPath: '/repo',
      metadata: { totalDuration: 0, model: 'gpt-5.4' },
      usageSummary: undefined,
    });

    const response = await request(app).get('/api/codex-conversations/codex:session-1');

    expect(response.status).toBe(200);
    expect(response.body.summary).toBe('Codex details');
    expect(reader.fetchConversationDetails).toHaveBeenCalledWith('codex:session-1');
  });

  it('passes not found errors through the route error handler', async () => {
    reader.fetchConversationDetails.mockRejectedValue(
      new CUIError('CODEX_CONVERSATION_NOT_FOUND', 'missing', 404),
    );

    const response = await request(app).get('/api/codex-conversations/codex:missing');

    expect(response.status).toBe(404);
    expect(response.body).toEqual({ error: 'missing', code: 'CODEX_CONVERSATION_NOT_FOUND' });
  });
});
