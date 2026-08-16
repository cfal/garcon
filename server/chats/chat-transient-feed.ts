import {
  PermissionRequestMessage,
} from '../../common/chat-types.js';
import type {
  ChatTransientControlAction,
  ChatTransientFeedMutation,
  ChatTransientFeedSnapshot,
  TransientFeedRow,
} from '../../common/chat-transient-feed.js';
import type { TranscriptCommitEvent } from '../ledger/service.js';

interface TransientFeedRecord {
  readonly chatId: string;
  transcriptViewId: string;
  transientRevision: number;
  rows: Map<string, TransientFeedRow>;
}

export type AppliedTransientFeedEvent =
  | { readonly kind: 'mutation'; readonly value: ChatTransientFeedMutation }
  | { readonly kind: 'unchanged' };

export class ChatTransientFeedStore {
  readonly #records = new Map<string, TransientFeedRecord>();

  constructor(readonly serverInstanceId: string) {
    if (!serverInstanceId) throw new TypeError('Transient feed requires a server instance ID');
  }

  apply(event: TranscriptCommitEvent): AppliedTransientFeedEvent {
    if (event.type === 'view-replaced') {
      this.#records.set(event.chatId, {
        chatId: event.chatId,
        transcriptViewId: event.view.viewId,
        transientRevision: 0,
        rows: new Map(),
      });
      return { kind: 'unchanged' };
    }
    if (event.type === 'rows' || event.type === 'session') return { kind: 'unchanged' };
    const record = this.#record(event.chatId, event.viewId);
    let mutation: ChatTransientFeedMutation['mutation'];
    if (event.type === 'run-ended') {
      const removed = [...record.rows.values()].some((row) => row.runId === event.runId);
      if (!removed) return { kind: 'unchanged' };
      for (const [id, row] of record.rows) {
        if (row.runId === event.runId) record.rows.delete(id);
      }
      mutation = { kind: 'clear-run', runId: event.runId };
    } else if (event.row.lifecycle.kind === 'requested') {
      if (!event.runId) return { kind: 'unchanged' };
      const lifecycle = event.row.lifecycle;
      const row: TransientFeedRow = {
        permissionOccurrenceId: lifecycle.permissionOccurrenceId,
        runId: event.runId,
        transcript: {
          transcriptViewId: event.viewId,
          afterOrdinal: event.row.ordinal,
        },
        displayOrder: event.row.ordinal,
        message: new PermissionRequestMessage(
          event.row.at,
          lifecycle.permissionOccurrenceId,
          lifecycle.requestedTool,
        ),
      };
      record.rows.set(row.permissionOccurrenceId, row);
      mutation = { kind: 'upsert', row };
    } else {
      const lifecycle = event.row.lifecycle;
      if (!record.rows.delete(lifecycle.permissionOccurrenceId)) return { kind: 'unchanged' };
      mutation = {
        kind: 'remove',
        permissionOccurrenceId: lifecycle.permissionOccurrenceId,
      };
    }
    record.transientRevision += 1;
    return {
      kind: 'mutation',
      value: {
        serverInstanceId: this.serverInstanceId,
        chatId: event.chatId,
        transcriptViewId: record.transcriptViewId,
        transientRevision: record.transientRevision,
        mutation,
      },
    };
  }

  snapshot(input: {
    readonly chatId: string;
    readonly transcriptViewId: string;
  }): ChatTransientFeedSnapshot {
    const record = this.#records.get(input.chatId);
    if (!record) return emptySnapshot(this.serverInstanceId, input);
    if (record.transcriptViewId !== input.transcriptViewId) {
      if (record.rows.size > 0) {
        throw new TypeError('Transient feed snapshot does not match the current transcript view');
      }
      record.transcriptViewId = input.transcriptViewId;
      record.transientRevision = 0;
    }
    return snapshotOf(this.serverInstanceId, record);
  }

  currentSnapshot(chatId: string): ChatTransientFeedSnapshot | null {
    const record = this.#records.get(chatId);
    return record ? snapshotOf(this.serverInstanceId, record) : null;
  }

  validateAction(action: ChatTransientControlAction): TransientFeedRow {
    if (action.serverInstanceId !== this.serverInstanceId) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_SERVER_RESTARTED');
    }
    const row = this.#records
      .get(action.chatId)
      ?.rows.get(action.permissionOccurrenceId);
    if (!row || row.runId !== action.runId) {
      throw new TransientControlActionError('TRANSIENT_CONTROL_STALE');
    }
    return row;
  }

  deleteChat(chatId: string): void {
    this.#records.delete(chatId);
  }

  #record(chatId: string, transcriptViewId: string): TransientFeedRecord {
    const existing = this.#records.get(chatId);
    if (existing) {
      if (existing.transcriptViewId !== transcriptViewId) {
        if (existing.rows.size > 0) {
          throw new TypeError('Cannot replace a transient feed with active controls');
        }
        existing.transcriptViewId = transcriptViewId;
        existing.transientRevision = 0;
      }
      return existing;
    }
    const created: TransientFeedRecord = {
      chatId,
      transcriptViewId,
      transientRevision: 0,
      rows: new Map(),
    };
    this.#records.set(chatId, created);
    return created;
  }
}

export type TransientControlActionErrorCode =
  | 'TRANSIENT_CONTROL_SERVER_RESTARTED'
  | 'TRANSIENT_CONTROL_STALE';

export class TransientControlActionError extends Error {
  constructor(readonly code: TransientControlActionErrorCode) {
    super(code === 'TRANSIENT_CONTROL_SERVER_RESTARTED'
      ? 'The server restarted; this permission control is no longer actionable'
      : 'This permission control is no longer actionable');
    this.name = 'TransientControlActionError';
  }
}

function snapshotOf(
  serverInstanceId: string,
  record: TransientFeedRecord,
): ChatTransientFeedSnapshot {
  return {
    serverInstanceId,
    chatId: record.chatId,
    transcriptViewId: record.transcriptViewId,
    transientRevision: record.transientRevision,
    rows: [...record.rows.values()].sort((left, right) => (
      left.displayOrder - right.displayOrder
      || left.permissionOccurrenceId.localeCompare(right.permissionOccurrenceId)
    )),
  };
}

function emptySnapshot(
  serverInstanceId: string,
  input: { readonly chatId: string; readonly transcriptViewId: string },
): ChatTransientFeedSnapshot {
  return {
    serverInstanceId,
    chatId: input.chatId,
    transcriptViewId: input.transcriptViewId,
    transientRevision: 0,
    rows: [],
  };
}
