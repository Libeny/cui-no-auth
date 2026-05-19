import * as fs from 'fs';
import * as fsPromises from 'fs/promises';
import * as path from 'path';
import * as os from 'os';
import * as readline from 'readline';
import { createLogger, type Logger } from './logger.js';
import { SessionInfoService } from './session-info-service.js';
import type { ConversationSummary, SessionInfo } from '../types/index.js';
import { SessionUpdateBus } from './session-update-bus.js';

interface IndexedMetadata {
  sessionId: string;
  summary?: string;
  projectPath?: string;
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

type MessageContentBlock = TextContentBlock | { type: string };

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
  summary?: string;
};

type ChangedSessionFile = {
  filePath: string;
  fileName: string;
  sessionId: string;
  mtime: number;
  fileSize: number;
  eventType: 'created' | 'modified';
};

const DEFAULT_CLAUDE_SCAN_CONCURRENCY = 4;
const MAX_SCAN_CONCURRENCY = 32;

export class HistoryIndexer {
  private logger: Logger;
  private claudeHomePath: string;
  private sessionInfoService: SessionInfoService;
  private sessionUpdateBus?: SessionUpdateBus;
  private isRunning: boolean = false;
  private shouldStop: boolean = false;
  private pollTimer?: NodeJS.Timeout;
  private isScanInProgress = false;
  private pollIntervalMs: number;
  private scanConcurrency: number;

  constructor(sessionInfoService?: SessionInfoService, options: { intervalMs?: number; scanConcurrency?: number } = {}) {
    this.logger = createLogger('HistoryIndexer');
    this.claudeHomePath = path.join(os.homedir(), '.claude');
    this.sessionInfoService = sessionInfoService || SessionInfoService.getInstance();
    this.pollIntervalMs = options.intervalMs ?? 30000;
    this.scanConcurrency = this.normalizeConcurrency(options.scanConcurrency, DEFAULT_CLAUDE_SCAN_CONCURRENCY);
  }

  setSessionUpdateBus(sessionUpdateBus: SessionUpdateBus): void {
    this.sessionUpdateBus = sessionUpdateBus;
  }

  setPollIntervalMs(intervalMs: number): void {
    this.pollIntervalMs = intervalMs;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
      this.startPolling();
    }
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
      intervalMs: this.pollIntervalMs,
    });

    this.pollTimer = setInterval(() => {
      void this.runScanCycle();
    }, this.pollIntervalMs);
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
      const changedFiles: ChangedSessionFile[] = [];
      
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

            changedFiles.push({
              filePath,
              fileName: file,
              sessionId,
              mtime: fileStats.mtimeMs,
              fileSize: fileStats.size,
              eventType: existingInfo ? 'modified' : 'created',
            });

          } catch (error) {
            this.logger.warn(`Failed to index file ${file}`, error);
          }
        }
      }

      const indexed = await this.mapWithConcurrency(changedFiles, this.scanConcurrency, async (file) => {
        if (this.shouldStop) return null;

        try {
          const metadata = await this.extractMetadata(file.filePath, file.sessionId, file.mtime, file.fileSize);
          return metadata ? { sessionId: file.sessionId, eventType: file.eventType, metadata } : null;
        } catch (error) {
          this.logger.warn(`Failed to index file ${file.fileName}`, error);
          return null;
        }
      });

      for (const result of indexed) {
        if (!result) continue;

        currentBatch.push(result.metadata);
        currentEvents.push(result);

        // Flush batch if full
        if (currentBatch.length >= batchSize) {
          await this.flushBatch(currentBatch, currentEvents);
          currentBatch = [];
          currentEvents = [];
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

  private async mapWithConcurrency<T, R>(
    items: T[],
    concurrency: number,
    mapper: (item: T) => Promise<R>
  ): Promise<R[]> {
    const results = new Array<R>(items.length);
    let nextIndex = 0;

    const workers = Array.from({ length: Math.min(concurrency, items.length) }, async () => {
      while (!this.shouldStop && nextIndex < items.length) {
        const currentIndex = nextIndex++;
        results[currentIndex] = await mapper(items[currentIndex]);
      }
    });

    await Promise.all(workers);
    return results;
  }

  private normalizeConcurrency(value: number | undefined, fallback: number): number {
    if (value === undefined || !Number.isFinite(value) || value <= 0) {
      return fallback;
    }

    return Math.min(Math.floor(value), MAX_SCAN_CONCURRENCY);
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

      let model = 'Unknown';
      let summary = '';
      let projectPath = '';
      let firstTimestamp = '';
      let foundModel = false;
      let firstUserMessage = '';
      let sawConversationEntry = false;
      let settled = false;

      const finish = () => {
        if (settled) return;
        settled = true;

        const fallbackTime = new Date(mtime).toISOString();
        const summaryText = summary || this.truncateSummary(firstUserMessage);
        if (!summaryText && !sawConversationEntry) {
          resolve(null);
          return;
        }

        resolve({
          sessionId,
          summary: summaryText || undefined,
          projectPath: projectPath || undefined,
          totalDuration: 0,
          model,
          createdAt: firstTimestamp || fallbackTime,
          updatedAt: fallbackTime,
          lastScannedAt: mtime,
          filePath,
          fileSize,
        });
      };

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
          }

          // Capture cwd/projectPath from ANY entry that has it
          if (!projectPath && entry.cwd) {
            projectPath = entry.cwd;
          }

          if (entry.type === 'summary' && typeof entry.summary === 'string') {
            summary = entry.summary;
            return;
          }
          
          if (entry.type === 'user' || entry.type === 'assistant') {
            sawConversationEntry = true;
            
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
              firstUserMessage = this.extractUserMessageText(entry.message);
              if (firstUserMessage) {
                rl.close();
                fileStream.destroy();
              }
            }
          }
          
        } catch {
          // Ignore parse errors
        }
      });

      rl.on('close', finish);

      rl.on('error', (err) => {
        if (settled) return;
        settled = true;
        fileStream.destroy();
        reject(err);
      });
    });
  }

  private extractUserMessageText(message: HistoryEntry['message']): string {
    if (typeof message === 'string') {
      return message.trim();
    }

    if (!message || typeof message !== 'object') {
      return '';
    }

    if (typeof message.content === 'string') {
      return message.content.trim();
    }

    if (!Array.isArray(message.content)) {
      return '';
    }

    return message.content
      .filter((block): block is TextContentBlock => block.type === 'text')
      .map((block) => block.text)
      .filter(Boolean)
      .join(' ')
      .trim();
  }

  private truncateSummary(summary: string): string {
    const cleaned = summary.replace(/\n/g, ' ').trim();
    return cleaned.length > 100 ? `${cleaned.slice(0, 100)}...` : cleaned;
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
      messageCount: 0,
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
