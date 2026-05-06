import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as os from 'os';
import * as path from 'path';
import * as readline from 'readline';
import type {
  CodexConversationSummary,
  CodexJsonlEntry,
  CodexReaderOptions,
  CodexSessionMetadata,
} from './codex-types.js';
import { fromCodexSessionId, toCodexSessionId } from './codex-types.js';
import type {
  ConversationListQuery,
  ConversationMessage,
  ConversationDetailsResponse,
} from '@/types/index.js';
import { CUIError } from '@/types/index.js';
import { createLogger, type Logger } from '../logger.js';
import { parseCodexJsonlFile } from './codex-jsonl-parser.js';
import {
  extractCodexSessionMetadata,
  extractCodexTokenUsageSummary,
  mapCodexEntriesToConversationMessages,
  sanitizeCodexSummaryText,
} from './codex-event-mapper.js';
import { buildTokenUsageSummary } from '@/utils/token-usage.js';

export class CodexHistoryReader {
  private codexHomePath: string;
  private logger: Logger;
  private metadataCache = new Map<string, CodexSessionMetadata>();
  private fileStateCache = new Map<string, { fileSize: number; lastScannedAt: number; metadata: CodexSessionMetadata | null }>();
  private scanPromise?: Promise<CodexSessionMetadata[]>;

  constructor(options: CodexReaderOptions = {}) {
    this.codexHomePath = options.codexHomePath || path.join(os.homedir(), '.codex');
    this.logger = createLogger('CodexHistoryReader');
  }

  get homePath(): string {
    return this.codexHomePath;
  }

  async listConversations(filter?: ConversationListQuery): Promise<{ conversations: CodexConversationSummary[]; total: number }> {
    const metadata = await this.listMetadata({ preferCache: true });
    const conversations = metadata.map((item) => this.toConversationSummary(item));
    const filtered = this.applyFilters(conversations, filter);

    return {
      conversations: this.applyPagination(filtered, filter),
      total: filtered.length,
    };
  }

  async listMetadata(options: { preferCache?: boolean } = {}): Promise<CodexSessionMetadata[]> {
    if (options.preferCache && (this.metadataCache.size > 0 || this.scanPromise)) {
      return this.getCachedMetadata();
    }

    if (this.scanPromise) {
      return this.scanPromise;
    }

    const scanPromise = this.scanSessionMetadata();
    this.scanPromise = scanPromise;

    try {
      return await scanPromise;
    } finally {
      if (this.scanPromise === scanPromise) {
        this.scanPromise = undefined;
      }
    }
  }

  async fetchConversation(sessionId: string): Promise<ConversationMessage[]> {
    const rawSessionId = fromCodexSessionId(sessionId);
    const filePath = await this.locateSessionFile(rawSessionId);

    if (!filePath) {
      throw new CUIError('CODEX_CONVERSATION_NOT_FOUND', `Codex conversation ${sessionId} not found`, 404);
    }

    const entries = await parseCodexJsonlFile(filePath);
    const metadata = extractCodexSessionMetadata(filePath, entries);
    return mapCodexEntriesToConversationMessages(toCodexSessionId(rawSessionId), entries, metadata || undefined);
  }

  async fetchConversationDetails(sessionId: string): Promise<ConversationDetailsResponse> {
    const rawSessionId = fromCodexSessionId(sessionId);
    const filePath = await this.locateSessionFile(rawSessionId);

    if (!filePath) {
      throw new CUIError('CODEX_CONVERSATION_NOT_FOUND', `Codex conversation ${sessionId} not found`, 404);
    }

    const entries = await parseCodexJsonlFile(filePath);
    const metadata = extractCodexSessionMetadata(filePath, entries);
    if (!metadata) {
      throw new CUIError('CODEX_CONVERSATION_NOT_FOUND', `Codex conversation ${sessionId} not found`, 404);
    }

    const messages = mapCodexEntriesToConversationMessages(metadata.sessionId, entries, metadata);
    const usageSummary = extractCodexTokenUsageSummary(entries, metadata.model) || buildTokenUsageSummary(messages);
    return {
      messages,
      summary: metadata.summary,
      projectPath: metadata.projectPath,
      metadata: {
        totalDuration: metadata.totalDuration,
        model: metadata.model,
      },
      usageSummary,
    };
  }

  async getConversationMetadata(sessionId: string): Promise<CodexSessionMetadata | null> {
    const rawSessionId = fromCodexSessionId(sessionId);
    const cached = this.metadataCache.get(toCodexSessionId(rawSessionId));
    if (cached) return cached;

    const metadata = (await this.listMetadata()).find((item) => item.rawSessionId === rawSessionId);
    return metadata || null;
  }

  private async scanSessionMetadata(): Promise<CodexSessionMetadata[]> {
    const files = await this.findSessionFiles();
    const sessionsById = new Map<string, CodexSessionMetadata>();
    const currentFiles = new Set(files);

    for (const filePath of this.fileStateCache.keys()) {
      if (!currentFiles.has(filePath)) {
        this.fileStateCache.delete(filePath);
      }
    }

    for (const filePath of files) {
      try {
        const stats = await fs.stat(filePath);
        const cached = this.fileStateCache.get(filePath);
        if (cached && cached.fileSize === stats.size && cached.lastScannedAt === stats.mtimeMs) {
          if (cached.metadata) {
            sessionsById.set(cached.metadata.sessionId, cached.metadata);
          }
          continue;
        }

        const metadata = await this.extractMetadata(filePath, stats.mtimeMs, stats.size);
        this.fileStateCache.set(filePath, {
          fileSize: stats.size,
          lastScannedAt: stats.mtimeMs,
          metadata,
        });

        if (metadata) {
          sessionsById.set(metadata.sessionId, metadata);
        }
      } catch (error) {
        this.logger.warn('Failed to parse Codex session', { filePath, error });
      }
    }

    this.metadataCache = sessionsById;
    return this.getCachedMetadata();
  }

  private async findSessionFiles(): Promise<string[]> {
    const sessionsDir = path.join(this.codexHomePath, 'sessions');
    if (!fsSync.existsSync(sessionsDir)) return [];

    const files: string[] = [];
    await this.walkDirectory(sessionsDir, files);
    return files.filter((filePath) => filePath.endsWith('.jsonl') && path.basename(filePath).startsWith('rollout-')).sort();
  }

  private async walkDirectory(dirPath: string, files: string[]): Promise<void> {
    let entries: fsSync.Dirent[];
    try {
      entries = await fs.readdir(dirPath, { withFileTypes: true });
    } catch {
      return;
    }

    for (const entry of entries) {
      const fullPath = path.join(dirPath, entry.name);
      if (entry.isDirectory()) {
        await this.walkDirectory(fullPath, files);
      } else if (entry.isFile()) {
        files.push(fullPath);
      }
    }
  }

  private async locateSessionFile(rawSessionId: string): Promise<string | null> {
    const cached = this.metadataCache.get(toCodexSessionId(rawSessionId));
    if (cached?.filePath) {
      try {
        await fs.access(cached.filePath);
        return cached.filePath;
      } catch {
        this.metadataCache.delete(cached.sessionId);
        this.fileStateCache.delete(cached.filePath);
      }
    }

    const files = await this.findSessionFiles();

    const filenameMatch = files.find((filePath) => path.basename(filePath).includes(rawSessionId));
    if (filenameMatch) return filenameMatch;

    const metadata =
      (await this.listMetadata({ preferCache: true })).find((item) => item.rawSessionId === rawSessionId) ||
      (await this.listMetadata()).find((item) => item.rawSessionId === rawSessionId);

    return metadata?.filePath || null;
  }

  private getCachedMetadata(): CodexSessionMetadata[] {
    return Array.from(this.metadataCache.values()).sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime());
  }

  private async extractMetadata(filePath: string, lastScannedAt: number, fileSize: number): Promise<CodexSessionMetadata | null> {
    const stream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
    const rl = readline.createInterface({
      input: stream,
      crlfDelay: Infinity,
    });

    let rawSessionId = '';
    let projectPath = '';
    let model = 'Codex';
    let createdAt = '';
    let updatedAt = '';
    let firstUserMessage = '';
    let messageCount = 0;

    for await (const line of rl) {
      if (!line.trim()) continue;

      let entry: CodexJsonlEntry;
      try {
        entry = JSON.parse(line) as CodexJsonlEntry;
      } catch {
        continue;
      }

      if (entry.timestamp) {
        if (!createdAt) createdAt = entry.timestamp;
        updatedAt = entry.timestamp;
      }

      const payload = entry.payload;
      if (!payload || typeof payload !== 'object') continue;

      if (entry.type === 'session_meta') {
        const sessionMeta = payload as { id?: string; cwd?: string; timestamp?: string; model?: string; model_provider?: { model?: string } };
        rawSessionId ||= sessionMeta.id || '';
        projectPath ||= sessionMeta.cwd || '';
        model = sessionMeta.model_provider?.model || sessionMeta.model || model;
        createdAt ||= sessionMeta.timestamp || entry.timestamp || '';
        continue;
      }

      if (entry.type === 'turn_context') {
        const turnContext = payload as { cwd?: string; model?: string };
        projectPath ||= turnContext.cwd || '';
        model = turnContext.model || model;
        continue;
      }

      if (entry.type === 'response_item' && 'type' in payload && payload.type === 'message') {
        const message = this.extractMessageSummary(payload as { role?: string; content?: Array<{ type?: string; text?: string }> });
        if (!message) continue;

        messageCount++;
        if (message.role === 'user' && !firstUserMessage) {
          firstUserMessage = message.text;
        }
      }
    }

    if (!rawSessionId) {
      rawSessionId = this.inferSessionIdFromFilePath(filePath);
    }

    if (!rawSessionId) return null;

    const fallbackTime = new Date(lastScannedAt).toISOString();
    return {
      sessionId: toCodexSessionId(rawSessionId),
      rawSessionId,
      filePath,
      projectPath,
      summary: this.truncateSummary(firstUserMessage) || 'Codex session',
      messageCount,
      totalDuration: 0,
      model,
      createdAt: createdAt || fallbackTime,
      updatedAt: updatedAt || createdAt || fallbackTime,
      fileSize,
      lastScannedAt,
    };
  }

  private extractMessageSummary(payload: { role?: string; content?: Array<{ type?: string; text?: string }> }): { role: 'user' | 'assistant'; text: string } | null {
    if (payload.role !== 'user' && payload.role !== 'assistant') return null;

    const text = (payload.content || [])
      .filter((block) => block.type === 'input_text' || block.type === 'output_text' || block.type === 'text')
      .map((block) => block.text || '')
      .filter(Boolean)
      .join('\n')
      .trim();

    if (!text) return null;
    if (payload.role === 'user' && this.isSyntheticUserText(text)) return null;

    return {
      role: payload.role,
      text,
    };
  }

  private isSyntheticUserText(text: string): boolean {
    const trimmed = text.trim();
    return trimmed.startsWith('<environment_context>') || trimmed.startsWith('<user_instructions>');
  }

  private inferSessionIdFromFilePath(filePath: string): string {
    return path.basename(filePath).replace(/^rollout-/, '').replace(/\.jsonl$/, '');
  }

  private truncateSummary(summary: string): string {
    const cleaned = sanitizeCodexSummaryText(summary).replace(/\n/g, ' ');
    return cleaned.length > 100 ? `${cleaned.slice(0, 100)}...` : cleaned;
  }

  private toConversationSummary(metadata: CodexSessionMetadata): CodexConversationSummary {
    return {
      provider: 'codex',
      sessionId: metadata.sessionId,
      projectPath: metadata.projectPath,
      summary: metadata.summary,
      sessionInfo: {
        custom_name: '',
        created_at: metadata.createdAt,
        updated_at: metadata.updatedAt,
        version: 1,
        pinned: false,
        archived: false,
        continuation_session_id: '',
        initial_commit_head: '',
        permission_mode: 'default',
        summary: metadata.summary,
        project_path: metadata.projectPath,
        message_count: metadata.messageCount,
        total_duration: metadata.totalDuration,
        model: metadata.model,
        last_scanned_at: metadata.lastScannedAt,
        file_path: metadata.filePath,
        file_size: metadata.fileSize,
      },
      createdAt: metadata.createdAt,
      updatedAt: metadata.updatedAt,
      messageCount: metadata.messageCount,
      totalDuration: metadata.totalDuration,
      model: metadata.model,
      status: 'completed',
    };
  }

  private applyFilters<T extends CodexConversationSummary>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) return conversations;
    let filtered = conversations;

    if (filter.projectPath) {
      filtered = filtered.filter((conversation) => conversation.projectPath === filter.projectPath);
    }

    if (filter.archived !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo.archived) === filter.archived);
    }

    if (filter.pinned !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo.pinned) === filter.pinned);
    }

    if (filter.hasContinuation !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo.continuation_session_id) === filter.hasContinuation);
    }

    const sortBy = filter.sortBy === 'created' ? 'createdAt' : 'updatedAt';
    const order = filter.order === 'asc' ? 1 : -1;

    return [...filtered].sort((a, b) => {
      const aTime = new Date(a[sortBy] || 0).getTime();
      const bTime = new Date(b[sortBy] || 0).getTime();
      return (aTime - bTime) * order;
    });
  }

  private applyPagination<T>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) return conversations;
    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    return conversations.slice(offset, offset + limit);
  }
}
