// Event-emitting observation surface for concrete agent runtimes. Transcript publication uses
// the operation captured by the concrete turn; listeners support runtime tests and diagnostics.

import { EventEmitter } from 'events';
import {
  PermissionCancelledMessage,
  PermissionExpiredMessage,
  PermissionRequestMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import type { AgentPermissionResponseCapability } from '@garcon/server-agent-interface';
import {
  runtimeRows,
  type AgentRuntimeOperation,
} from '../execution/runtime-events.js';

export interface RuntimeEventMetadata {
  readonly clientRequestId?: string;
  readonly commandType?: 'chat-start' | 'agent-run' | 'fork-run' | 'agent-compact';
  readonly turnId?: string;
  readonly upstreamRequestId?: string;
}

export type MessagesCallback = (chatId: string, messages: ChatMessage[], metadata?: RuntimeEventMetadata) => void;
export type ProcessingCallback = (chatId: string, isProcessing: boolean) => void;
export type SessionCreatedCallback = (chatId: string) => void;
export type FinishedCallback = (chatId: string, exitCode: number, metadata?: RuntimeEventMetadata) => void;
export type FailedCallback = (
  chatId: string,
  errorMessage: string,
  metadata?: RuntimeEventMetadata,
) => void;

export class AgentEventEmitterRuntime extends EventEmitter {
  // Emit helpers (used by subclasses)

  emitMessages(
    chatId: string,
    messages: ChatMessage[],
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    if (messages.length > 0) {
      operation?.publish({
        type: 'messages',
        rows: runtimeRows(messages),
        runId: operation.runId,
      });
      if (metadata) {
        this.emit('messages', chatId, messages, metadata);
      } else {
        this.emit('messages', chatId, messages);
      }
    }
  }

  emitPermissionRequested(
    chatId: string,
    message: PermissionRequestMessage,
    decision: AgentPermissionResponseCapability,
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    if (
      decision.requestId !== message.permissionRequestId
      || decision.incarnation !== message.incarnation
    ) {
      throw new TypeError('Permission response capability does not match its request occurrence');
    }
    operation?.publish({
      type: 'permission',
      runId: operation.runId,
      lifecycle: {
        kind: 'requested',
        requestId: message.permissionRequestId,
        incarnation: message.incarnation,
        requestedTool: message.requestedTool,
        options: [],
      },
      decision,
    });
    this.#emitPermissionMessage(chatId, message, metadata);
  }

  emitPermissionCancelled(
    chatId: string,
    message: PermissionCancelledMessage,
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    operation?.publish({
      type: 'permission',
      runId: operation.runId,
      lifecycle: {
        kind: 'cancelled',
        requestId: message.permissionRequestId,
        incarnation: message.incarnation,
        reason: message.reason ?? null,
      },
    });
    this.#emitPermissionMessage(chatId, message, metadata);
  }

  emitPermissionExpired(
    chatId: string,
    message: PermissionExpiredMessage,
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    operation?.publish({
      type: 'permission',
      runId: operation.runId,
      lifecycle: {
        kind: 'expired',
        requestId: message.permissionRequestId,
        incarnation: message.incarnation,
      },
    });
    this.#emitPermissionMessage(chatId, message, metadata);
  }

  emitProcessing(chatId: string, isProcessing: boolean): void {
    this.emit('processing', chatId, isProcessing);
  }

  emitSessionCreated(chatId: string): void {
    this.emit('session-created', chatId);
  }

  emitFinished(
    chatId: string,
    exitCode: number = 0,
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    operation?.publish({
      type: 'run-ended',
      runId: operation.runId,
      outcome: 'finished',
      exitCode,
    });
    if (metadata) {
      this.emit('finished', chatId, exitCode, metadata);
    } else {
      this.emit('finished', chatId, exitCode);
    }
  }

  emitFailed(
    chatId: string,
    errorMessage: string,
    metadata?: RuntimeEventMetadata,
    operation?: AgentRuntimeOperation,
  ): void {
    operation?.publish({
      type: 'run-ended',
      runId: operation.runId,
      outcome: 'failed',
      error: { code: 'PROVIDER_FAILURE', message: errorMessage },
    });
    this.emit('failed', chatId, errorMessage, metadata);
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

  #emitPermissionMessage(
    chatId: string,
    message: PermissionRequestMessage | PermissionCancelledMessage | PermissionExpiredMessage,
    metadata?: RuntimeEventMetadata,
  ): void {
    if (metadata) {
      this.emit('messages', chatId, [message], metadata);
    } else {
      this.emit('messages', chatId, [message]);
    }
  }
}
