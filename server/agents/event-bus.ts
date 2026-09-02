import type {
  AgentGoalControlHandoff,
} from '@garcon/server-agent-interface';
import type { AgentExecutionCommandType } from './session-types.js';
import { createLogger } from '../lib/log.js';
import { matchesTurnIdentity, type TurnReceiptOwner } from '../lib/turn-identity.js';
import type { LedgerRunEndedRow } from '../ledger/contracts.js';
import { dispatchListenersSequentially } from './listener-dispatch.js';

const logger = createLogger('agents:event-bus');

export interface TurnEventMetadata {
  clientRequestId?: string;
  clientMessageId?: string;
  commandType?: AgentExecutionCommandType;
  upstreamRequestId?: string;
  turnId?: string;
  agentOwnershipEpoch?: string;
  turnOwner?: TurnReceiptOwner;
  entryIds?: readonly string[];
}

export type AgentRunCompletionOutcome = 'finished' | 'interrupted';

export class AgentEventBus {
  readonly #turnMetadataByChatId = new Map<string, TurnEventMetadata>();
  readonly #settledTurnByChatId = new Map<string, TurnEventMetadata>();
  readonly #sessionListeners = new Set<(chatId: string) => void | Promise<void>>();
  readonly #finishedListeners = new Set<(
    chatId: string,
    exitCode: number,
    metadata: TurnEventMetadata | undefined,
    outcome: AgentRunCompletionOutcome,
  ) => void | Promise<void>>();
  readonly #failedListeners = new Set<(
    chatId: string,
    errorMessage: string,
    errorCode: string,
    metadata?: TurnEventMetadata,
  ) => void | Promise<void>>();

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
        this.#setTurn(chatId, next);
        downstream.commit();
      },
    };
  }

  clearTurn(chatId: string): void {
    this.#turnMetadataByChatId.delete(chatId);
    this.#settledTurnByChatId.delete(chatId);
  }

  settleTurn(chatId: string, turn: TurnEventMetadata): void {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active && matchesTurnIdentity(active, turn)) {
      this.#turnMetadataByChatId.delete(chatId);
      this.#settledTurnByChatId.set(chatId, active);
    }
  }

  getActiveTurn(chatId: string): TurnEventMetadata | undefined {
    const metadata = this.#turnMetadataByChatId.get(chatId);
    return metadata ? { ...metadata } : undefined;
  }

  onSessionCreated(cb: (chatId: string) => void | Promise<void>): void {
    this.#sessionListeners.add(cb);
  }

  onFinished(
    cb: (
      chatId: string,
      exitCode: number,
      metadata: TurnEventMetadata | undefined,
      outcome: AgentRunCompletionOutcome,
    ) => void | Promise<void>,
  ): void {
    this.#finishedListeners.add(cb);
  }

  onFailed(
    cb: (
      chatId: string,
      errorMessage: string,
      errorCode: string,
      metadata?: TurnEventMetadata,
    ) => void | Promise<void>,
  ): void {
    this.#failedListeners.add(cb);
  }

  async publishSession(chatId: string): Promise<void> {
    await this.#dispatch('session', chatId, this.#sessionListeners, chatId);
  }

  async publishRunEnded(chatId: string, runId: string, row: LedgerRunEndedRow): Promise<void> {
    const metadata = this.#terminalMetadata(chatId, runId);
    if (!metadata) return;
    this.#settledTurnByChatId.delete(chatId);
    this.#turnMetadataByChatId.delete(chatId);
    if (row.outcome === 'failed') {
      const message = row.error?.message ?? row.error?.code ?? 'Agent run failed';
      const code = row.error?.code ?? 'INTERNAL_ERROR';
      await this.#dispatch(
        'failed terminal',
        chatId,
        this.#failedListeners,
        chatId,
        message,
        code,
        metadata,
      );
      return;
    }
    await this.#dispatch(
      'finished terminal',
      chatId,
      this.#finishedListeners,
      chatId,
      0,
      metadata,
      row.outcome,
    );
  }

  async #dispatch<Args extends readonly unknown[]>(
    event: string,
    chatId: string,
    listeners: Iterable<(...args: Args) => void | Promise<void>>,
    ...args: Args
  ): Promise<void> {
    await dispatchListenersSequentially(listeners, args, (error) => {
      logger.error('Agent event listener failed', {
        chatId,
        event,
        error: error instanceof Error ? error.message : String(error),
      });
    });
  }

  #setTurn(chatId: string, turn: TurnEventMetadata): void {
    this.#settledTurnByChatId.delete(chatId);
    this.#turnMetadataByChatId.set(chatId, turn);
  }

  #terminalMetadata(chatId: string, runId: string): TurnEventMetadata | null {
    const active = this.#turnMetadataByChatId.get(chatId);
    if (active?.turnId === runId) return active;
    const settled = this.#settledTurnByChatId.get(chatId);
    if (settled?.turnId === runId) return settled;
    logger.warn('Ignored ledger terminal for a non-active turn', { chatId, runId });
    return null;
  }

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
