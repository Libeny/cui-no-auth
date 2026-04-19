import { EventEmitter } from 'events';
import type { SessionListUpdateEventData } from '../types/index.js';

export interface SessionUpdateEvent {
  sessionId: string;
  eventType: SessionListUpdateEventData['eventType'];
  metadata: SessionListUpdateEventData['metadata'];
  timestamp: string;
}

type SessionUpdateListener = (event: SessionUpdateEvent) => void;

export class SessionUpdateBus {
  private emitter = new EventEmitter();
  private readonly eventName = 'session-update';

  publish(event: SessionUpdateEvent): void {
    this.emitter.emit(this.eventName, event);
  }

  subscribe(listener: SessionUpdateListener): () => void {
    this.emitter.on(this.eventName, listener);
    return () => {
      this.emitter.off(this.eventName, listener);
    };
  }
}
