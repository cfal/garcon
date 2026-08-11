import type {
  AgentConsumerOffsetCommit,
  AgentControlEvent,
  AgentControlRow,
  AgentEventDigest,
  AgentOperationIdentityV4,
  AgentProjectionState,
  AgentSegmentIdentity,
  AgentSessionEvent,
  AgentStartedSession,
  AgentStreamCheckpoint,
  AgentStreamEvent,
  AgentStreamReplayResult,
  AgentTerminalCompleteness,
  AgentTerminalEvent,
  AgentTranscriptCommitEvent,
  AgentTranscriptEntry,
  AgentTranscriptPromotion,
  AgentTranscriptResetEvent,
  AgentTranscriptResetReason,
  AgentTurnBoundOperationIdentityV4,
  AgentTurnOwnerOperationIdentityV4,
} from '@garcon/server-agent-interface';
import { AgentIntegrationError } from '@garcon/server-agent-interface';
import {
  agentStreamOffset,
  compareAgentStreamOffsets,
  nextAgentStreamOffset,
  sameCheckpoint,
  sameProjectionState,
  sameSegment,
} from './identity.js';
import { applyProjectionEvent } from './apply.js';
import {
  computeAgentStreamEventDigest,
  type AgentStreamEventWithoutDigest,
} from './revision.js';
import {
  createProjectionState,
  type AgentProjectionMaterialization,
} from './state.js';

export interface AgentProjectionStreamOptions {
  readonly initial: AgentProjectionMaterialization;
  readonly maxUncommittedEvents?: number;
  readonly persist?: (
    event: AgentStreamEvent,
    previousEntries: readonly AgentTranscriptEntry[],
    resultingEntries: readonly AgentTranscriptEntry[],
  ) => Promise<void>;
  readonly onListenerError?: (error: unknown, event: AgentStreamEvent) => void;
}

export type ProjectionEventRelation =
  | { readonly kind: 'settled-past' }
  | { readonly kind: 'duplicate' }
  | { readonly kind: 'next' }
  | { readonly kind: 'gap' }
  | { readonly kind: 'stale-epoch' }
  | { readonly kind: 'unknown-epoch' }
  | { readonly kind: 'corrupt' };

export class AgentProjectionEventStream {
  readonly #listeners = new Set<(event: AgentStreamEvent) => void>();
  readonly #retained: AgentStreamEvent[] = [];
  readonly #supersededEpochs = new Set<string>();
  readonly #maxUncommittedEvents: number;
  readonly #persist: NonNullable<AgentProjectionStreamOptions['persist']>;
  readonly #onListenerError: NonNullable<AgentProjectionStreamOptions['onListenerError']>;
  #materialization: AgentProjectionMaterialization;
  #committed: AgentStreamCheckpoint;
  #gate: Promise<void> = Promise.resolve();

  constructor(options: AgentProjectionStreamOptions) {
    this.#materialization = options.initial;
    this.#committed = options.initial.checkpoint;
    this.#maxUncommittedEvents = options.maxUncommittedEvents ?? 10_000;
    this.#persist = options.persist ?? (async () => {});
    this.#onListenerError = options.onListenerError ?? (() => {});
  }

  get current(): AgentProjectionMaterialization {
    return this.#materialization;
  }

  get committed(): AgentStreamCheckpoint {
    return this.#committed;
  }

  subscribe(listener: (event: AgentStreamEvent) => void): () => void {
    this.#listeners.add(listener);
    return () => this.#listeners.delete(listener);
  }

  commit(
    promoted: readonly AgentTranscriptPromotion[],
    appended: readonly AgentTranscriptEntry[],
  ): Promise<AgentTranscriptCommitEvent> {
    return this.#mutate(async () => {
      const previous = this.#materialization.checkpoint;
      const resultingEntries = applyCommitShape(this.#materialization.entries, promoted, appended);
      const projection = createProjectionState(
        previous.projection.epoch,
        previous.projection.contentEpoch,
        resultingEntries,
      );
      const checkpoint = nextCheckpoint(previous, projection);
      const event = withDigest({
        kind: 'commit',
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        previous,
        checkpoint,
        promoted: [...promoted],
        appended: appended.map((entry) => ({ ...entry })),
      });
      await this.#install(event, resultingEntries);
      return event;
    });
  }

  control(
    operation: AgentTurnBoundOperationIdentityV4,
    mutation: AgentControlEvent['mutation'],
  ): Promise<AgentControlEvent> {
    return this.#mutate(async () => {
      const previous = this.#materialization.checkpoint;
      const event = withDigest({
        kind: 'control',
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        previous,
        checkpoint: nextCheckpoint(previous, previous.projection),
        operation,
        mutation,
      });
      await this.#install(event, this.#materialization.entries);
      return event;
    });
  }

  session(
    operation: AgentOperationIdentityV4,
    session: AgentStartedSession,
  ): Promise<AgentSessionEvent> {
    return this.#mutate(async () => {
      const previous = this.#materialization.checkpoint;
      const event = withDigest({
        kind: 'session',
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        previous,
        checkpoint: nextCheckpoint(previous, previous.projection),
        operation,
        session,
      });
      await this.#install(event, this.#materialization.entries);
      return event;
    });
  }

  terminal(options: {
    readonly operation: AgentTurnOwnerOperationIdentityV4;
    readonly outcome: AgentTerminalEvent['outcome'];
    readonly completeness: AgentTerminalCompleteness;
    readonly sourceSettlement: AgentTerminalEvent['sourceSettlement'];
  }): Promise<AgentTerminalEvent> {
    return this.#mutate(async () => {
      const previous = this.#materialization.checkpoint;
      const event = withDigest({
        kind: 'terminal',
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        previous,
        checkpoint: nextCheckpoint(previous, previous.projection),
        ...options,
      });
      await this.#install(event, this.#materialization.entries);
      return event;
    });
  }

  reset(options: {
    readonly reason: AgentTranscriptResetReason;
    readonly epoch: AgentProjectionState['epoch'];
    readonly contentEpoch: AgentProjectionState['contentEpoch'];
    readonly entries: readonly AgentTranscriptEntry[];
  }): Promise<AgentTranscriptResetEvent> {
    return this.#mutate(async () => {
      const previous = this.#materialization.checkpoint;
      const projection = createProjectionState(options.epoch, options.contentEpoch, options.entries);
      const checkpoint: AgentStreamCheckpoint = {
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        offset: agentStreamOffset(0),
        projection,
      };
      const event = withDigest({
        kind: 'reset',
        chatId: previous.chatId,
        agentOwnershipEpoch: previous.agentOwnershipEpoch,
        previous,
        checkpoint,
        reason: options.reason,
      });
      await this.#install(event, options.entries);
      return event;
    });
  }

  replay(after: AgentStreamCheckpoint): AgentStreamReplayResult {
    if (!sameSegment(after, this.#materialization)) {
      return { kind: 'degraded', errorCode: 'STALE_OWNERSHIP', retryable: false };
    }
    if (sameCheckpoint(after, this.#materialization.checkpoint)) {
      return { kind: 'events', events: [], checkpoint: this.#materialization.checkpoint };
    }
    const first = this.#retained.findIndex((event) => sameCheckpoint(event.previous, after));
    if (first < 0) return { kind: 'expired', checkpoint: this.#materialization.checkpoint };
    return {
      kind: 'events',
      events: this.#retained.slice(first),
      checkpoint: this.#materialization.checkpoint,
    };
  }

  commitOffset(commit: AgentConsumerOffsetCommit): void {
    if (!sameSegment(commit, this.#materialization)
        || !sameSegment(commit.applied, this.#materialization)) {
      throw new TypeError('Consumer offset ownership mismatch');
    }
    if (sameCheckpoint(commit.applied, this.#committed)) return;
    const index = this.#retained.findIndex((event) => sameCheckpoint(event.checkpoint, commit.applied));
    if (index < 0) {
      if (commit.applied.projection.epoch === this.#committed.projection.epoch
          && compareAgentStreamOffsets(commit.applied.offset, this.#committed.offset) < 0) return;
      throw new TypeError('Consumer offset is not a retained applied checkpoint');
    }
    this.#committed = commit.applied;
    this.#retained.splice(0, index + 1);
  }

  classify(options: {
    readonly event: AgentStreamEvent;
    readonly applied: AgentStreamCheckpoint;
    readonly committed: AgentStreamCheckpoint;
    readonly proofs: ReadonlyMap<string, { readonly digest: AgentEventDigest; readonly checkpoint: AgentStreamCheckpoint }>;
  }): ProjectionEventRelation {
    const { event, applied, committed, proofs } = options;
    if (!sameSegment(event, applied)) return { kind: 'unknown-epoch' };
    if (event.checkpoint.projection.epoch === committed.projection.epoch
        && compareAgentStreamOffsets(event.checkpoint.offset, committed.offset) <= 0) {
      return { kind: 'settled-past' };
    }
    const proof = proofs.get(proofKey(event.checkpoint));
    if (proof) {
      return proof.digest === event.digest && sameCheckpoint(proof.checkpoint, event.checkpoint)
        ? { kind: 'duplicate' }
        : { kind: 'corrupt' };
    }
    if (sameCheckpoint(event.previous, applied)) return { kind: 'next' };
    if (this.#supersededEpochs.has(event.checkpoint.projection.epoch)) {
      return { kind: 'stale-epoch' };
    }
    if (event.previous.projection.epoch === applied.projection.epoch) return { kind: 'gap' };
    return { kind: 'unknown-epoch' };
  }

  async #install(
    event: AgentStreamEvent,
    resultingEntries: readonly AgentTranscriptEntry[],
  ): Promise<void> {
    if (this.#retained.length >= this.#maxUncommittedEvents) {
      throw new AgentIntegrationError(
        'TRANSCRIPT_UNAVAILABLE',
        'Projection consumer lag limit reached',
        true,
      );
    }
    const priorEpoch = this.#materialization.checkpoint.projection.epoch;
    const next = applyProjectionEvent(this.#materialization, event, {
      ...(event.kind === 'reset' ? { resetEntries: resultingEntries } : {}),
    });
    await this.#persist(event, this.#materialization.entries, resultingEntries);
    if (event.kind === 'reset') this.#supersededEpochs.add(priorEpoch);
    this.#materialization = next;
    this.#retained.push(event);
    for (const listener of this.#listeners) {
      try {
        listener(event);
      } catch (error) {
        this.#onListenerError(error, event);
      }
    }
  }

  #mutate<T>(operation: () => Promise<T>): Promise<T> {
    const result = this.#gate.then(operation, operation);
    this.#gate = result.then(() => {}, () => {});
    return result;
  }
}

function applyCommitShape(
  current: readonly AgentTranscriptEntry[],
  promoted: readonly AgentTranscriptPromotion[],
  appended: readonly AgentTranscriptEntry[],
): readonly AgentTranscriptEntry[] {
  const promotionById = new Map(promoted.map((promotion) => [promotion.entryId, promotion]));
  return [
    ...current.map((entry) => {
      const promotion = promotionById.get(entry.id);
      return promotion ? { ...entry, lifetime: 'durable' as const, source: promotion.source } : entry;
    }),
    ...appended,
  ];
}

function nextCheckpoint(
  previous: AgentStreamCheckpoint,
  projection: AgentProjectionState,
): AgentStreamCheckpoint {
  return {
    chatId: previous.chatId,
    agentOwnershipEpoch: previous.agentOwnershipEpoch,
    offset: nextAgentStreamOffset(previous.offset),
    projection,
  };
}

function withDigest<T extends AgentStreamEventWithoutDigest>(event: T): T & { readonly digest: AgentEventDigest } {
  return { ...event, digest: computeAgentStreamEventDigest(event) };
}

function proofKey(checkpoint: AgentStreamCheckpoint): string {
  return `${checkpoint.projection.epoch}:${checkpoint.offset}`;
}

export function controlRows(materialization: AgentProjectionMaterialization): readonly AgentControlRow[] {
  return [...materialization.controls.values()];
}
