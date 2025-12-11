import * as fs from 'fs/promises';
import * as fsSync from 'fs';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { ConversationSummary, ConversationMessage, ConversationListQuery, CUIError, ToolMetrics } from '@/types/index.js';
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
