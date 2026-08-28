import {
  isCarryoverMigrationQuarantineNoticeDetail,
  isToolUseMessage,
  type ChatMessage,
} from '../../common/chat-types.js';
import type { JsonObject } from '../../common/json.js';
import {
  CHAT_ID_DISCOVERY_DISABLED_NOTICE_CONTENT,
  CHAT_ID_REQUEST_NOTICE_CONTENT,
  CHAT_ID_REQUEST_NOTICE_TITLE,
  sanitizeImportedChatIdDisclosure,
  transformChatIdRequest,
} from '../../common/chat-id-discovery.js';
import type { LedgerRowDraft } from './contracts.js';

export interface ImportedRow {
  readonly message: ChatMessage;
  readonly providerMeta: JsonObject | null;
}

interface ImportedDraftOptions {
  readonly chatIdDiscoveryEnabled?: boolean;
}

// Turns provider-supplied history into ledger drafts. Adoption, reload, and native fork all
// read a provider's own record and must agree on what it becomes, so they share this mapping.
export function importedDrafts(
  rows: readonly ImportedRow[],
  now: () => string,
  options: ImportedDraftOptions = {},
): LedgerRowDraft[] {
  return rows.flatMap(({ message, providerMeta }) => importedDraftFor(
    message,
    providerMeta,
    now,
    options.chatIdDiscoveryEnabled ?? true,
  ));
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
  chatIdDiscoveryEnabled: boolean,
): LedgerRowDraft[] {
  const request = transformChatIdRequest(original);
  if (request) {
    const at = original.timestamp || now();
    return [
      ...(request.message
        ? [{ kind: 'provider-row' as const, at, message: request.message, providerMeta }]
        : []),
      {
        kind: 'notice',
        at,
        message: chatIdDiscoveryEnabled
          ? CHAT_ID_REQUEST_NOTICE_CONTENT
          : CHAT_ID_DISCOVERY_DISABLED_NOTICE_CONTENT,
        detail: chatIdDiscoveryEnabled
          ? { type: 'chat-id-request', title: CHAT_ID_REQUEST_NOTICE_TITLE }
          : { type: 'chat-id-discovery-disabled', title: CHAT_ID_REQUEST_NOTICE_TITLE },
        providerMeta: null,
      },
    ];
  }
  const message = sanitizeImportedChatIdDisclosure(original);
  if (message.type === 'permission-request'
      || message.type === 'permission-resolved'
      || message.type === 'permission-cancelled'
      || message.type === 'permission-expired') return [];
  const at = message.timestamp || now();
  if (message.type === 'user-message') {
    return [{
      kind: 'user-input',
      at,
      detail: {
        clientMessageId: null,
        message,
        attachments: (message.images ?? []).map((image) => ({
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
  return [{ kind: 'provider-row', at, message, providerMeta }];
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
