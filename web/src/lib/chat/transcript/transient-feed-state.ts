import { PermissionRequestMessage, permissionOccurrenceKey } from '$shared/chat-types';
import type {
  ChatTransientControlAction,
  ChatTransientFeedMutation,
  ChatTransientFeedSnapshot,
  TransientFeedRow,
} from '$shared/chat-transient-feed';
import type { PendingPermissionRequest } from '$lib/types/chat';

export type TransientFeedApplyResult =
  | { kind: 'applied'; snapshot: ChatTransientFeedSnapshot }
  | { kind: 'duplicate' }
  | { kind: 'stale' }
  | { kind: 'snapshot-required' }
  | { kind: 'corrupt' };

export function applyTransientFeedSnapshot(
  current: ChatTransientFeedSnapshot | null,
  incoming: ChatTransientFeedSnapshot,
): TransientFeedApplyResult {
  if (!current || current.serverInstanceId !== incoming.serverInstanceId) {
    return { kind: 'applied', snapshot: cloneSnapshot(incoming) };
  }
  if (current.chatId !== incoming.chatId) return { kind: 'stale' };
  if (current.transcriptViewId !== incoming.transcriptViewId) {
    return { kind: 'applied', snapshot: cloneSnapshot(incoming) };
  }
  if (incoming.transientRevision < current.transientRevision) return { kind: 'stale' };
  if (incoming.transientRevision === current.transientRevision) {
    return sameStateIdentity(current, incoming) ? { kind: 'duplicate' } : { kind: 'corrupt' };
  }
  return { kind: 'applied', snapshot: cloneSnapshot(incoming) };
}

export function applyTransientFeedMutation(
  current: ChatTransientFeedSnapshot | null,
  incoming: ChatTransientFeedMutation,
): TransientFeedApplyResult {
  if (!current) return { kind: 'snapshot-required' };
  if (current.serverInstanceId !== incoming.serverInstanceId
      || current.chatId !== incoming.chatId) return { kind: 'stale' };
  if (incoming.transientRevision < current.transientRevision) return { kind: 'stale' };
  if (incoming.transientRevision === current.transientRevision) return { kind: 'duplicate' };
  if (incoming.transientRevision !== current.transientRevision + 1
      || incoming.transcriptViewId !== current.transcriptViewId) {
    return { kind: 'snapshot-required' };
  }
  const rows = new Map(current.rows.map((row) => [
    permissionOccurrenceKey(row.id, row.incarnation),
    row,
  ]));
  const mutation = incoming.mutation;
  if (mutation.kind === 'upsert') {
    rows.set(permissionOccurrenceKey(mutation.row.id, mutation.row.incarnation), mutation.row);
  } else if (mutation.kind === 'remove') {
    const key = permissionOccurrenceKey(mutation.id, mutation.incarnation);
    if (!rows.delete(key)) return { kind: 'corrupt' };
  } else {
    for (const [id, row] of rows) {
      if (row.runId === mutation.runId) rows.delete(id);
    }
  }
  return {
    kind: 'applied',
    snapshot: {
      serverInstanceId: incoming.serverInstanceId,
      chatId: incoming.chatId,
      transcriptViewId: incoming.transcriptViewId,
      transientRevision: incoming.transientRevision,
      rows: sortedRows(rows.values()),
    },
  };
}

export function pendingPermissionsFromTransientFeed(
  snapshot: ChatTransientFeedSnapshot | null,
): PendingPermissionRequest[] {
  if (!snapshot) return [];
  return snapshot.rows.flatMap((row) => {
    if (!(row.message instanceof PermissionRequestMessage)) return [];
    const control: ChatTransientControlAction = {
      serverInstanceId: snapshot.serverInstanceId,
      chatId: snapshot.chatId,
      runId: row.runId,
      id: row.id,
      incarnation: row.incarnation,
    };
    return [{
      permissionRequestId: row.message.permissionRequestId,
      incarnation: row.incarnation,
      requestedTool: row.message.requestedTool,
      chatId: snapshot.chatId,
      receivedAt: new Date(row.message.timestamp),
      control,
      transcript: { ...row.transcript },
    }];
  });
}

function sameStateIdentity(
  left: ChatTransientFeedSnapshot,
  right: ChatTransientFeedSnapshot,
): boolean {
  return left.chatId === right.chatId
    && left.transcriptViewId === right.transcriptViewId
    && JSON.stringify(left.rows) === JSON.stringify(right.rows);
}

function cloneSnapshot(snapshot: ChatTransientFeedSnapshot): ChatTransientFeedSnapshot {
  return { ...snapshot, rows: snapshot.rows.map(cloneRow) };
}

function cloneRow(row: TransientFeedRow): TransientFeedRow {
  return { ...row, transcript: { ...row.transcript } };
}

function sortedRows(rows: Iterable<TransientFeedRow>): TransientFeedRow[] {
  return [...rows].map(cloneRow).sort((left, right) => (
    left.displayOrder - right.displayOrder
    || left.id.localeCompare(right.id)
    || left.incarnation.localeCompare(right.incarnation)
  ));
}
