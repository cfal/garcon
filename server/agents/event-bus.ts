import type {
  AgentExecutionEvent,
  AgentOperationIdentity,
} from '@garcon/server-agent-interface';
import type { ChatMessage } from '@garcon/common/chat-types';
import type { AgentExecutionCommandType } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import { createLogger } from '../lib/log.js';
import { matchesTurnIdentity } from '../lib/turn-identity.js';

const logger = createLogger('agents:event-bus');

export interface TurnEventMetadata {
  clientRequestId?: string;
  commandType?: AgentExecutionCommandType;
  upstreamRequestId?: string;
  turnId?: string;
}

interface AbortableTurnWaiter {
  turn: TurnEventMetadata;
  resolve: (isAbortable: boolean) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

export class AgentEventBus {
  readonly #turnMetadataByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableTurnByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableWaiters = new Map<string, Set<AbortableTurnWaiter>>();
  readonly #messageListeners = new Set<(chatId: string, messages: ChatMessage[], metadata?: TurnEventMetadata) => void>();
  readonly #processingListeners = new Set<(chatId: string, processing: boolean) => void>();
  readonly #sessionListeners = new Set<(chatId: string) => void>();
  readonly #finishedListeners = new Set<(chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void>();
  readonly #failedListeners = new Set<(chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void>();

  constructor(directory: AgentDirectory) {
    for (const integration of directory.list()) {
      integration.execution.subscribe((event) => this.#dispatch(event));
    }
  }

  trackTurn(chatId: string, opts: TurnEventMetadata): void {
    if (!opts.clientRequestId && !opts.commandType && !opts.turnId) {
      this.clearTurn(chatId);
      return;
    }
    const turn = turnMetadata(opts);
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && !matchesTurnIdentity(active, turn)) {
      throw new Error(`Cannot track a new turn while chat ${chatId} has an active turn`);
    }
    this.#setTurn(chatId, turn);
  }

  replaceTurn(chatId: string, opts: TurnEventMetadata): void {
    if (!opts.clientRequestId && !opts.commandType && !opts.turnId) {
      this.clearTurn(chatId);
      return;
    }
    this.#setTurn(chatId, turnMetadata(opts));
  }

  #setTurn(chatId: string, turn: TurnEventMetadata): void {
    const abortable = this.#abortableTurnByChatId.get(chatId);
    if (abortable && !matchesTurnIdentity(turn, abortable)) {
      this.#abortableTurnByChatId.delete(chatId);
    }
    this.#turnMetadataByChatId.set(chatId, turn);
  }

  clearTurn(chatId: string): void {
    this.#turnMetadataByChatId.delete(chatId);
    this.#clearAbortability(chatId);
  }

  settleTurn(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && matchesTurnIdentity(active, turn)) this.clearTurn(chatId);
  }

  getActiveTurn(chatId: string): TurnEventMetadata | undefined {
    const metadata = this.#turnMetadataByChatId.get(chatId);
    return metadata ? { ...metadata } : undefined;
  }

  markTurnAbortable(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (!active || !matchesTurnIdentity(active, turn)) return;
    const abortable = { ...turn };
    this.#abortableTurnByChatId.set(chatId, abortable);
    for (const waiter of [...(this.#abortableWaiters.get(chatId) ?? [])]) {
      if (matchesTurnIdentity(waiter.turn, abortable)) this.#settleAbortableWaiter(chatId, waiter, true);
    }
  }

  waitUntilTurnAbortable(chatId: string, turn: TurnEventMetadata, signal?: AbortSignal): Promise<boolean> {
    const abortable = this.#abortableTurnByChatId.get(chatId);
    if (abortable && matchesTurnIdentity(turn, abortable)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter: AbortableTurnWaiter = {
        turn: { ...turn },
        resolve,
        signal,
        onAbort: () => this.#settleAbortableWaiter(chatId, waiter, false),
      };
      const waiters = this.#abortableWaiters.get(chatId) ?? new Set();
      waiters.add(waiter);
      this.#abortableWaiters.set(chatId, waiters);
      signal?.addEventListener('abort', waiter.onAbort, { once: true });
    });
  }

  onMessages(cb: (chatId: string, messages: ChatMessage[], metadata?: TurnEventMetadata) => void): void {
    this.#messageListeners.add(cb);
  }

  onProcessing(cb: (chatId: string, processing: boolean) => void): void {
    this.#processingListeners.add(cb);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    this.#sessionListeners.add(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    this.#finishedListeners.add(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    this.#failedListeners.add(cb);
  }

  #dispatch(event: AgentExecutionEvent): void {
    const metadata = operationMetadata(event.operation);
    const active = this.#turnMetadataByChatId.get(event.chatId);
    if (!active || !matchesTurnIdentity(active, metadata)) {
      logger.warn(`agents: ignored ${event.type} for a non-active turn`, event.chatId);
      return;
    }
    switch (event.type) {
      case 'messages':
        for (const listener of this.#messageListeners) listener(event.chatId, [...event.messages], metadata);
        return;
      case 'processing':
        for (const listener of this.#processingListeners) listener(event.chatId, event.processing);
        return;
      case 'session-created':
        for (const listener of this.#sessionListeners) listener(event.chatId);
        return;
      case 'finished':
        this.#clearAbortability(event.chatId);
        for (const listener of this.#finishedListeners) listener(event.chatId, event.exitCode, metadata);
        return;
      case 'failed':
        this.#clearAbortability(event.chatId);
        for (const listener of this.#failedListeners) listener(event.chatId, event.error.message, metadata);
    }
  }

  #clearAbortability(chatId: string): void {
    this.#abortableTurnByChatId.delete(chatId);
    for (const waiter of [...(this.#abortableWaiters.get(chatId) ?? [])]) {
      this.#settleAbortableWaiter(chatId, waiter, false);
    }
  }

  #settleAbortableWaiter(chatId: string, waiter: AbortableTurnWaiter, isAbortable: boolean): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    const waiters = this.#abortableWaiters.get(chatId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.#abortableWaiters.delete(chatId);
    waiter.resolve(isAbortable);
  }
}

function operationMetadata(operation: AgentOperationIdentity): TurnEventMetadata {
  return {
    commandType: operation.commandType,
    ...(operation.clientRequestId ? { clientRequestId: operation.clientRequestId } : {}),
    turnId: operation.turnId,
  };
}

function turnMetadata(opts: TurnEventMetadata): TurnEventMetadata {
  return {
    ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}),
    ...(opts.commandType ? { commandType: opts.commandType } : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
  };
}
