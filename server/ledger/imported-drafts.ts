import {
  isToolUseMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import {
  extractGarconCommands,
  parseGarconMessage,
} from '../../common/garcon-commands.js';
import {
  isCarryoverMigrationQuarantineNoticeDetail,
  isPreambleApplicationNoticeDetail,
} from '../../common/transcript-notice-details.js';
import {
  chatIdDisclosureNoticeContent,
  CHAT_ID_DISCOVERY_NOTICE_TITLE,
  parseChatIdDisclosure,
} from '../../common/chat-id-discovery.js';
import type { JsonObject } from '../../common/json.js';
import {
  chatIdRequestNoticeDraft,
  interAgentSendRequestNoticeDraft,
} from './garcon-command-request.js';
import type { LedgerRowDraft } from './contracts.js';
import type { PreambleHistoryEvidence } from './preamble-history.js';

export interface ImportedRow {
  readonly message: ChatMessage;
  readonly providerMeta: JsonObject | null;
  readonly preambleApplication?: PreambleHistoryEvidence;
}

// Turns provider-supplied history into ledger drafts. Adoption, reload, and native fork all
// read a provider's own record and must agree on what it becomes, so they share this mapping.
export function importedDrafts(
  rows: readonly ImportedRow[],
  now: () => string,
): LedgerRowDraft[] {
  return rows.flatMap(({ message, providerMeta, preambleApplication }) =>
    importedDraftFor(message, providerMeta, now, preambleApplication));
}

// Turns conversation carried over from an earlier agent into frozen drafts. No provider ever
// held these rows, so they carry no provider identity, but their originating input IDs survive
// so a resend fold can still recognize them.
export function frozenDrafts(
  messages: readonly ChatMessage[],
  now: () => string = () => new Date().toISOString(),
): LedgerRowDraft[] {
  return messages.flatMap((message) => frozenDraftFor(message, now));
}

// Permission lifecycle is reconstructed from its own durable rows, never from imported history.
function importedDraftFor(
  original: ChatMessage,
  providerMeta: JsonObject | null,
  now: () => string,
  preambleApplication?: PreambleHistoryEvidence,
): LedgerRowDraft[] {
  const at = original.timestamp || now();
  if (original.type === 'user-message' && preambleApplication) {
    return importedUserInputDrafts(original, providerMeta, at, preambleApplication);
  }
  const commandTransform = extractGarconCommands(original);
  if (commandTransform) {
    return [
      ...(commandTransform.message
        ? [{ kind: 'provider-row' as const, at, message: commandTransform.message, providerMeta }]
        : []),
      ...commandTransform.commands.map((command) => {
        switch (command.type) {
          case 'get-chat-id':
            return chatIdRequestNoticeDraft(at);
          case 'send-message':
            return interAgentSendRequestNoticeDraft(at, {
              recipients: command.recipients,
              hideSender: command.hideSender,
              body: command.body,
            });
        }
      }),
    ];
  }
  if (original.type === 'user-message') {
    const received = parseGarconMessage(original.content);
    if (received) {
      return [{
        kind: 'notice',
        at: original.timestamp || now(),
        message: received.body,
        detail: {
          type: 'inter-agent-message-received',
          fromChatId: received.fromChatId,
          title: received.fromChatId === null
            ? 'Inter-agent message'
            : `Message from chat ${received.fromChatId}`,
        },
        providerMeta: null,
      }];
    }
    const disclosedChatId = parseChatIdDisclosure(original.content);
    if (disclosedChatId) {
      return [{
        kind: 'notice',
        at: original.timestamp || now(),
        message: chatIdDisclosureNoticeContent(disclosedChatId),
        detail: { type: 'chat-id-disclosure', title: CHAT_ID_DISCOVERY_NOTICE_TITLE },
        providerMeta: null,
      }];
    }
  }
  if (original.type === 'permission-request'
      || original.type === 'permission-resolved'
      || original.type === 'permission-cancelled'
      || original.type === 'permission-expired') return [];
  if (original.type === 'user-message') {
    return importedUserInputDrafts(original, providerMeta, at);
  }
  return [{ kind: 'provider-row', at, message: original, providerMeta }];
}

function importedUserInputDrafts(
  message: Extract<ChatMessage, { type: 'user-message' }>,
  providerMeta: JsonObject | null,
  at: string,
  preambleApplication?: PreambleHistoryEvidence,
): LedgerRowDraft[] {
  return [
    ...(preambleApplication
      ? [{
          kind: 'notice' as const,
          at,
          message: 'Preambles applied',
          detail: {
            type: 'preamble-application' as const,
            preambles: preambleApplication.preambles.map((preamble) => ({ ...preamble })),
          },
          providerMeta: null,
        }]
      : []),
    {
      kind: 'user-input',
      at,
      detail: {
        clientMessageId: null,
        message,
        attachments: (message.images ?? []).map((image) => ({
          kind: 'image' as const,
          data: image.data,
          name: image.name || null,
          mimeType: image.mimeType ?? 'application/octet-stream',
        })),
        steer: false,
        preambleBoundary: preambleApplication?.boundary ?? null,
        preamblePrefixReceipt: preambleApplication?.receipt ?? null,
      },
      providerMeta,
    },
  ];
}

function frozenDraftFor(message: ChatMessage, now: () => string): LedgerRowDraft[] {
  const at = message.timestamp || now();
  if (isToolUseMessage(message)) {
    return [{ kind: 'provider-row', at, message, providerMeta: null }];
  }

  switch (message.type) {
    case 'user-message':
      return [{
        kind: 'user-input',
        at,
        detail: {
          clientMessageId: message.metadata?.upstreamRequestId ?? null,
          message,
          attachments: (message.images ?? []).map((image) => ({
            kind: 'image',
            data: image.data,
            name: image.name || null,
            mimeType: image.mimeType ?? 'application/octet-stream',
          })),
          steer: false,
          preambleBoundary: null,
          preamblePrefixReceipt: null,
        },
        providerMeta: null,
      }];
    case 'assistant-message':
    case 'thinking':
    case 'tool-result':
    case 'error':
    case 'compaction':
      return [{ kind: 'provider-row', at, message, providerMeta: null }];
    case 'cli-row':
      return [];
    case 'agent-switch':
      return [{
        kind: 'agent-switch',
        at,
        detail: {
          fromAgentId: message.fromAgentId,
          toAgentId: message.toAgentId,
          fromModel: message.fromModel ?? null,
          toModel: message.toModel ?? null,
        },
        providerMeta: null,
      }];
    case 'transcript-notice':
      if (
        !isCarryoverMigrationQuarantineNoticeDetail(message.detail)
        && !isPreambleApplicationNoticeDetail(message.detail)
      ) return [];
      if (isPreambleApplicationNoticeDetail(message.detail)) {
        return [{
          kind: 'notice',
          at,
          message: message.content,
          detail: {
            type: message.detail.type,
            preambles: message.detail.preambles.map((preamble) => ({ ...preamble })),
          },
          providerMeta: null,
        }];
      }
      return [{
        kind: 'notice',
        at,
        message: message.content,
        detail: {
          type: message.detail.type,
          artifactId: message.detail.artifactId,
          errorCode: message.detail.errorCode,
        },
        providerMeta: null,
      }];
    case 'permission-request':
    case 'permission-resolved':
    case 'permission-cancelled':
    case 'permission-expired':
      return [];
  }
}
