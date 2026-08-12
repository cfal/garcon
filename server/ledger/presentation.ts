import {
  PermissionCancelledMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import type { LedgerRow } from './contracts.js';

export function ledgerRowsToMessages(rows: readonly LedgerRow[]): ChatMessage[] {
  return rows.flatMap((row) => {
    switch (row.kind) {
      case 'user-input':
        return [row.detail.message];
      case 'provider-row':
        return [row.message];
      case 'permission-requested':
        return row.lifecycle.kind === 'requested'
          ? [new PermissionRequestMessage(row.at, row.lifecycle.requestId, row.lifecycle.requestedTool)]
          : [];
      case 'permission-resolved':
        return row.lifecycle.kind === 'resolved'
          ? [new PermissionResolvedMessage(row.at, row.lifecycle.requestId, row.lifecycle.decision.allow)]
          : [];
      case 'permission-cancelled':
        return [new PermissionCancelledMessage(row.at, row.lifecycle.requestId, 'cancelled')];
      default:
        return [];
    }
  });
}
