import {
  PermissionRequestMessage,
} from '$shared/chat-types';
import type {
  ChatProjectionGenerationTransition,
  ChatTransientControlAction,
  ChatTransientFeedMutation,
  ChatTransientFeedSnapshot,
  ChatTurnReceiptOwner,
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
  if (!current) return { kind: 'applied', snapshot: cloneSnapshot(incoming) };
  if (current.serverInstanceId !== incoming.serverInstanceId) {
    return { kind: 'applied', snapshot: cloneSnapshot(incoming) };
  }
  if (current.chatId !== incoming.chatId) return { kind: 'stale' };
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
  if (incoming.transientRevision === current.transientRevision) {
    return current.agentOwnershipEpoch === incoming.agentOwnershipEpoch
      && current.generationId === incoming.generationId
      && current.stateDigest === incoming.stateDigest
      ? { kind: 'duplicate' }
      : { kind: 'corrupt' };
  }
  if (incoming.transientRevision !== current.transientRevision + 1
      || incoming.agentOwnershipEpoch !== current.agentOwnershipEpoch
      || incoming.generationId !== current.generationId) {
    return { kind: 'snapshot-required' };
  }
  const rows = new Map(current.rows.map((row) => [row.id, row]));
  const mutation = incoming.mutation;
  if (mutation.kind === 'upsert') {
    rows.set(mutation.row.id, mutation.row);
  } else if (mutation.kind === 'remove') {
    const row = rows.get(mutation.id);
    if (!row || row.incarnation !== mutation.incarnation) return { kind: 'corrupt' };
    rows.delete(mutation.id);
  } else {
    for (const [id, row] of rows) {
      if (sameTurnOwner(row.turnOwner, mutation.turnOwner)) rows.delete(id);
    }
  }
  return {
    kind: 'applied',
    snapshot: {
      serverInstanceId: incoming.serverInstanceId,
      chatId: incoming.chatId,
      agentOwnershipEpoch: incoming.agentOwnershipEpoch,
      generationId: incoming.generationId,
      resetTransactionId: null,
      transientRevision: incoming.transientRevision,
      stateDigest: incoming.stateDigest,
      rows: sortedRows(rows.values()),
    },
  };
}

export function applyProjectionGenerationTransition(
  current: ChatTransientFeedSnapshot | null,
  incoming: ChatProjectionGenerationTransition,
): TransientFeedApplyResult {
  if (current) {
    if (current.serverInstanceId !== incoming.serverInstanceId
        || current.chatId !== incoming.chatId) return { kind: 'stale' };
    if (incoming.transientRevision < current.transientRevision) return { kind: 'stale' };
    if (incoming.transientRevision === current.transientRevision) {
      return current.stateDigest === incoming.stateDigest
        && current.agentOwnershipEpoch === incoming.agentOwnershipEpoch
        && current.generationId === incoming.generationId
        && current.resetTransactionId === incoming.resetTransactionId
        ? { kind: 'duplicate' }
        : { kind: 'corrupt' };
    }
    if (incoming.transientRevision !== current.transientRevision + 1
        || incoming.previousGenerationId !== current.generationId) {
      return { kind: 'snapshot-required' };
    }
  }
  return {
    kind: 'applied',
    snapshot: {
      serverInstanceId: incoming.serverInstanceId,
      chatId: incoming.chatId,
      agentOwnershipEpoch: incoming.agentOwnershipEpoch,
      generationId: incoming.generationId,
      resetTransactionId: incoming.resetTransactionId,
      transientRevision: incoming.transientRevision,
      stateDigest: incoming.stateDigest,
      rows: incoming.rows.map(cloneRow),
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
      agentOwnershipEpoch: snapshot.agentOwnershipEpoch,
      turnOwner: row.turnOwner,
      id: row.id,
      incarnation: row.incarnation,
    };
    return [{
      permissionRequestId: row.message.permissionRequestId,
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
    && left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.generationId === right.generationId
    && left.resetTransactionId === right.resetTransactionId
    && left.stateDigest === right.stateDigest;
}

function sameTurnOwner(left: ChatTurnReceiptOwner, right: ChatTurnReceiptOwner): boolean {
  return left.agentOwnershipEpoch === right.agentOwnershipEpoch
    && left.commandType === right.commandType
    && left.clientRequestId === right.clientRequestId
    && left.turnId === right.turnId;
}

function cloneSnapshot(snapshot: ChatTransientFeedSnapshot): ChatTransientFeedSnapshot {
  return { ...snapshot, rows: snapshot.rows.map(cloneRow) };
}

function cloneRow(row: TransientFeedRow): TransientFeedRow {
  return { ...row, transcript: { ...row.transcript }, turnOwner: { ...row.turnOwner } };
}

function sortedRows(rows: Iterable<TransientFeedRow>): TransientFeedRow[] {
  return [...rows].map(cloneRow).sort((left, right) => (
    left.displayOrder - right.displayOrder
    || left.id.localeCompare(right.id)
    || left.incarnation.localeCompare(right.incarnation)
  ));
}
