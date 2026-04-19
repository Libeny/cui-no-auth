import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { diffLines } from 'diff';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';
import type { ConversationSummary, SessionInfo } from '../types/index.js';
import { SessionUpdateBus } from './session-update-bus.js';

interface IndexedMetadata {
  sessionId: string;
  summary?: string;
  projectPath?: string;
  messageCount: number;
  totalDuration: number;
  model: string;
  createdAt?: string;
  updatedAt?: string;
  lastScannedAt: number;
  filePath?: string;
  fileSize?: number;
  // Tool metrics
  linesAdded?: number;
  linesRemoved?: number;
  editCount?: number;
  writeCount?: number;
}

type TextContentBlock = {
  type: 'text';
  text: string;
};

type ToolUseContentBlock = {
  type: 'tool_use';
  name: string;
  input?: Record<string, unknown>;
};

type MessageContentBlock = TextContentBlock | ToolUseContentBlock | { type: string };

type HistoryEntryMessage = {
  model?: string;
  content?: string | MessageContentBlock[];
};

type HistoryEntry = {
  type?: string;
  timestamp?: string;
  cwd?: string;
  isSidechain?: boolean;
  durationMs?: number;
  message?: string | HistoryEntryMessage;
};

export class HistoryIndexer {
  private static readonly POLL_INTERVAL_MS = 15000;
  private logger: Logger;
  private claudeHomePath: string;
  private sessionInfoService: SessionInfoService;
  private sessionUpdateBus?: SessionUpdateBus;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private isScanInProgress = false;

  constructor(sessionInfoService?: SessionInfoService) {
    this.logger = createLogger('HistoryIndexer');
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
  }

  setSessionUpdateBus(sessionUpdateBus: SessionUpdateBus): void {
    this.sessionUpdateBus = sessionUpdateBus;
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Indexer is already running');
      return;
    }
    
    this.isRunning = true;
    this.shouldStop = false;
    
    // Initial scan to sync DB
    this.logger.info('Starting initial history scan...');
    try {
      await this.runScanCycle();
      this.logger.info('Initial scan completed');
    } catch (error) {
      this.logger.error('Initial scan failed', error);
    }

    this.startPolling();
  }

  stop(): void {
    this.shouldStop = true;
    this.isRunning = false;
    if (this.pollTimer) {
        clearInterval(this.pollTimer);
        this.pollTimer = undefined;
    }
  }

  private startPolling(): void {
    const projectsDir = path.join(this.claudeHomePath, 'projects');

    if (!fs.existsSync(projectsDir)) {
      this.logger.warn(`Projects directory not found for polling: ${projectsDir}`);
      return;
    }

    if (this.pollTimer) {
      return;
    }

    this.logger.info(`Starting history polling on ${projectsDir}`, {
      intervalMs: HistoryIndexer.POLL_INTERVAL_MS,
    });

    this.pollTimer = setInterval(() => {
      void this.runScanCycle();
    }, HistoryIndexer.POLL_INTERVAL_MS);
  }

  private async runScanCycle(): Promise<void> {
    if (this.shouldStop || this.isScanInProgress) {
      return;
    }

    this.isScanInProgress = true;
    try {
      await this.scanAndIndex();
    } finally {
      this.isScanInProgress = false;
    }
  }

  private async scanAndIndex(): Promise<void> {
    const projectsDir = path.join(this.claudeHomePath, 'projects');
    
    if (!fs.existsSync(projectsDir)) {
      this.logger.warn(`Projects directory not found: ${projectsDir}`);
      return;
    }

    // Get all known sessions from DB to check file state
    const knownSessions = await this.sessionInfoService.getAllSessionInfo();
    const batchSize = 50;
    let currentBatch: IndexedMetadata[] = [];
    let currentEvents: Array<{ sessionId: string; eventType: 'created' | 'modified'; metadata: IndexedMetadata }> = [];
    
    try {
      const projectDirs = await fsPromises.readdir(projectsDir);
      
      for (const projectDirName of projectDirs) {
        if (this.shouldStop) break;
        
        const fullProjectDir = path.join(projectsDir, projectDirName);
        const stats = await fsPromises.stat(fullProjectDir);
        
        if (!stats.isDirectory()) continue;
        
        // Scan files in project directory
        const files = await fsPromises.readdir(fullProjectDir);
        const jsonlFiles = files.filter(f => f.endsWith('.jsonl') && !f.startsWith('agent-'));
        
        for (const file of jsonlFiles) {
          if (this.shouldStop) break;
          
          const filePath = path.join(fullProjectDir, file);
          
          try {
            const fileStats = await fsPromises.stat(filePath);
            const sessionId = file.replace('.jsonl', '');
            const existingInfo = knownSessions[sessionId];
            const hasSamePath = existingInfo?.file_path === filePath;
            const hasSameMtime = existingInfo?.last_scanned_at === fileStats.mtimeMs;
            const hasSameSize = existingInfo?.file_size === fileStats.size;

            if (existingInfo && hasSamePath && hasSameMtime && hasSameSize) {
              continue;
            }
            
            // Parse and extract metadata
            const metadata = await this.extractMetadata(filePath, sessionId, fileStats.mtimeMs, fileStats.size);
            if (metadata) {
              currentBatch.push(metadata);
              currentEvents.push({
                sessionId,
                eventType: existingInfo ? 'modified' : 'created',
                metadata,
              });
            }
            
            // Flush batch if full
            if (currentBatch.length >= batchSize) {
              await this.flushBatch(currentBatch, currentEvents);
              currentBatch = [];
              currentEvents = [];
            }
            
          } catch (error) {
            this.logger.warn(`Failed to index file ${file}`, error);
          }
        }
      }
      
      // Flush remaining
      if (currentBatch.length > 0) {
        await this.flushBatch(currentBatch, currentEvents);
      }
      
    } catch (error) {
      this.logger.error('Error scanning projects', error);
      throw error;
    }
  }

  private async flushBatch(
    rows: IndexedMetadata[],
    events: Array<{ sessionId: string; eventType: 'created' | 'modified'; metadata: IndexedMetadata }>,
  ): Promise<void> {
    await this.sessionInfoService.bulkUpsertIndexedMetadata(rows);

    if (!this.sessionUpdateBus || events.length === 0) {
      return;
    }

    for (const event of events) {
      const current = await this.sessionInfoService.getExistingSessionInfo(event.sessionId);
      if (!current) {
        continue;
      }

      this.sessionUpdateBus.publish({
        sessionId: event.sessionId,
        eventType: event.eventType,
        metadata: this.buildConversationSummaryMetadata(event.sessionId, event.metadata, current),
        timestamp: new Date().toISOString(),
      });
    }
  }

  private async extractMetadata(filePath: string, sessionId: string, mtime: number, fileSize: number): Promise<IndexedMetadata | null> {
    return new Promise((resolve, reject) => {
      const fileStream = fs.createReadStream(filePath, { encoding: 'utf-8' });
      const rl = readline.createInterface({
        input: fileStream,
        crlfDelay: Infinity
      });

      let messageCount = 0;
      let totalDuration = 0;
      let model = 'Unknown';
      let summary = '';
      let projectPath = '';
      let firstTimestamp = '';
      let lastTimestamp = '';
      let foundModel = false;
      let firstUserMessage = '';

      // Tool metrics
      let linesAdded = 0;
      let linesRemoved = 0;
      let editCount = 0;
      let writeCount = 0;

      rl.on('line', (line) => {
        try {
          if (!line.trim()) return;
          
          // Fast JSON parse - we only need top level keys usually
          const entry = JSON.parse(line) as HistoryEntry;
          
          // Ignore sidechain messages (internal sub-agents)
          if (entry.isSidechain) {
            return;
          }

          // Capture timestamps
          if (entry.timestamp) {
            if (!firstTimestamp) firstTimestamp = entry.timestamp;
            lastTimestamp = entry.timestamp;
          }

          // Capture cwd/projectPath from ANY entry that has it
          if (!projectPath && entry.cwd) {
            projectPath = entry.cwd;
          }
          
          // 1. Count user/assistant messages
          if (entry.type === 'user' || entry.type === 'assistant') {
            messageCount++;
            
            if (entry.durationMs) {
              totalDuration += entry.durationMs;
            }
            
            // Extract model from first message that has it
            if (
              !foundModel &&
              entry.message &&
              typeof entry.message === 'object' &&
              entry.message.model
            ) {
              model = entry.message.model;
              foundModel = true;
            }

            // Capture first user message for fallback summary
            if (entry.type === 'user' && !firstUserMessage) {
              if (typeof entry.message === 'string') {
                firstUserMessage = entry.message;
              } else if (typeof entry.message === 'object') {
                 if (typeof entry.message.content === 'string') {
                   firstUserMessage = entry.message.content;
                 } else if (Array.isArray(entry.message.content)) {
                   // Extract text from content blocks
                   firstUserMessage = entry.message.content
                     .filter((block): block is TextContentBlock => block.type === 'text')
                     .map((block) => block.text)
                     .join(' ');
                 }
              }
            }

            // Extract tool metrics from assistant messages
            if (entry.type === 'assistant' && entry.message && typeof entry.message === 'object') {
              const msg = entry.message;
              if (Array.isArray(msg.content)) {
                for (const block of msg.content) {
                  if (block.type !== 'tool_use') continue;
                  if (!('name' in block)) continue;
                  const toolName = block.name;
                  if (!('input' in block)) continue;
                  const input = block.input;
                  if (!input) continue;

                  if (toolName === 'Edit') {
                    editCount++;
                    const oldStr = input.old_string;
                    const newStr = input.new_string;
                    if (typeof oldStr === 'string' && typeof newStr === 'string') {
                      for (const change of diffLines(oldStr, newStr)) {
                        if (change.added) linesAdded += change.count || 0;
                        else if (change.removed) linesRemoved += change.count || 0;
                      }
                    }
                  } else if (toolName === 'MultiEdit') {
                    const edits = input.edits as Array<{ old_string?: string; new_string?: string }> | undefined;
                    if (Array.isArray(edits)) {
                      editCount += edits.length;
                      for (const edit of edits) {
                        const oldStr = edit.old_string;
                        const newStr = edit.new_string;
                        if (typeof oldStr === 'string' && typeof newStr === 'string') {
                          for (const change of diffLines(oldStr, newStr)) {
                            if (change.added) linesAdded += change.count || 0;
                            else if (change.removed) linesRemoved += change.count || 0;
                          }
                        }
                      }
                    }
                  } else if (toolName === 'Write') {
                    writeCount++;
                    const content = input.content;
                    if (typeof content === 'string' && content.length > 0) {
                      const lines = content.split('\n');
                      linesAdded += lines[lines.length - 1] === '' ? lines.length - 1 : lines.length;
                    }
                  }
                }
              }
            }
          }
          
        } catch {
          // Ignore parse errors
        }
      });

      rl.on('close', () => {
        // Use truncated first user message as the summary
        if (firstUserMessage) {
          summary = firstUserMessage.slice(0, 100).replace(/\n/g, ' ');
          if (firstUserMessage.length > 100) summary += '...';
        }

        if (messageCount === 0 && !summary) {
            resolve(null); // Empty or invalid file
            return;
        }

        resolve({
          sessionId,
          summary: summary || undefined,
          projectPath: projectPath || undefined,
          messageCount,
          totalDuration,
          model,
          createdAt: firstTimestamp || new Date(mtime).toISOString(),
          updatedAt: lastTimestamp || new Date(mtime).toISOString(),
          lastScannedAt: mtime,
          filePath,
          fileSize,
          // Tool metrics (only include if there were any tool operations)
          linesAdded: (linesAdded || linesRemoved || editCount || writeCount) ? linesAdded : undefined,
          linesRemoved: (linesAdded || linesRemoved || editCount || writeCount) ? linesRemoved : undefined,
          editCount: (linesAdded || linesRemoved || editCount || writeCount) ? editCount : undefined,
          writeCount: (linesAdded || linesRemoved || editCount || writeCount) ? writeCount : undefined
        });
      });

      rl.on('error', (err) => {
        fileStream.destroy();
        reject(err);
      });
    });
  }

  private buildConversationSummaryMetadata(
    sessionId: string,
    metadata: IndexedMetadata,
    sessionInfo: SessionInfo & { sessionId: string },
  ): ConversationSummary {
    return {
      sessionId,
      projectPath: metadata.projectPath || '',
      summary: metadata.summary || 'No summary available',
      sessionInfo,
      createdAt: metadata.createdAt || sessionInfo.created_at,
      updatedAt: metadata.updatedAt || sessionInfo.updated_at,
      messageCount: metadata.messageCount || 0,
      totalDuration: metadata.totalDuration || 0,
      model: metadata.model || 'Unknown',
      status: 'completed',
      toolMetrics:
        metadata.linesAdded !== undefined ||
        metadata.linesRemoved !== undefined ||
        metadata.editCount !== undefined ||
        metadata.writeCount !== undefined
          ? {
              linesAdded: metadata.linesAdded ?? 0,
              linesRemoved: metadata.linesRemoved ?? 0,
              editCount: metadata.editCount ?? 0,
              writeCount: metadata.writeCount ?? 0,
            }
          : undefined,
    };
  }
}
