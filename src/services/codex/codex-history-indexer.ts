import { createLogger, type Logger } from '../logger.js';
import { SessionUpdateBus } from '../session-update-bus.js';
import type { CodexHistoryReader } from './codex-history-reader.js';
import type { CodexSessionMetadata } from './codex-types.js';
import type { ConversationSummary } from '@/types/index.js';

interface KnownCodexSessionState {
  filePath: string;
  fileSize?: number;
  lastScannedAt?: number;
  updatedAt: string;
}

interface CodexHistoryIndexerOptions {
  intervalMs?: number;
}

export class CodexHistoryIndexer {
  private readonly reader: Pick<CodexHistoryReader, 'listMetadata'>;
  private intervalMs: number;
  private readonly logger: Logger;
  private sessionUpdateBus?: SessionUpdateBus;
  private pollTimer?: NodeJS.Timeout;
  private isRunning = false;
  private isScanInProgress = false;
  private readonly knownSessions = new Map<string, KnownCodexSessionState>();

  constructor(reader: Pick<CodexHistoryReader, 'listMetadata'>, options: CodexHistoryIndexerOptions = {}) {
    this.reader = reader;
    this.intervalMs = options.intervalMs ?? 30000;
    this.logger = createLogger('CodexHistoryIndexer');
  }

  setSessionUpdateBus(sessionUpdateBus: SessionUpdateBus): void {
    this.sessionUpdateBus = sessionUpdateBus;
  }

  setPollIntervalMs(intervalMs: number): void {
    this.intervalMs = intervalMs;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = setInterval(() => {
        void this.runScanCycle();
      }, this.intervalMs);
    }
  }

  async start(): Promise<void> {
    if (this.isRunning) {
      this.logger.warn('Codex indexer is already running');
      return;
    }

    this.isRunning = true;
    await this.runScanCycle();
    this.pollTimer = setInterval(() => {
      void this.runScanCycle();
    }, this.intervalMs);
  }

  stop(): void {
    this.isRunning = false;
    if (this.pollTimer) {
      clearInterval(this.pollTimer);
      this.pollTimer = undefined;
    }
  }

  async runScanCycleForTest(): Promise<void> {
    await this.runScanCycle();
  }

  private async runScanCycle(): Promise<void> {
    if (this.isScanInProgress) return;

    this.isScanInProgress = true;
    try {
      const metadata = await this.reader.listMetadata();
      for (const item of metadata) {
        this.processMetadata(item);
      }
    } catch (error) {
      this.logger.warn('Codex history scan failed', { error });
    } finally {
      this.isScanInProgress = false;
    }
  }

  private processMetadata(metadata: CodexSessionMetadata): void {
    const previous = this.knownSessions.get(metadata.sessionId);
    const nextState: KnownCodexSessionState = {
      filePath: metadata.filePath,
      fileSize: metadata.fileSize,
      lastScannedAt: metadata.lastScannedAt,
      updatedAt: metadata.updatedAt,
    };

    if (!previous) {
      this.knownSessions.set(metadata.sessionId, nextState);
      this.publish('created', metadata);
      return;
    }

    const changed =
      previous.filePath !== nextState.filePath ||
      previous.fileSize !== nextState.fileSize ||
      previous.lastScannedAt !== nextState.lastScannedAt ||
      previous.updatedAt !== nextState.updatedAt;

    if (!changed) return;

    this.knownSessions.set(metadata.sessionId, nextState);
    this.publish('modified', metadata);
  }

  private publish(eventType: 'created' | 'modified', metadata: CodexSessionMetadata): void {
    if (!this.sessionUpdateBus) return;

    this.sessionUpdateBus.publish({
      sessionId: metadata.sessionId,
      eventType,
      metadata: this.toSummaryMetadata(metadata),
      timestamp: new Date().toISOString(),
    });
  }

  private toSummaryMetadata(metadata: CodexSessionMetadata): ConversationSummary & { provider: 'codex' } {
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
}
