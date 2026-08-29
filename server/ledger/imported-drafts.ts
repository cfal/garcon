import {
  isToolUseMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import { isCarryoverMigrationQuarantineNoticeDetail } from '../../common/transcript-notice-details.js';
import {
  chatIdDisclosureNoticeContent,
  CHAT_ID_DISCOVERY_NOTICE_TITLE,
  parseChatIdDisclosure,
  transformChatIdRequest,
} from '../../common/chat-id-discovery.js';
import type { JsonObject } from '../../common/json.js';
import { chatIdRequestNoticeDraft } from './garcon-command-request.js';
import type { LedgerRowDraft } from './contracts.js';

export interface ImportedRow {
  readonly message: ChatMessage;
  readonly providerMeta: JsonObject | null;
}

// Turns provider-supplied history into ledger drafts. Adoption, reload, and native fork all
// read a provider's own record and must agree on what it becomes, so they share this mapping.
export function importedDrafts(
  rows: readonly ImportedRow[],
  now: () => string,
): LedgerRowDraft[] {
  return rows.flatMap(({ message, providerMeta }) => importedDraftFor(message, providerMeta, now));
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
): LedgerRowDraft[] {
  const request = transformChatIdRequest(original);
  if (request) {
    const at = original.timestamp || now();
    return [
      ...(request.message
        ? [{ kind: 'provider-row' as const, at, message: request.message, providerMeta }]
        : []),
      chatIdRequestNoticeDraft(at),
    ];
  }
  if (original.type === 'user-message') {
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
  const at = original.timestamp || now();
  if (original.type === 'user-message') {
    return [{
      kind: 'user-input',
      at,
      detail: {
        clientMessageId: null,
        message: original,
        attachments: (original.images ?? []).map((image) => ({
          kind: 'image',
          data: image.data,
          name: image.name || null,
          mimeType: image.mimeType ?? 'application/octet-stream',
        })),
        steer: false,
      },
      providerMeta,
    }];
  }
  return [{ kind: 'provider-row', at, message: original, providerMeta }];
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
      if (!isCarryoverMigrationQuarantineNoticeDetail(message.detail)) return [];
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
