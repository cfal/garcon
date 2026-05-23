// Event-emitting base for concrete agent runtimes. The composition root wires
// listeners for broadcasting and history cache persistence.
//
// Both emit and on wrappers are provided so the string event names
// are encapsulated here -- neither subclasses nor server.js need to
// know them.

import { EventEmitter } from 'events';
import type { AgentEventMetadata } from "../session-types.js";

export type MessagesCallback = (chatId: string, messages: unknown[], metadata?: AgentEventMetadata) => void;
export type ProcessingCallback = (chatId: string, isProcessing: boolean) => void;
export type SessionCreatedCallback = (chatId: string) => void;
export type FinishedCallback = (chatId: string, exitCode: number, metadata?: AgentEventMetadata) => void;
export type FailedCallback = (chatId: string, errorMessage: string) => void;

export class AgentEventEmitterRuntime extends EventEmitter {
  // Emit helpers (used by subclasses)

  emitMessages(chatId: string, messages: unknown[], metadata?: AgentEventMetadata): void {
    if (messages.length > 0) {
      if (metadata) {
        this.emit('messages', chatId, messages, metadata);
      } else {
        this.emit('messages', chatId, messages);
      }
    }
  }

  emitProcessing(chatId: string, isProcessing: boolean): void {
    this.emit('processing', chatId, isProcessing);
  }

  emitSessionCreated(chatId: string): void {
    this.emit('session-created', chatId);
  }

  emitFinished(chatId: string, exitCode: number = 0, metadata?: AgentEventMetadata): void {
    if (metadata) {
      this.emit('finished', chatId, exitCode, metadata);
    } else {
      this.emit('finished', chatId, exitCode);
    }
  }

  emitFailed(chatId: string, errorMessage: string): void {
    this.emit('failed', chatId, errorMessage);
  }

  // Listener helpers (used by composition root)

  onMessages(cb: MessagesCallback): void {
    this.on('messages', cb);
  }

  onProcessing(cb: ProcessingCallback): void {
    this.on('processing', cb);
  }

  onSessionCreated(cb: SessionCreatedCallback): void {
    this.on('session-created', cb);
  }

  onFinished(cb: FinishedCallback): void {
    this.on('finished', cb);
  }

  onFailed(cb: FailedCallback): void {
    this.on('failed', cb);
  }
}
