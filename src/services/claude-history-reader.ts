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
  ToolMetrics,
  SubagentSummary,
  SubagentDetailsResponse,
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
      // Use SessionInfoService to query indexed data directly
      const { conversations: sessionInfos, total } = await this.sessionInfoService.getConversations(filter || {});
      
      // Map to ConversationSummary
      const conversations: ConversationSummary[] = sessionInfos.map((info: any) => {
        // info contains indexed fields (summary, project_path, etc.) and sessionId
        
        return {
          sessionId: info.sessionId,
          projectPath: info.project_path || '',
          summary: info.summary || 'No summary available',
          sessionInfo: info, // The info object itself is the session info
          createdAt: info.created_at,
          updatedAt: info.updated_at,
          messageCount: info.message_count || 0,
          totalDuration: info.total_duration || 0,
          model: info.model || 'Unknown',
          status: 'completed' as const,
          // toolMetrics is expensive to calculate, omit for list view or add to index later
          toolMetrics: undefined 
        };
      });

      return {
        conversations,
        total
      };
    } catch (error) {
      throw new CUIError('HISTORY_READ_FAILED', `Failed to read conversation history: ${error}`, 500);
    }
  }

  /**
   * Fetch full conversation details by reading the JSONL file directly
   */
  async fetchConversation(sessionId: string): Promise<ConversationMessage[]> {
    try {
      // 1. Locate the file
      const projectPath = await this.findProjectPathForSession(sessionId);
      if (!projectPath) {
        throw new CUIError('CONVERSATION_NOT_FOUND', `Conversation ${sessionId} not found in index`, 404);
      }

      // Convert project path to directory name (Claude's convention: replace / with -)
      // Note: projectPath stored in DB is real path (e.g., /Users/x/y). 
      // We need to scan the projects dir to find the matching folder name if we don't assume the mapping is just replace / with -
      // But usually Claude folder name IS encoded path.
      // However, finding the file is tricky if we don't know the exact folder name.
      // Let's try to find the file in filesystem.
      
      const projectsDir = path.join(this.claudeHomePath, 'projects');
      const filePath = await this.locateSessionFile(projectsDir, sessionId);
      
      if (!filePath) {
        throw new CUIError('FILE_NOT_FOUND', `Conversation file for ${sessionId} not found`, 404);
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
      if (!info.created_at) return null; // Not found or default

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
    } catch (error) {
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
      // Use 'any' cast if TypeScript complains about missing property before rebuild propagates types
      const info = await this.sessionInfoService.getSessionInfo(sessionId) as any;
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

    // Optimization: Try to guess the directory name from project path if available
    // But simplest reliable way is to look for {sessionId}.jsonl recursively or rely on finding it efficiently.
    // Since we don't store the *exact* file path in DB (only project path), we might need to search.
    
    // If we have project_path in DB, we can guess the folder name.
    const info = await this.sessionInfoService.getSessionInfo(sessionId);
    if (info.project_path) {
        // Try exact match first logic if possible, but Claude's encoding might vary.
        // Let's do a quick scan of projects dir because it's usually not too huge (directories count).
    }

    try {
      const dirs = await fs.readdir(projectsDir);
      for (const dir of dirs) {
        const potentialPath = path.join(projectsDir, dir, `${sessionId}.jsonl`);
        try {
            await fs.access(potentialPath);
            return potentialPath;
        } catch {
            // continue
        }
      }
    } catch (e) {
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
        } catch (e) {
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
      .filter(e => e.type === 'user' || e.type === 'assistant') // We primarily care about chat messages for the view
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
}
