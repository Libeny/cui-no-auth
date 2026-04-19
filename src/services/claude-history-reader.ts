import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import {
  ConversationSummary,
  ConversationMessage,
  ConversationListQuery,
  CUIError,
  SubagentSummary,
  SubagentDetailsResponse,
  SessionInfo,
} from '@/types/index.js';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';
import { ToolMetricsService } from './ToolMetricsService.js';
import { MessageFilter } from './message-filter.js';
import Anthropic from '@anthropic-ai/sdk';

// Import RawJsonEntry locally
type RawJsonEntry = {
  type: string;
  uuid?: string;
  sessionId?: string;
  parentUuid?: string;
  timestamp?: string;
  message?: Anthropic.Message | Anthropic.MessageParam;
  cwd?: string;
  durationMs?: number;
  isSidechain?: boolean;
  userType?: string;
  version?: string;
  summary?: string;
  leafUuid?: string;
};

type IndexedSessionInfo = SessionInfo & { sessionId: string };

/**
 * Reads conversation history from Claude's local storage
 * optimized to use SQLite index for listing and stream processing for fetching details.
 */
export class ClaudeHistoryReader {
  private claudeHomePath: string;
  private logger: Logger;
  private sessionInfoService: SessionInfoService;
  private toolMetricsService: ToolMetricsService;
  private messageFilter: MessageFilter;
  
  constructor(sessionInfoService?: SessionInfoService) {
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.logger = createLogger('ClaudeHistoryReader');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.toolMetricsService = new ToolMetricsService();
    this.messageFilter = new MessageFilter();
  }

  get homePath(): string {
    return this.claudeHomePath;
  }

  /**
   * Clear the conversation cache 
   * (No-op in new architecture as we rely on DB index)
   */
  clearCache(): void {
    // Legacy method kept for compatibility
    this.logger.debug('clearCache called - operating in DB-backed mode');
  }

  /**
   * List all conversations using SQLite index
   */
  async listConversations(filter?: ConversationListQuery): Promise<{
    conversations: ConversationSummary[];
    total: number;
  }> {
    try {
      if (typeof this.sessionInfoService.getConversations === 'function') {
        const { conversations: sessionInfos, total } = await this.sessionInfoService.getConversations(filter || {});

        const conversations: ConversationSummary[] = sessionInfos.map((info) => {
          const sessionInfo = info as IndexedSessionInfo;

          return {
            sessionId: sessionInfo.sessionId,
            projectPath: sessionInfo.project_path || '',
            summary: sessionInfo.summary || 'No summary available',
            sessionInfo,
            createdAt: sessionInfo.created_at,
            updatedAt: sessionInfo.updated_at,
            messageCount: sessionInfo.message_count || 0,
            totalDuration: sessionInfo.total_duration || 0,
            model: sessionInfo.model || 'Unknown',
            status: 'completed' as const,
            toolMetrics: undefined,
          };
        });

        return {
          conversations,
          total
        };
      }

      return await this.listConversationsFromFilesystem(filter);
    } catch (error) {
      try {
        return await this.listConversationsFromFilesystem(filter);
      } catch {
        throw new CUIError('HISTORY_READ_FAILED', `Failed to read conversation history: ${error}`, 500);
      }
    }
  }

  /**
   * Fetch full conversation details by reading the JSONL file directly
   */
  async fetchConversation(sessionId: string): Promise<ConversationMessage[]> {
    try {
      const projectsDir = path.join(this.claudeHomePath, 'projects');
      const filePath = await this.locateSessionFile(projectsDir, sessionId);
      
      if (!filePath) {
        throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
      }

      // 2. Parse file
      const entries = await this.parseJsonlFile(filePath);
      
      // 3. Build chain
      const messages = this.buildConversationChain(sessionId, entries);
      
      if (!messages) {
         return [];
      }
      
      // 4. Apply filter
      return this.messageFilter.filterMessages(messages);
      
    } catch (error) {
      if (error instanceof CUIError) throw error;
      throw new CUIError('CONVERSATION_READ_FAILED', `Failed to read conversation: ${error}`, 500);
    }
  }

  async listSubagents(sessionId: string): Promise<SubagentSummary[]> {
    const sessionFilePath = await this.locateMainSessionFile(sessionId);
    if (!sessionFilePath) {
      throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
    }

    const files = await this.findSubagentFiles(sessionFilePath, sessionId);
    if (files.length === 0) {
      return [];
    }

    const subagents = await Promise.all(
      files.map(async (filePath) => {
        const rawEntries = await this.parseJsonlFile(filePath);
        const messages = this.buildConversationChain(sessionId, rawEntries) || [];
        const userMessages = messages.filter((message) => message.type === 'user');
        const assistantMessages = messages.filter((message) => message.type === 'assistant');
        const fileName = path.basename(filePath);
        const summary =
          this.extractFirstText(userMessages[0]?.message) ||
          this.extractFirstText(assistantMessages[0]?.message) ||
          fileName.replace(/\.jsonl$/, '');
        const firstTimestamp = messages[0]?.timestamp;
        const lastTimestamp = messages[messages.length - 1]?.timestamp;
        const model =
          assistantMessages.find((message) => message.model)?.model ||
          assistantMessages[0]?.model ||
          '';

        return {
          subagentId: fileName.replace(/\.jsonl$/, ''),
          sessionId,
          messageCount: messages.length,
          firstTimestamp,
          lastTimestamp,
          model,
          summary,
        } satisfies SubagentSummary;
      }),
    );

    return subagents.sort((a, b) => {
      const aTime = new Date(a.firstTimestamp || 0).getTime();
      const bTime = new Date(b.firstTimestamp || 0).getTime();
      return aTime - bTime;
    });
  }

  async fetchSubagentConversation(sessionId: string, subagentId: string): Promise<SubagentDetailsResponse> {
    const sessionFilePath = await this.locateMainSessionFile(sessionId);
    if (!sessionFilePath) {
      throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found`, 404);
    }

    const subagentFilePath = await this.findSubagentFile(sessionFilePath, sessionId, subagentId);
    if (!subagentFilePath) {
      throw new CUIError('SUBAGENT_NOT_FOUND', `Sub-agent ${subagentId} not found`, 404);
    }

    const entries = await this.parseJsonlFile(subagentFilePath);
    const messages = this.buildConversationChain(sessionId, entries) || [];
    const assistantMessages = messages.filter((message) => message.type === 'assistant');
    const model =
      assistantMessages.find((message) => message.model)?.model ||
      assistantMessages[0]?.model ||
      'Unknown';
    const totalDuration = messages.reduce((sum, message) => sum + (message.durationMs || 0), 0);
    const subagents = await this.listSubagents(sessionId);
    const subagent = subagents.find((item) => item.subagentId === subagentId) || {
      subagentId,
      sessionId,
      messageCount: messages.length,
      firstTimestamp: messages[0]?.timestamp,
      lastTimestamp: messages[messages.length - 1]?.timestamp,
      model,
      summary: this.extractFirstText(messages[0]?.message) || subagentId,
    };

    return {
      subagent,
      messages: this.messageFilter.filterMessages(messages),
      metadata: {
        totalDuration,
        model,
      },
    };
  }

  /**
   * Get conversation metadata
   */
  async getConversationMetadata(sessionId: string): Promise<{
    summary: string;
    projectPath: string;
    model: string;
    totalDuration: number;
  } | null> {
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      const hasIndexedMetadata =
        Boolean(info.summary) ||
        Boolean(info.project_path) ||
        Boolean(info.model) ||
        Boolean(info.total_duration);

      if (!hasIndexedMetadata) {
        const fallback = await this.getConversationMetadataFromFile(sessionId);
        return fallback;
      }

      return {
        summary: info.summary || 'No summary',
        projectPath: info.project_path || '',
        model: info.model || 'Unknown',
        totalDuration: info.total_duration || 0
      };
    } catch (error) {
      this.logger.error('Error getting metadata for conversation', error, { sessionId });
      return null;
    }
  }

  /**
   * Get the working directory for a specific conversation session
   */
  async getConversationWorkingDirectory(sessionId: string): Promise<string | null> {
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      return info.project_path || null;
    } catch {
      return null;
    }
  }

  private async findProjectPathForSession(sessionId: string): Promise<string | null> {
    const info = await this.sessionInfoService.getSessionInfo(sessionId);
    return info.project_path || null;
  }

  private async locateMainSessionFile(sessionId: string): Promise<string | null> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');
    return this.locateSessionFile(projectsDir, sessionId);
  }

  private async findSubagentFiles(sessionFilePath: string, sessionId: string): Promise<string[]> {
    const sessionDir = path.dirname(sessionFilePath);
    const candidates = new Set<string>();

    const nestedDir = path.join(sessionDir, 'subagents');
    try {
      const nestedEntries = await fs.readdir(nestedDir);
      nestedEntries
        .filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'))
        .forEach((entry) => candidates.add(path.join(nestedDir, entry)));
    } catch {
      // ignore
    }

    try {
      const siblingEntries = await fs.readdir(sessionDir);
      siblingEntries
        .filter((entry) => entry.startsWith('agent-') && entry.endsWith('.jsonl'))
        .forEach((entry) => candidates.add(path.join(sessionDir, entry)));
    } catch {
      // ignore
    }

    const matches: string[] = [];
    for (const candidate of candidates) {
      if (await this.subagentFileBelongsToSession(candidate, sessionId)) {
        matches.push(candidate);
      }
    }

    return matches.sort();
  }

  private async findSubagentFile(sessionFilePath: string, sessionId: string, subagentId: string): Promise<string | null> {
    const files = await this.findSubagentFiles(sessionFilePath, sessionId);
    return files.find((filePath) => path.basename(filePath, '.jsonl') === subagentId) || null;
  }

  private async subagentFileBelongsToSession(filePath: string, sessionId: string): Promise<boolean> {
    const entries = await this.parseJsonlFile(filePath);
    return entries.some((entry) => entry.sessionId === sessionId);
  }
  
  /**
   * Locate session file by scanning projects directory
   * This is a fallback if we can't derive path directly
   */
  private async locateSessionFile(projectsDir: string, sessionId: string): Promise<string | null> {
    // Optimization: Check index first (O(1) lookup)
    try {
      const info = await this.sessionInfoService.getSessionInfo(sessionId);
      if (info.file_path) {
        try {
          await fs.access(info.file_path);
          return info.file_path;
        } catch {
          this.logger.debug('Indexed file path not found on disk, falling back to scan', { sessionId, path: info.file_path });
        }
      }
    } catch (error) {
      this.logger.debug('Failed to query session info for file path', { sessionId, error });
    }

    try {
      const dirs = await fs.readdir(projectsDir);
      for (const dir of dirs) {
        try {
          const candidateDir = path.join(projectsDir, dir);
          const stat = await fs.stat(candidateDir);
          if (!stat.isDirectory()) continue;
          const files = await fs.readdir(candidateDir);
          for (const file of files) {
            if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;
            const potentialPath = path.join(candidateDir, file);
            const entries = await this.parseJsonlFile(potentialPath);
            if (entries.some((entry) => entry.sessionId === sessionId)) {
              return potentialPath;
            }
          }
        } catch {
          // continue
        }
      }
    } catch {
      return null;
    }
    return null;
  }

  /**
   * Parse a single JSONL file
   */
  private async parseJsonlFile(filePath: string): Promise<RawJsonEntry[]> {
    try {
      // Use readline for memory efficiency
      const fileStream = fsSync.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      const entries: RawJsonEntry[] = [];
      
      for await (const line of rl) {
        if (!line.trim()) continue;
        try {
          entries.push(JSON.parse(line));
        } catch {
          // ignore
        }
      }
      
      return entries;
    } catch (error) {
      this.logger.error('Failed to read JSONL file', error, { filePath });
      return [];
    }
  }

  private extractFirstText(message?: Anthropic.Message | Anthropic.MessageParam): string {
    if (!message || typeof message !== 'object') {
      return '';
    }

    const content = 'content' in message ? message.content : undefined;
    if (typeof content === 'string') {
      return content.trim().slice(0, 120);
    }

    if (Array.isArray(content)) {
      for (const block of content) {
        if (block && typeof block === 'object') {
          if ('text' in block && typeof block.text === 'string' && block.text.trim()) {
            return block.text.trim().slice(0, 120);
          }
          if ('thinking' in block && typeof (block as { thinking?: string }).thinking === 'string' && (block as { thinking?: string }).thinking?.trim()) {
            return (block as { thinking?: string }).thinking!.trim().slice(0, 120);
          }
        }
      }
    }

    return '';
  }
  
  /**
   * Reconstruct conversation chain from flat entries
   */
  private buildConversationChain(sessionId: string, entries: RawJsonEntry[]): ConversationMessage[] | null {
    const messages: ConversationMessage[] = entries
      .filter(
        (entry) =>
          (entry.type === 'user' || entry.type === 'assistant') &&
          (entry.sessionId === sessionId || !entry.sessionId)
      )
      .map(entry => ({
        uuid: entry.uuid || '',
        type: entry.type as 'user' | 'assistant' | 'system',
        message: entry.message!,
        timestamp: entry.timestamp || '',
        sessionId: entry.sessionId || sessionId,
        model: typeof entry.message === 'object' && entry.message && 'model' in entry.message ? String(entry.message.model || '') : undefined,
        parentUuid: entry.parentUuid,
        isSidechain: entry.isSidechain,
        userType: entry.userType,
        cwd: entry.cwd,
        version: entry.version,
        durationMs: entry.durationMs
      }));

    if (messages.length === 0) return null;
    
    // Reconstruct order
    // Map UUID -> Message
    const messageMap = new Map<string, ConversationMessage>();
    messages.forEach(m => messageMap.set(m.uuid, m));
    
    // Find roots (no parent or parent not in set) - usually just one root
    // But we need to reconstruct the linear chain.
    // For simple list display, sorting by timestamp is usually "good enough" but threading is better.
    // Let's use the recursive build logic from before but simplified.
    
    // Find the first message (usually no parentUuid)
    const head = messages.find(m => !m.parentUuid);
    if (!head) return messages.sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    const chain: ConversationMessage[] = [];
    const visited = new Set<string>();
    
    const traverse = (current: ConversationMessage) => {
        if (visited.has(current.uuid)) return;
        visited.add(current.uuid);
        chain.push(current);
        
        // Find children
        const children = messages.filter(m => m.parentUuid === current.uuid);
        children.sort((a, b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
        children.forEach(traverse);
    };
    
    traverse(head);
    
    // Add orphans
    const orphans = messages.filter(m => !visited.has(m.uuid));
    orphans.sort((a,b) => new Date(a.timestamp).getTime() - new Date(b.timestamp).getTime());
    
    return [...chain, ...orphans];
  }

  private decodeProjectPath(encodedPath: string): string {
    if (!encodedPath.startsWith('-')) {
      return encodedPath;
    }

    return encodedPath.replace(/^-/, '/').replace(/-/g, '/');
  }

  private applyFilters<T extends {
    projectPath?: string;
    createdAt?: string;
    updatedAt?: string;
    sessionInfo?: SessionInfo;
  }>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) {
      return conversations;
    }

    let filtered = conversations;

    if (filter.projectPath) {
      filtered = filtered.filter((conversation) => conversation.projectPath === filter.projectPath);
    }

    if (filter.archived !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo?.archived) === filter.archived);
    }

    if (filter.pinned !== undefined) {
      filtered = filtered.filter((conversation) => Boolean(conversation.sessionInfo?.pinned) === filter.pinned);
    }

    if (filter.hasContinuation !== undefined) {
      filtered = filtered.filter((conversation) => {
        const hasContinuation = Boolean(conversation.sessionInfo?.continuation_session_id);
        return hasContinuation === filter.hasContinuation;
      });
    }

    const sortBy = filter.sortBy === 'updated' ? 'updatedAt' : 'createdAt';
    const order = filter.order === 'asc' ? 1 : -1;

    return [...filtered].sort((a, b) => {
      const aTime = new Date(a[sortBy] || 0).getTime();
      const bTime = new Date(b[sortBy] || 0).getTime();
      return (aTime - bTime) * order;
    });
  }

  private applyPagination<T>(conversations: T[], filter?: ConversationListQuery): T[] {
    if (!filter) {
      return conversations;
    }

    const limit = filter.limit ?? 20;
    const offset = filter.offset ?? 0;
    return conversations.slice(offset, offset + limit);
  }

  private async listConversationsFromFilesystem(filter?: ConversationListQuery): Promise<{
    conversations: ConversationSummary[];
    total: number;
  }> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');

    try {
      const projectEntries = await fs.readdir(projectsDir, { withFileTypes: true });
      const conversations: ConversationSummary[] = [];

      for (const projectEntry of projectEntries) {
        if (!projectEntry.isDirectory()) continue;

        const projectDir = path.join(projectsDir, projectEntry.name);
        const files = await fs.readdir(projectDir);

        for (const file of files) {
          if (!file.endsWith('.jsonl') || file.startsWith('agent-')) continue;

          const filePath = path.join(projectDir, file);
          const scanned = await this.scanConversationFile(filePath, projectEntry.name);
          conversations.push(...scanned);
        }
      }

      const filtered = this.applyFilters(conversations, filter);
      return {
        conversations: this.applyPagination(filtered, filter),
        total: filtered.length,
      };
    } catch {
      return {
        conversations: [],
        total: 0,
      };
    }
  }

  private async scanConversationFile(filePath: string, projectDirName: string): Promise<ConversationSummary[]> {
    const entries = await this.parseJsonlFile(filePath);
    const summaryBySession = new Map<string, string>();
    let pendingSummary = '';

    for (const entry of entries) {
      if (entry.type === 'summary' && typeof entry.summary === 'string') {
        pendingSummary = entry.summary;
        continue;
      }

      if (!entry.sessionId) continue;
      if (pendingSummary && !summaryBySession.has(entry.sessionId)) {
        summaryBySession.set(entry.sessionId, pendingSummary);
        pendingSummary = '';
      }
    }

    const sessionIds = [...new Set(entries.map((entry) => entry.sessionId).filter((value): value is string => Boolean(value)))];
    const conversations: ConversationSummary[] = [];

    for (const sessionId of sessionIds) {
      const messages = this.buildConversationChain(sessionId, entries) || [];
      if (messages.length === 0) continue;

      const sessionInfo = await this.sessionInfoService.getSessionInfo(sessionId);
      const assistantMessages = messages.filter((message) => message.type === 'assistant');
      const totalDuration = messages.reduce((sum, message) => sum + (message.durationMs || 0), 0);
      const projectPath = messages.find((message) => message.cwd)?.cwd || this.decodeProjectPath(projectDirName);

      conversations.push({
        sessionId,
        projectPath,
        summary: summaryBySession.get(sessionId) || this.extractFirstText(messages[0]?.message) || 'No summary available',
        sessionInfo,
        createdAt: messages[0]?.timestamp || sessionInfo.created_at,
        updatedAt: messages[messages.length - 1]?.timestamp || sessionInfo.updated_at,
        messageCount: messages.length,
        totalDuration,
        model:
          assistantMessages.find((message) => message.model)?.model ||
          assistantMessages[0]?.model ||
          'Unknown',
        status: 'completed',
        toolMetrics: undefined,
      });
    }

    return conversations;
  }

  private async getConversationMetadataFromFile(sessionId: string): Promise<{
    summary: string;
    projectPath: string;
    model: string;
    totalDuration: number;
  } | null> {
    const filePath = await this.locateMainSessionFile(sessionId);
    if (!filePath) {
      return null;
    }

    const conversations = await this.scanConversationFile(filePath, path.basename(path.dirname(filePath)));
    const conversation = conversations.find((item) => item.sessionId === sessionId);
    if (!conversation) {
      return null;
    }

    return {
      summary: conversation.summary,
      projectPath: conversation.projectPath,
      model: conversation.model,
      totalDuration: conversation.totalDuration,
    };
  }
}
