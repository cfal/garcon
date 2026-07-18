import type { AgentEventMetadata } from './session-types.js';
import type { AgentDirectory } from './directory.js';
import { createLogger } from '../lib/log.js';
import { matchesTurnIdentity } from '../lib/turn-identity.js';

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

interface AbortableTurnWaiter {
  turn: TurnEventMetadata;
  resolve: (isAbortable: boolean) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

export class AgentEventBus {
  readonly #directory: AgentDirectory;
  readonly #turnMetadataByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableTurnByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableWaiters = new Map<string, Set<AbortableTurnWaiter>>();

  constructor(directory: AgentDirectory) {
    this.#directory = directory;
  }

  trackTurn(chatId: string, opts: { clientRequestId?: string; commandType?: 'chat-start'; turnId?: string }): void {
    if (opts.clientRequestId || opts.commandType || opts.turnId) {
      if (this.#turnMetadataByChatId.has(chatId)) {
        logger.warn('agents: overwriting in-flight turn metadata for chat', chatId);
      }
      const turn = {
        ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}),
        ...(opts.commandType ? { commandType: opts.commandType } : {}),
        ...(opts.turnId ? { turnId: opts.turnId } : {}),
      };
      const abortable = this.#abortableTurnByChatId.get(chatId);
      if (abortable && !matchesTurnIdentity(turn, abortable)) {
        this.#abortableTurnByChatId.delete(chatId);
      }
      this.#turnMetadataByChatId.set(chatId, turn);
      return;
    }
    this.clearTurn(chatId);
  }

  clearTurn(chatId: string): void {
    this.#turnMetadataByChatId.delete(chatId);
    this.#clearAbortability(chatId);
  }

  settleTurn(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (!active || !matchesTurnIdentity(active, turn)) return;
    this.clearTurn(chatId);
  }

  #clearAbortability(chatId: string): void {
    this.#abortableTurnByChatId.delete(chatId);
    const waiters = this.#abortableWaiters.get(chatId);
    if (waiters) {
      for (const waiter of [...waiters]) this.#settleAbortableWaiter(chatId, waiter, false);
    }
  }

  getActiveTurn(chatId: string): TurnEventMetadata | undefined {
    const metadata = this.#turnMetadataByChatId.get(chatId);
    return metadata ? { ...metadata } : undefined;
  }

  onMessages(cb: (chatId: string, messages: unknown[], metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onMessages((chatId, messages, eventMetadata) => {
        const metadata = this.#identifiedEventMetadata(chatId, eventMetadata, 'messages');
        if (metadata === null) return;
        cb(chatId, messages, metadata);
      });
    }
  }

  onProcessing(cb: (chatId: string, isProcessing: boolean) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onProcessing(cb);
    }
  }

  markTurnAbortable(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (!active || !matchesTurnIdentity(active, turn)) return;
    const abortable = { ...turn };
    this.#abortableTurnByChatId.set(chatId, abortable);
    const waiters = this.#abortableWaiters.get(chatId);
    if (!waiters) return;
    for (const waiter of [...waiters]) {
      if (matchesTurnIdentity(waiter.turn, abortable)) this.#settleAbortableWaiter(chatId, waiter, true);
    }
  }

  waitUntilTurnAbortable(
    chatId: string,
    turn: TurnEventMetadata,
    signal?: AbortSignal,
  ): Promise<boolean> {
    const abortable = this.#abortableTurnByChatId.get(chatId);
    if (abortable && matchesTurnIdentity(turn, abortable)) return Promise.resolve(true);
    if (signal?.aborted) return Promise.resolve(false);
    return new Promise<boolean>((resolve) => {
      const waiter = {
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

  #settleAbortableWaiter(
    chatId: string,
    waiter: AbortableTurnWaiter,
    isAbortable: boolean,
  ): void {
    waiter.signal?.removeEventListener('abort', waiter.onAbort);
    const waiters = this.#abortableWaiters.get(chatId);
    waiters?.delete(waiter);
    if (waiters?.size === 0) this.#abortableWaiters.delete(chatId);
    waiter.resolve(isAbortable);
  }

  onSessionCreated(cb: (chatId: string) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onSessionCreated(cb);
    }
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFinished((chatId, exitCode, eventMetadata) => {
        const metadata = this.#terminalMetadata(chatId, eventMetadata);
        if (metadata === null) return;
        this.#clearAbortability(chatId);
        cb(chatId, exitCode, metadata);
      });
    }
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void): void {
    for (const agent of this.#directory.list()) {
      agent.runtime.onFailed((chatId, errorMessage, eventMetadata) => {
        const metadata = this.#terminalMetadata(chatId, eventMetadata);
        if (metadata === null) return;
        this.#clearAbortability(chatId);
        cb(chatId, errorMessage, metadata);
      });
    }
  }

  #terminalMetadata(
    chatId: string,
    eventMetadata: AgentEventMetadata | undefined,
  ): TurnEventMetadata | null | undefined {
    return this.#identifiedEventMetadata(chatId, eventMetadata, 'terminal');
  }

  #identifiedEventMetadata(
    chatId: string,
    eventMetadata: AgentEventMetadata | undefined,
    eventKind: 'messages' | 'terminal',
  ): TurnEventMetadata | null | undefined {
    const active = this.#turnMetadataByChatId.get(chatId);
    const activeHasIdentity = Boolean(active?.turnId || active?.clientRequestId);
    const eventHasIdentity = Boolean(eventMetadata?.turnId || eventMetadata?.clientRequestId);
    if (eventKind === 'terminal' && activeHasIdentity && !eventHasIdentity) {
      logger.warn('agents: ignored identityless terminal for an identified active turn', chatId);
      return null;
    }
    if (eventHasIdentity && (!active || !matchesTurnIdentity(active, eventMetadata))) {
      logger.warn(`agents: ignored ${eventKind} for a non-active turn`, chatId);
      return null;
    }
    return mergeTurnEventMetadata(active, eventMetadata);
  }
}
