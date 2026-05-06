import { Router, Request } from 'express';
import type { ConversationListQuery } from '@/types/index.js';
import type { CodexHistoryReader } from '@/services/codex/codex-history-reader.js';
import { createLogger } from '@/services/logger.js';
import { RequestWithRequestId } from '@/types/express.js';

export function createCodexConversationRoutes(
  historyReader: Pick<CodexHistoryReader, 'listConversations' | 'fetchConversationDetails'>,
): Router {
  const router = Router();
  const logger = createLogger('CodexConversationRoutes');

  router.get('/', async (
    req: Request<Record<string, never>, unknown, Record<string, never>, Record<string, unknown>> & RequestWithRequestId,
    res,
    next,
  ) => {
    const requestId = req.requestId;
    const query = normalizeListQuery(req.query);
    logger.debug('List Codex conversations request', { requestId, query });

    try {
      const result = await historyReader.listConversations(query);
      res.json(result);
    } catch (error) {
      logger.debug('List Codex conversations failed', {
        requestId,
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  router.get('/:sessionId', async (req: RequestWithRequestId, res, next) => {
    const requestId = req.requestId;
    const { sessionId } = req.params;
    logger.debug('Get Codex conversation details request', { requestId, sessionId });

    try {
      const details = await historyReader.fetchConversationDetails(sessionId);
      res.json(details);
    } catch (error) {
      logger.debug('Get Codex conversation details failed', {
        requestId,
        sessionId,
        error: error instanceof Error ? error.message : String(error),
      });
      next(error);
    }
  });

  return router;
}

function normalizeListQuery(query: Record<string, unknown>): ConversationListQuery {
  const normalized: ConversationListQuery = {};

  if (typeof query.projectPath === 'string') normalized.projectPath = query.projectPath;
  if (query.limit !== undefined) normalized.limit = toNumber(query.limit);
  if (query.offset !== undefined) normalized.offset = toNumber(query.offset);
  if (query.sortBy === 'created' || query.sortBy === 'updated') normalized.sortBy = query.sortBy;
  if (query.order === 'asc' || query.order === 'desc') normalized.order = query.order;
  if (query.archived !== undefined) normalized.archived = toBoolean(query.archived);
  if (query.pinned !== undefined) normalized.pinned = toBoolean(query.pinned);
  if (query.hasContinuation !== undefined) normalized.hasContinuation = toBoolean(query.hasContinuation);

  return normalized;
}

function toNumber(value: unknown): number | undefined {
  if (typeof value === 'number') return value;
  if (typeof value !== 'string') return undefined;
  const parsed = Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function toBoolean(value: unknown): boolean | undefined {
  if (typeof value === 'boolean') return value;
  if (typeof value !== 'string') return undefined;
  if (value === 'true') return true;
  if (value === 'false') return false;
  return undefined;
}
