import type { SessionListUpdateEventData, StreamEvent } from '../types/index.js';
import { createLogger, type Logger } from './logger.js';
import { StreamManager } from './stream-manager.js';
import { SessionUpdateBus, type SessionUpdateEvent } from './session-update-bus.js';

interface PendingSessionUpdate {
  sessionId: string;
  eventType: SessionListUpdateEventData['eventType'];
  metadata: SessionListUpdateEventData['metadata'];
  timestamp: string;
}

export class SessionUpdateBroadcaster {
  private logger: Logger;
  private pendingUpdates = new Map<string, PendingSessionUpdate>();
  private flushTimer?: NodeJS.Timeout;
  private unsubscribe?: () => void;
  private readonly flushIntervalMs: number;

  constructor(
    private readonly bus: SessionUpdateBus,
    private readonly streamManager: StreamManager,
    flushIntervalMs: number = 1000,
  ) {
    this.logger = createLogger('SessionUpdateBroadcaster');
    this.flushIntervalMs = flushIntervalMs;
  }

  start(): void {
    if (this.unsubscribe) {
      return;
    }

    this.unsubscribe = this.bus.subscribe((event) => {
      this.handleEvent(event);
    });
  }

  stop(): void {
    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (this.unsubscribe) {
      this.unsubscribe();
      this.unsubscribe = undefined;
    }

    this.pendingUpdates.clear();
  }

  private handleEvent(event: SessionUpdateEvent): void {
    this.pendingUpdates.set(event.sessionId, {
      sessionId: event.sessionId,
      eventType: event.eventType,
      metadata: event.metadata,
      timestamp: event.timestamp,
    });

    if (!this.flushTimer) {
      this.flushTimer = setTimeout(() => {
        this.flush().catch((error) => {
          this.logger.error('Failed to flush session update batch', error);
        });
      }, this.flushIntervalMs);
    }
  }

  private async flush(): Promise<void> {
    const updates = Array.from(this.pendingUpdates.values());
    this.pendingUpdates.clear();

    if (this.flushTimer) {
      clearTimeout(this.flushTimer);
      this.flushTimer = undefined;
    }

    if (updates.length === 0) {
      return;
    }

    this.logger.debug('Broadcasting session update batch', {
      updateCount: updates.length,
      sessionIds: updates.map((update) => update.sessionId),
    });

    for (const update of updates) {
      const event: StreamEvent = {
        type: 'session_list_update',
        timestamp: update.timestamp,
        data: {
          sessionId: update.sessionId,
          eventType: update.eventType,
          metadata: update.metadata,
        },
      };
      this.streamManager.broadcast('global', event);

      this.streamManager.broadcast(`session-${update.sessionId}`, {
        type: 'session_content_update',
        timestamp: update.timestamp,
        data: {
          sessionId: update.sessionId,
          updatedAt: update.metadata.updatedAt,
        },
      });
    }

    const latest = updates[updates.length - 1];
    this.streamManager.broadcast('global', {
      type: 'index_update',
      sessionId: latest.sessionId,
      timestamp: latest.timestamp,
    });
  }
}
