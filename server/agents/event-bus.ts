import type {
  AgentGoalControlHandoff,
  AgentControlEvent,
  AgentStreamEvent,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import type { AgentExecutionCommandType } from './session-types.js';
import type {
  AppliedProjectionEvent,
  AgentProjectionIngress,
  ProjectionIngressFailure,
} from './projection-ingress.js';
import { createLogger } from '../lib/log.js';
import { matchesTurnIdentity } from '../lib/turn-identity.js';

const logger = createLogger('agents:event-bus');

export interface TurnEventMetadata {
  clientRequestId?: string;
  clientMessageId?: string;
  commandType?: AgentExecutionCommandType;
  upstreamRequestId?: string;
  turnId?: string;
  agentOwnershipEpoch?: string;
  turnOwner?: AgentTurnReceiptOwner;
  entryIds?: readonly string[];
}

interface AbortableTurnWaiter {
  turn: TurnEventMetadata;
  resolve: (isAbortable: boolean) => void;
  signal?: AbortSignal;
  onAbort: () => void;
}

export class AgentEventBus {
  readonly #turnMetadataByChatId = new Map<string, TurnEventMetadata>();
  // A stop can settle the queue-side attempt before the provider's
  // authoritative terminal event applies; the settled identity is retained
  // until the next turn so that terminal still dispatches exactly once.
  readonly #settledTurnByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableTurnByChatId = new Map<string, TurnEventMetadata>();
  readonly #abortableWaiters = new Map<string, Set<AbortableTurnWaiter>>();
  readonly #processingListeners = new Set<(chatId: string, processing: boolean) => void | Promise<void>>();
  readonly #sessionListeners = new Set<(chatId: string) => void | Promise<void>>();
  readonly #finishedListeners = new Set<(chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void | Promise<void>>();
  readonly #failedListeners = new Set<(chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void | Promise<void>>();
  readonly #controlListeners = new Set<(event: AgentControlEvent) => void | Promise<void>>();
  readonly #projectionListeners = new Set<(
    applied: AppliedProjectionEvent,
  ) => void | Promise<void>>();
  readonly #inputSettledListeners = new Set<(
    chatId: string,
    clientRequestId: string,
  ) => void | Promise<void>>();
  readonly #projectionFailureListeners = new Set<(
    chatId: string,
    error: unknown,
    metadata?: TurnEventMetadata,
  ) => void | Promise<void>>();

  constructor(ingress: AgentProjectionIngress) {
    ingress.onApply((applied) => this.#dispatch(applied));
    ingress.onFailure((failure) => this.#dispatchProjectionFailure(failure));
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

  handoffTurn(
    chatId: string,
    predecessor: TurnEventMetadata | undefined,
    successor: TurnEventMetadata,
    downstream: AgentGoalControlHandoff,
  ): AgentGoalControlHandoff {
    const next = turnMetadata(successor);
    const validate = () => {
      const active = this.#turnMetadataByChatId.get(chatId);
      if (!sameTurnIdentity(active, predecessor)) {
        throw new Error(`Cannot hand off turn for chat ${chatId} after its active turn changed`);
      }
    };
    validate();
    return {
      validate: () => {
        validate();
        downstream.validate();
      },
      commit: () => {
        const abortable = this.#abortableTurnByChatId.get(chatId);
        const transferAbortability = abortable !== undefined
          && sameTurnIdentity(abortable, predecessor);
        this.#setTurn(chatId, next);
        if (transferAbortability) this.markTurnAbortable(chatId, next);
        downstream.commit();
      },
    };
  }

  #setTurn(chatId: string, turn: TurnEventMetadata): void {
    const abortable = this.#abortableTurnByChatId.get(chatId);
    if (abortable && !matchesTurnIdentity(turn, abortable)) {
      this.#abortableTurnByChatId.delete(chatId);
    }
    this.#settledTurnByChatId.delete(chatId);
    this.#turnMetadataByChatId.set(chatId, turn);
  }

  clearTurn(chatId: string): void {
    this.#turnMetadataByChatId.delete(chatId);
    this.#settledTurnByChatId.delete(chatId);
    this.#clearAbortability(chatId);
  }

  settleTurn(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && matchesTurnIdentity(active, turn)) {
      this.#turnMetadataByChatId.delete(chatId);
      this.#settledTurnByChatId.set(chatId, active);
      this.#clearAbortability(chatId);
    }
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

  onProcessing(cb: (chatId: string, processing: boolean) => void | Promise<void>): void {
    this.#processingListeners.add(cb);
  }

  onSessionCreated(cb: (chatId: string) => void | Promise<void>): void {
    this.#sessionListeners.add(cb);
  }

  onFinished(cb: (chatId: string, exitCode: number, metadata?: TurnEventMetadata) => void | Promise<void>): void {
    this.#finishedListeners.add(cb);
  }

  onFailed(cb: (chatId: string, errorMessage: string, metadata?: TurnEventMetadata) => void | Promise<void>): void {
    this.#failedListeners.add(cb);
  }

  onControl(cb: (event: AgentControlEvent) => void | Promise<void>): void {
    this.#controlListeners.add(cb);
  }

  onProjectionApplied(
    cb: (applied: AppliedProjectionEvent) => void | Promise<void>,
  ): void {
    this.#projectionListeners.add(cb);
  }

  onInputSettled(cb: (
    chatId: string,
    clientRequestId: string,
  ) => void | Promise<void>): void {
    this.#inputSettledListeners.add(cb);
  }

  onProjectionFailure(cb: (
    chatId: string,
    error: unknown,
    metadata?: TurnEventMetadata,
  ) => void | Promise<void>): void {
    this.#projectionFailureListeners.add(cb);
  }

  async #dispatch(applied: AppliedProjectionEvent): Promise<void> {
    const event = applied.event;
    switch (event.kind) {
      case 'commit':
        for (const promotion of event.promoted) {
          const admitted = applied.previous.entries.find((entry) => entry.id === promotion.entryId);
          const clientRequestId = admitted?.provenance?.clientRequestId;
          if (!clientRequestId) continue;
          for (const listener of this.#inputSettledListeners) {
            await listener(event.chatId, clientRequestId);
          }
        }
        await this.#dispatchProjection(applied);
        return;
      case 'control': {
        const metadata = operationMetadata(event.operation);
        if (!this.#isActive(event, metadata)) return;
        for (const listener of this.#controlListeners) await listener(event);
        await this.#dispatchProjection(applied);
        return;
      }
      case 'session': {
        const metadata = operationMetadata(event.operation);
        if (event.operation.turnOwner && !this.#isActive(event, metadata)) return;
        await this.#dispatchProjection(applied);
        for (const listener of this.#sessionListeners) await listener(event.chatId);
        return;
      }
      case 'terminal': {
        const metadata = operationMetadata(event.operation);
        if (!this.#isTerminalDeliverable(event.chatId, metadata)) return;
        this.#settledTurnByChatId.delete(event.chatId);
        this.#clearAbortability(event.chatId);
        await this.#dispatchProjection(applied);
        if (event.outcome.kind === 'finished') {
          for (const listener of this.#finishedListeners) {
            await listener(event.chatId, event.outcome.exitCode, metadata);
          }
        } else {
          for (const listener of this.#failedListeners) {
            await listener(event.chatId, event.outcome.error.message, metadata);
          }
        }
        return;
      }
      case 'reset':
        await this.#dispatchProjection(applied);
        return;
    }
  }

  async #dispatchProjection(applied: AppliedProjectionEvent): Promise<void> {
    for (const listener of this.#projectionListeners) await listener(applied);
  }

  async #dispatchProjectionFailure(failure: ProjectionIngressFailure): Promise<void> {
    const metadata = failureMetadata(failure)
      ?? this.#turnMetadataByChatId.get(failure.chat.chatId)
      ?? this.#settledTurnByChatId.get(failure.chat.chatId);
    if (!metadata || metadata.agentOwnershipEpoch !== failure.chat.agentOwnershipEpoch) return;
    if (!this.#isTerminalDeliverable(failure.chat.chatId, metadata)) return;
    this.#settledTurnByChatId.delete(failure.chat.chatId);
    this.#clearAbortability(failure.chat.chatId);
    for (const listener of this.#projectionFailureListeners) {
      await listener(failure.chat.chatId, failure.error, metadata);
    }
  }

  #isActive(event: AgentStreamEvent, metadata: TurnEventMetadata): boolean {
    return this.#isActiveEntry(event.chatId, metadata);
  }

  // The terminal is the authoritative close of its turn, so it dispatches
  // for the active turn or for the turn a stop already settled queue-side.
  #isTerminalDeliverable(chatId: string, metadata: TurnEventMetadata): boolean {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && matchesTurnIdentity(active, metadata)) return true;
    const settled = this.#settledTurnByChatId.get(chatId);
    if (settled && matchesTurnIdentity(settled, metadata)) return true;
    logger.warn('agents: ignored projection event for a non-active turn', chatId);
    return false;
  }

  #isActiveEntry(chatId: string, metadata: TurnEventMetadata): boolean {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && matchesTurnIdentity(active, metadata)) return true;
    logger.warn('agents: ignored projection event for a non-active turn', chatId);
    return false;
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

function operationMetadata(operation: {
  readonly commandType: string;
  readonly clientRequestId: string | null;
  readonly clientMessageId: string | null;
  readonly turnId: string;
  readonly agentOwnershipEpoch: string;
  readonly turnOwner: AgentTurnReceiptOwner | null;
  readonly upstreamRequestId?: string | null;
}): TurnEventMetadata {
  return {
    commandType: (operation.turnOwner?.commandType
      ?? operation.commandType) as AgentExecutionCommandType,
    ...((operation.turnOwner?.clientRequestId ?? operation.clientRequestId)
      ? { clientRequestId: operation.turnOwner?.clientRequestId ?? operation.clientRequestId! }
      : {}),
    ...(operation.clientMessageId ? { clientMessageId: operation.clientMessageId } : {}),
    ...(operation.upstreamRequestId ? { upstreamRequestId: operation.upstreamRequestId } : {}),
    turnId: operation.turnOwner?.turnId ?? operation.turnId,
    agentOwnershipEpoch: operation.agentOwnershipEpoch,
    ...(operation.turnOwner ? { turnOwner: operation.turnOwner } : {}),
  };
}

function turnMetadata(opts: TurnEventMetadata): TurnEventMetadata {
  return {
    ...(opts.clientRequestId ? { clientRequestId: opts.clientRequestId } : {}),
    ...(opts.commandType ? { commandType: opts.commandType } : {}),
    ...(opts.turnId ? { turnId: opts.turnId } : {}),
    ...(opts.clientMessageId ? { clientMessageId: opts.clientMessageId } : {}),
    ...(opts.upstreamRequestId ? { upstreamRequestId: opts.upstreamRequestId } : {}),
    ...(opts.agentOwnershipEpoch ? { agentOwnershipEpoch: opts.agentOwnershipEpoch } : {}),
    ...(opts.turnOwner ? { turnOwner: opts.turnOwner } : {}),
  };
}

function sameTurnIdentity(
  left: TurnEventMetadata | undefined,
  right: TurnEventMetadata | undefined,
): boolean {
  return matchesTurnIdentity(left, right) && matchesTurnIdentity(right, left);
}

function failureMetadata(failure: ProjectionIngressFailure): TurnEventMetadata | undefined {
  const event = failure.event;
  if (event.kind === 'control' || event.kind === 'session' || event.kind === 'terminal') {
    return operationMetadata(event.operation);
  }
  if (event.kind === 'commit') {
    const provenance = event.appended.find((entry) => entry.provenance)?.provenance;
    return provenance ? operationMetadata(provenance) : undefined;
  }
  const active = failure.materialization.entries.at(-1);
  return active?.provenance ? operationMetadata(active.provenance) : undefined;
}
