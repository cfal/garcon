import type { ChatMessage } from '../../common/chat-types.js';
import type { JsonObject } from '../../common/json.js';
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
  return rows.flatMap(({ message, providerMeta }) => draftFor(message, providerMeta, null, now));
}

// Turns conversation carried over from an earlier agent into frozen drafts. No provider ever
// held these rows, so they carry no provider identity, but their originating input IDs survive
// so a resend fold can still recognize them.
export function frozenDrafts(
  messages: readonly ChatMessage[],
  now: () => string = () => new Date().toISOString(),
): LedgerRowDraft[] {
  return messages.flatMap((message) => draftFor(
    message,
    null,
    message.type === 'user-message' ? message.metadata?.upstreamRequestId ?? null : null,
    now,
  ));
}

// Permission lifecycle is reconstructed from its own durable rows, never from imported history.
function draftFor(
  message: ChatMessage,
  providerMeta: JsonObject | null,
  clientMessageId: string | null,
  now: () => string,
): LedgerRowDraft[] {
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
        clientMessageId,
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
