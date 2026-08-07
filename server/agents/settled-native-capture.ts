import crypto from 'node:crypto';
import { setTimeout as sleep } from 'node:timers/promises';
import {
  AgentIntegrationError,
  type AgentChatReference,
  type AgentIntegration,
  type AgentTranscriptSnapshot,
} from '@garcon/server-agent-interface';
import type { PendingUserInputServiceContract } from '../chats/pending-user-input-service.js';
import { DomainError } from '../lib/domain-error.js';

const DEFAULT_SETTLE_MS = 250;
const DEFAULT_STABILITY_ATTEMPTS = 2;

export class SettledNativeCaptureService {
  readonly #pendingInputs: Pick<
    PendingUserInputServiceContract,
    'hasInFlightForChat' | 'reconcileNativeHistory'
  >;
  readonly #settleMs: number;
  readonly #stabilityAttempts: number;

  constructor(options: {
    readonly pendingInputs: Pick<
      PendingUserInputServiceContract,
      'hasInFlightForChat' | 'reconcileNativeHistory'
    >;
    readonly settleMs?: number;
    readonly stabilityAttempts?: number;
  }) {
    this.#pendingInputs = options.pendingInputs;
    this.#settleMs = options.settleMs ?? DEFAULT_SETTLE_MS;
    this.#stabilityAttempts = options.stabilityAttempts ?? DEFAULT_STABILITY_ATTEMPTS;
  }

  async loadStable(input: {
    readonly chatId: string;
    readonly integration: AgentIntegration;
    readonly reference: AgentChatReference;
    readonly signal: AbortSignal;
  }): Promise<AgentTranscriptSnapshot> {
    await this.#pendingInputs.reconcileNativeHistory(input.chatId);
    input.signal.throwIfAborted();
    if (this.#pendingInputs.hasInFlightForChat(input.chatId)) {
      throw unsettledError('Pending input has not reached native history');
    }

    for (let attempt = 0; attempt < this.#stabilityAttempts; attempt += 1) {
      const first = await this.#load(input);
      await sleep(this.#settleMs, undefined, { signal: input.signal });
      const second = await this.#load(input);
      if (sameSnapshot(first, second)) return second;
    }
    throw unsettledError('The provider transcript is still changing');
  }

  async assertRevision(input: {
    readonly integration: AgentIntegration;
    readonly reference: AgentChatReference;
    readonly expectedRevision: string;
    readonly signal: AbortSignal;
  }): Promise<void> {
    input.signal.throwIfAborted();
    let revision: string;
    try {
      revision = await input.integration.transcript.revision({
        chat: input.reference,
        signal: input.signal,
      });
    } catch (error) {
      throw sourceUnavailable(error);
    }
    if (revision !== input.expectedRevision) {
      throw unsettledError('The provider transcript changed during handoff preparation');
    }
  }

  async #load(input: {
    readonly integration: AgentIntegration;
    readonly reference: AgentChatReference;
    readonly signal: AbortSignal;
  }): Promise<AgentTranscriptSnapshot> {
    input.signal.throwIfAborted();
    try {
      return await input.integration.transcript.load({
        chat: input.reference,
        signal: input.signal,
      });
    } catch (error) {
      throw sourceUnavailable(error);
    }
  }
}

function sameSnapshot(left: AgentTranscriptSnapshot, right: AgentTranscriptSnapshot): boolean {
  return left.revision === right.revision
    && snapshotDigest(left) === snapshotDigest(right);
}

function snapshotDigest(snapshot: AgentTranscriptSnapshot): string {
  return crypto
    .createHash('sha256')
    .update(JSON.stringify(snapshot.messages), 'utf8')
    .digest('hex');
}

function unsettledError(message: string): DomainError {
  return new DomainError('TRANSCRIPT_NOT_YET_PERSISTED', message, 409, true);
}

function sourceUnavailable(error: unknown): unknown {
  if (error instanceof Error && error.name === 'AbortError') return error;
  if (error instanceof DomainError) return error;
  const retryable = error instanceof AgentIntegrationError ? error.retryable : true;
  return new DomainError(
    'SOURCE_TRANSCRIPT_UNAVAILABLE',
    retryable
      ? 'The source transcript is temporarily unavailable. Retry the handoff.'
      : 'The source transcript is unavailable.',
    422,
    retryable,
    { cause: error },
  );
}
