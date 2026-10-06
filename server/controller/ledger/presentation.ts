import {
  AgentSwitchMessage,
  CliRowMessage,
  PermissionCancelledMessage,
  PermissionExpiredMessage,
  PermissionRequestMessage,
  PermissionResolvedMessage,
  TranscriptNoticeMessage,
  UserMessage,
  type ChatMessage,
} from '../../../common/chat-types.js';
import { parseTranscriptNoticeDetail } from '../../../common/transcript-notice-details.js';
import { parseAgentStartProgressNotice } from '../../../common/agent-start-progress.js';
import type { TranscriptMessage } from '../../../common/chat-view.js';
import { isLedgerPrivateGarconCommandRow } from './garcon-command-request.js';
import {
  isLedgerCliRowNoticeDetail,
  isLedgerPreambleSelectionChangedNoticeDetail,
  projectLedgerAgentCommandOutcome,
  projectLedgerTicketCommandOutcome,
  type LedgerRow,
} from './contracts.js';

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
      return userMessageWithSubmissionIdentity(row.detail.message, row.detail.clientMessageId);
    case 'provider-row':
      return row.message instanceof UserMessage
        ? userMessageWithSubmissionIdentity(row.message, null)
        : row.message;
    case 'notice': {
      if (isLedgerPrivateGarconCommandRow(row)) return null;
      if (isLedgerCliRowNoticeDetail(row.detail)) {
        return new CliRowMessage(
          row.at,
          row.message,
          row.detail.presentation,
          row.detail.format,
          row.detail.title ?? undefined,
          row.detail.disclosure,
        );
      }
      // Presentation converts the private identity-carrying detail to the exact
      // public selection-changed detail; the submission identity never renders.
      if (isLedgerPreambleSelectionChangedNoticeDetail(row.detail)) {
        return new TranscriptNoticeMessage(
          row.at,
          row.message,
          {
            type: 'preamble-selection-changed',
            preambles: row.detail.preambles.map((preamble) => ({ ...preamble })),
          },
          undefined,
        );
      }
      if (row.detail.type === 'agent-start-progress') {
        const { title, ...detail } = row.detail;
        return new TranscriptNoticeMessage(row.at, row.message,
          parseAgentStartProgressNotice(detail) ?? undefined,
          typeof title === 'string' ? title : undefined);
      }
      return new TranscriptNoticeMessage(
        row.at,
        row.message,
        projectLedgerAgentCommandOutcome(row.detail) ?? projectLedgerTicketCommandOutcome(row.detail)
          ?? parseTranscriptNoticeDetail(row.detail) ?? undefined,
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
        row.detail.fromExecutorId,
        row.detail.toExecutorId,
      );
    case 'permission-requested':
      return row.lifecycle.kind === 'requested'
        ? new PermissionRequestMessage(
          row.at,
          row.lifecycle.permissionOccurrenceId,
          row.lifecycle.requestedTool,
          row.lifecycle.reason,
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

function userMessageWithSubmissionIdentity(message: UserMessage, clientMessageId: string | null): UserMessage {
  if ((message.metadata?.clientMessageId ?? null) === clientMessageId) return message;
  // Only the ledger's indexed submission identity may settle an optimistic input.
  const metadata = { ...message.metadata };
  delete metadata.clientMessageId;
  if (clientMessageId !== null) metadata.clientMessageId = clientMessageId;
  return new UserMessage(
    message.timestamp,
    message.content,
    message.images,
    Object.keys(metadata).length > 0 ? metadata : undefined,
    message.presentation,
  );
}
