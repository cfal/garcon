import type { AgentEventMetadata } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import { createLogger } from '../lib/log.js';

const logger = createLogger('agents:event-bus');

export interface TurnEventMetadata {
  clientRequestId?: string;
  commandType?: 'chat-start';
  upstreamRequestId?: string;
  turnId?: string;
}

function mergeTurnEventMetadata(
  base: TurnEventMetadata | undefined,
  event: AgentEventMetadata | undefined,
): TurnEventMetadata | undefined {
  const metadata = { ...(base ?? {}), ...(event ?? {}) };
  return Object.keys(metadata).length > 0 ? metadata : undefined;
}

export class AgentEventBus {
  readonly #directory: AgentDirectory;
  readonly #turnMetadataByChatId = new Map<string, TurnEventMetadata>();

  constructor(directory: AgentDirectory) {
    this.#directory = directory;
  }

  trackTurn(chatId: string, opts: { clientRequestId?: string; commandType?: 'chat-start'; turnId?: string }): void {
    if (opts.clientRequestId || opts.commandType || opts.turnId) {
      if (this.#turnMetadataByChatId.has(chatId)) {
        logger.warn('agents: overwriting in-flight turn metadata for chat', chatId);
      }
      this.#turnMetadataByChatId.set(chatId, {
        clientRequestId: opts.clientRequestId,
        commandType: opts.commandType,
        turnId: opts.turnId,
      });
      return;
    }
    this.clearTurn(chatId);
  }

  clearTurn(chatId: string): void {
    this.#turnMetadataByChatId.delete(chatId);
  }

  getActiveTurn(chatId: string): TurnEventMetadata | undefined {
    const metadata = this.#turnMetadataByChatId.get(chatId);
    return metadata ? { ...metadata } : undefined;
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onMessages((chatId, messages, eventMetadata) => {
        cb(chatId, messages, mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata));
      });
    }
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onProcessing(cb);
    }
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onSessionCreated(cb);
    }
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFinished((chatId, exitCode, eventMetadata) => {
        const metadata = mergeTurnEventMetadata(this.#turnMetadataByChatId.get(chatId), eventMetadata);
        cb(chatId, exitCode, metadata);
        this.clearTurn(chatId);
      });
    }
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFailed((chatId, errorMessage) => {
        const metadata = this.#turnMetadataByChatId.get(chatId);
        cb(chatId, errorMessage, metadata);
        this.clearTurn(chatId);
      });
    }
  }
}
