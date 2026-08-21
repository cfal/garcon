import {
  AgentSwitchMessage,
  ErrorMessage,
  PermissionCancelledMessage,
  PermissionExpiredMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TranscriptNoticeMessage,
  UserMessage,
  isCarryoverMigrationQuarantineNoticeDetail,
  type ChatMessage,
  type CliRowPresentationDetail,
} from '../../common/chat-types.js';
import type { TranscriptMessage } from '../../common/chat-view.js';
import {
  isLedgerCliRowNoticeDetail,
  type LedgerCliRowNoticeDetail,
  type LedgerRow,
} from './contracts.js';

function cliRowPresentationDetail(
  detail: LedgerCliRowNoticeDetail,
): CliRowPresentationDetail {
  return {
    type: 'cli-row',
    ...(detail.title === null ? {} : { title: detail.title }),
  };
}

export function ledgerRowsToMessages(rows: readonly LedgerRow[]): ChatMessage[] {
  return rows.flatMap((row) => {
    const message = ledgerRowToMessage(row);
    return message ? [message] : [];
  });
}

export function ledgerRowsToTranscriptMessages(rows: readonly LedgerRow[]): TranscriptMessage[] {
  return rows.flatMap((row) => {
    const message = ledgerRowToMessage(row);
    return message ? [{ ordinal: row.ordinal, message }] : [];
  });
}

export function ledgerRowToMessage(row: LedgerRow): ChatMessage | null {
  switch (row.kind) {
    case 'user-input':
      return row.detail.clientMessageId
        ? new UserMessage(
          row.detail.message.timestamp,
          row.detail.message.content,
          row.detail.message.images,
          {
            ...row.detail.message.metadata,
            clientMessageId: row.detail.clientMessageId,
          },
        )
        : row.detail.message;
    case 'provider-row':
      return row.message;
    case 'notice': {
      if (isLedgerCliRowNoticeDetail(row.detail)) {
        const detail = cliRowPresentationDetail(row.detail);
        return row.detail.presentation === 'error'
          ? new ErrorMessage(row.at, row.message, detail)
          : new TranscriptNoticeMessage(row.at, row.message, detail);
      }
      return new TranscriptNoticeMessage(
        row.at,
        row.message,
        isCarryoverMigrationQuarantineNoticeDetail(row.detail) ? row.detail : undefined,
        typeof row.detail.title === 'string' && row.detail.title ? row.detail.title : undefined,
      );
    }
    case 'agent-switch':
      return new AgentSwitchMessage(
        row.at,
        row.detail.fromAgentId,
        row.detail.toAgentId,
        row.detail.fromModel ?? undefined,
        row.detail.toModel ?? undefined,
      );
    case 'permission-requested':
      return row.lifecycle.kind === 'requested'
        ? new PermissionRequestMessage(
          row.at,
          row.lifecycle.permissionOccurrenceId,
          row.lifecycle.requestedTool,
        )
        : null;
    case 'permission-resolved':
      return row.lifecycle.kind === 'resolved'
        ? new PermissionResolvedMessage(
          row.at,
          row.lifecycle.permissionOccurrenceId,
          row.lifecycle.decision.allow,
        )
        : null;
    case 'permission-cancelled':
      return new PermissionCancelledMessage(
        row.at,
        row.lifecycle.permissionOccurrenceId,
        'cancelled',
      );
    case 'permission-expired':
      return new PermissionExpiredMessage(row.at, row.lifecycle.permissionOccurrenceId);
    case 'session':
    case 'run-ended':
      return null;
  }
}
