import crypto from 'node:crypto';
import type {
  AgentControlRow,
  AgentTurnReceiptOwner,
} from '@garcon/server-agent-interface';
import type { AppliedProjectionEvent } from '../agents/projection-ingress.js';
import { stableJsonStringify } from '../../common/json.js';
import type {
  ChatProjectionGenerationTransition,
  ChatTransientControlAction,
  ChatTransientFeedMutation,
  ChatTransientFeedSnapshot,
  ChatTurnReceiptOwner,
  TransientFeedRow,
} from '../../common/chat-transient-feed.js';

interface TransientFeedRecord {
  readonly chatId: string;
  agentOwnershipEpoch: string;
  generationId: string;
  resetTransactionId: string | null;
  transientRevision: number;
  stateDigest: string;
  rows: Map<string, TransientFeedRow>;
}

export type AppliedTransientFeedEvent =
  | { readonly kind: 'mutation'; readonly value: ChatTransientFeedMutation }
  | {
      readonly kind: 'generation-transition';
      readonly value: ChatProjectionGenerationTransition;
    }
  | { readonly kind: 'unchanged' };

export interface TransientFeedApplyContext {
  readonly generationId: string;
  readonly previousGenerationId?: string;
  readonly carryOverMessageCount: number;
}

export class ChatTransientFeedStore {
  readonly #records = new Map<string, TransientFeedRecord>();

  constructor(readonly serverInstanceId: string) {
    if (!serverInstanceId) throw new TypeError('Transient feed requires a server instance ID');
  }

  apply(
    applied: AppliedProjectionEvent,
    context: TransientFeedApplyContext,
  ): AppliedTransientFeedEvent {
    const event = applied.event;
    if (event.kind === 'commit' || event.kind === 'session') return { kind: 'unchanged' };
    if (event.kind === 'reset') {
      const previousGenerationId = context.previousGenerationId;
      if (!previousGenerationId || previousGenerationId === context.generationId) {
        throw new TypeError('Projection reset requires distinct browser generations');
      }
      const record = this.#record(
        event.chatId,
        event.agentOwnershipEpoch,
        previousGenerationId,
      );
      if (record.generationId !== previousGenerationId) {
        throw new TypeError('Projection reset does not match the transient feed generation');
      }
      const rows = new Map<string, TransientFeedRow>();
      for (const control of applied.current.controls.values()) {
        const row = toFeedRow(
          control,
          applied,
          context.generationId,
          context.carryOverMessageCount,
        );
        rows.set(row.id, row);
      }
      record.generationId = context.generationId;
      record.agentOwnershipEpoch = event.agentOwnershipEpoch;
      record.rows = rows;
      record.transientRevision += 1;
      record.resetTransactionId = crypto.randomUUID();
      record.stateDigest = stateDigest(rows);
      return {
        kind: 'generation-transition',
        value: {
          resetTransactionId: record.resetTransactionId,
          serverInstanceId: this.serverInstanceId,
          chatId: event.chatId,
          agentOwnershipEpoch: event.agentOwnershipEpoch,
          previousGenerationId,
          generationId: context.generationId,
          transientRevision: record.transientRevision,
          stateDigest: record.stateDigest,
          rows: sortedRows(rows),
        },
      };
    }

    const record = this.#record(
      event.chatId,
      event.agentOwnershipEpoch,
      context.generationId,
    );
    const previousGenerationId = record.generationId;
    const generationChanged = previousGenerationId !== context.generationId;
    if (generationChanged) {
      if (record.rows.size > 0) {
        throw new TypeError('Transient event does not match the browser transcript generation');
      }
    }
    let mutation: ChatTransientFeedMutation['mutation'];
    if (event.kind === 'control') {
      mutation = applyControlMutation(record, applied, context);
    } else {
      const ownedRows = [...record.rows.values()].filter((row) => (
        sameTurnOwner(row.turnOwner, toClientTurnOwner(event.operation.turnOwner))
      ));
      if (ownedRows.length === 0 && !generationChanged) return { kind: 'unchanged' };
      mutation = {
        kind: 'clear-operation',
        turnOwner: toClientTurnOwner(event.operation.turnOwner),
      };
      for (const [id, row] of record.rows) {
        if (sameTurnOwner(row.turnOwner, mutation.turnOwner)) record.rows.delete(id);
      }
    }
    if (generationChanged) {
      record.generationId = context.generationId;
      record.agentOwnershipEpoch = event.agentOwnershipEpoch;
      record.transientRevision += 1;
      record.resetTransactionId = crypto.randomUUID();
      record.stateDigest = stateDigest(record.rows);
      return {
        kind: 'generation-transition',
        value: transitionOf(this.serverInstanceId, record, previousGenerationId),
      };
    }
    record.transientRevision += 1;
    record.resetTransactionId = null;
    record.stateDigest = stateDigest(record.rows);
    return {
      kind: 'mutation',
      value: {
        serverInstanceId: this.serverInstanceId,
        chatId: event.chatId,
        agentOwnershipEpoch: event.agentOwnershipEpoch,
        generationId: record.generationId,
        transientRevision: record.transientRevision,
        stateDigest: record.stateDigest,
        mutation,
      },
    };
  }

  snapshot(input: {
    readonly chatId: string;
    readonly agentOwnershipEpoch: string;
    readonly generationId: string;
  }): ChatTransientFeedSnapshot {
    const record = this.#records.get(input.chatId);
    if (!record) return emptySnapshot(this.serverInstanceId, input);
    if (record.agentOwnershipEpoch !== input.agentOwnershipEpoch
        || record.generationId !== input.generationId) {
      throw new TypeError('Transient feed snapshot does not match the current generation');
    }
    return snapshotOf(this.serverInstanceId, record);
  }

  currentSnapshot(chatId: string): ChatTransientFeedSnapshot | null {
    const record = this.#records.get(chatId);
    return record ? snapshotOf(this.serverInstanceId, record) : null;
  }

  // Carries the current control rows into a new browser transcript generation
  // after a view relist. Anchors keep their carryover-plus-ordinal positions;
  // only the generation identity of each row changes.
  rebaseGeneration(input: {
    readonly chatId: string;
    readonly agentOwnershipEpoch: string;
    readonly previousGenerationId: string;
    readonly generationId: string;
  }): ChatProjectionGenerationTransition {
    if (input.previousGenerationId === input.generationId) {
      throw new TypeError('Generation rebase requires distinct generations');
    }
    const existing = this.#records.get(input.chatId);
    if (existing && existing.generationId !== input.previousGenerationId) {
      throw new TypeError('Generation rebase predecessor is stale');
    }
    const record = this.#record(
      input.chatId,
      input.agentOwnershipEpoch,
      input.previousGenerationId,
    );
    const rows = new Map<string, TransientFeedRow>();
    for (const row of record.rows.values()) {
      rows.set(row.id, {
        ...row,
        transcript: {
          generationId: input.generationId,
          afterSeq: row.transcript.afterSeq,
        },
      });
    }
    record.generationId = input.generationId;
    record.rows = rows;
    record.transientRevision += 1;
    record.resetTransactionId = crypto.randomUUID();
    record.stateDigest = stateDigest(rows);
    return transitionOf(this.serverInstanceId, record, input.previousGenerationId);
  }

  resetEmptyGeneration(input: {
    readonly chatId: string;
    readonly agentOwnershipEpoch: string;
    readonly previousGenerationId: string;
    readonly generationId: string;
  }): ChatProjectionGenerationTransition {
    if (input.previousGenerationId === input.generationId) {
      throw new TypeError('Generation transition requires distinct generations');
    }
    const existing = this.#records.get(input.chatId);
    if (existing && existing.generationId !== input.previousGenerationId) {
      throw new TypeError('Generation transition predecessor is stale');
    }
    const record = this.#record(
      input.chatId,
      input.agentOwnershipEpoch,
      input.previousGenerationId,
    );
    if (record.rows.size > 0) {
      throw new TypeError('An external generation reset cannot discard active controls');
    }
    record.generationId = input.generationId;
    record.agentOwnershipEpoch = input.agentOwnershipEpoch;
    record.transientRevision += 1;
    record.resetTransactionId = crypto.randomUUID();
    record.stateDigest = stateDigest(record.rows);
    return transitionOf(this.serverInstanceId, record, input.previousGenerationId);
  }

  validateAction(action: ChatTransientControlAction): TransientFeedRow {
    if (action.serverInstanceId !== this.serverInstanceId) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_SERVER_RESTARTED');
    }
    const record = this.#records.get(action.chatId);
    if (!record || record.agentOwnershipEpoch !== action.agentOwnershipEpoch) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_OWNERSHIP_CHANGED');
    }
    const row = record.rows.get(action.id);
    if (!row || row.incarnation !== action.incarnation) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_STALE');
    }
    if (!sameTurnOwner(row.turnOwner, action.turnOwner)) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_TURN_CHANGED');
    }
    return row;
  }

  deleteChat(chatId: string): void {
    this.#records.delete(chatId);
  }

  #record(
    chatId: string,
    agentOwnershipEpoch: string,
    generationId: string,
  ): TransientFeedRecord {
    const existing = this.#records.get(chatId);
    if (existing) {
      if (existing.agentOwnershipEpoch !== agentOwnershipEpoch) {
        if (existing.rows.size > 0) {
          throw new TypeError('Cannot replace transient control ownership while rows are active');
        }
        existing.agentOwnershipEpoch = agentOwnershipEpoch;
        existing.generationId = generationId;
        existing.resetTransactionId = null;
        existing.stateDigest = stateDigest(existing.rows);
      }
      return existing;
    }
    const rows = new Map<string, TransientFeedRow>();
    const created: TransientFeedRecord = {
      chatId,
      agentOwnershipEpoch,
      generationId,
      resetTransactionId: null,
      transientRevision: 0,
      stateDigest: stateDigest(rows),
      rows,
    };
    this.#records.set(chatId, created);
    return created;
  }
}

export class TransientControlActionError extends Error {
  constructor(readonly code: string) {
    super(code);
    this.name = 'TransientControlActionError';
  }
}

function applyControlMutation(
  record: TransientFeedRecord,
  applied: AppliedProjectionEvent,
  context: TransientFeedApplyContext,
): ChatTransientFeedMutation['mutation'] {
  const event = applied.event;
  if (event.kind !== 'control') throw new TypeError('Expected a control event');
  const mutation = event.mutation;
  if (mutation.kind === 'upsert') {
    const row = toFeedRow(
      mutation.row,
      applied,
      context.generationId,
      context.carryOverMessageCount,
    );
    record.rows.set(row.id, row);
    return { kind: 'upsert', row };
  }
  if (mutation.kind === 'remove') {
    const row = record.rows.get(mutation.id);
    if (!row || row.incarnation !== mutation.incarnation) {
      throw new TypeError('Transient control removal does not match the browser fold');
    }
    record.rows.delete(mutation.id);
    return mutation;
  }
  record.rows.clear();
  return {
    kind: 'clear-operation',
    turnOwner: toClientTurnOwner(event.operation.turnOwner),
  };
}

function toFeedRow(
  row: AgentControlRow,
  applied: AppliedProjectionEvent,
  generationId: string,
  carryOverMessageCount: number,
): TransientFeedRow {
  const explicitOrdinal = row.anchorEntryId === null
    ? null
    : applied.current.entries.findIndex((entry) => entry.id === row.anchorEntryId) + 1;
  if (row.anchorEntryId !== null && explicitOrdinal === 0) {
    throw new TypeError('Transient control anchor is missing from the projection');
  }
  const ordinal = explicitOrdinal ?? applied.current.checkpoint.projection.durableCount;
  if (ordinal > 0 && applied.current.entries[ordinal - 1]?.lifetime !== 'durable') {
    throw new TypeError('Transient control anchor must be durable');
  }
  return {
    id: row.id,
    incarnation: row.incarnation,
    operationTurnId: row.operation.turnId,
    turnOwner: toClientTurnOwner(row.operation.turnOwner),
    transcript: {
      generationId,
      afterSeq: carryOverMessageCount + ordinal,
    },
    displayOrder: row.displayOrder,
    message: row.message,
  };
}

function toClientTurnOwner(owner: AgentTurnReceiptOwner): ChatTurnReceiptOwner {
  return {
    agentOwnershipEpoch: owner.agentOwnershipEpoch,
    commandType: owner.commandType,
    clientRequestId: owner.clientRequestId,
    turnId: owner.turnId,
  };
}

function sameTurnOwner(left: ChatTurnReceiptOwner, right: ChatTurnReceiptOwner): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.commandType === right.commandType
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function stateDigest(rows: ReadonlyMap<string, TransientFeedRow>): string {
  return `transient-v1:${crypto.createHash('sha256')
    .update(stableJsonStringify([...rows.values()].sort((left, right) => (
      left.id.localeCompare(right.id) || left.incarnation.localeCompare(right.incarnation)
    ))))
    .digest('hex')}`;
}

function sortedRows(rows: ReadonlyMap<string, TransientFeedRow>): TransientFeedRow[] {
  return [...rows.values()].sort((left, right) => (
    left.displayOrder - right.displayOrder
    || left.id.localeCompare(right.id)
    || left.incarnation.localeCompare(right.incarnation)
  ));
}

function snapshotOf(
  serverInstanceId: string,
  record: TransientFeedRecord,
): ChatTransientFeedSnapshot {
  return {
    serverInstanceId,
    chatId: record.chatId,
    agentOwnershipEpoch: record.agentOwnershipEpoch,
    generationId: record.generationId,
    resetTransactionId: record.resetTransactionId,
    transientRevision: record.transientRevision,
    stateDigest: record.stateDigest,
    rows: sortedRows(record.rows),
  };
}

function emptySnapshot(
  serverInstanceId: string,
  input: {
    readonly chatId: string;
    readonly agentOwnershipEpoch: string;
    readonly generationId: string;
  },
): ChatTransientFeedSnapshot {
  const rows = new Map<string, TransientFeedRow>();
  return {
    serverInstanceId,
    chatId: input.chatId,
    agentOwnershipEpoch: input.agentOwnershipEpoch,
    generationId: input.generationId,
    resetTransactionId: null,
    transientRevision: 0,
    stateDigest: stateDigest(rows),
    rows: [],
  };
}

function transitionOf(
  serverInstanceId: string,
  record: TransientFeedRecord,
  previousGenerationId: string,
): ChatProjectionGenerationTransition {
  if (!record.resetTransactionId) {
    throw new TypeError('Generation transition requires a reset transaction ID');
  }
  return {
    resetTransactionId: record.resetTransactionId,
    serverInstanceId,
    chatId: record.chatId,
    agentOwnershipEpoch: record.agentOwnershipEpoch,
    previousGenerationId,
    generationId: record.generationId,
    transientRevision: record.transientRevision,
    stateDigest: record.stateDigest,
    rows: sortedRows(record.rows),
  };
}
