import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { ChatMessage } from '../../common/chat-types.js';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import { DomainError } from '../lib/domain-error.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';

export type LedgerSessionDetail = Extract<LedgerRow, { readonly kind: 'session' }>['detail'];

export interface NativeHistorySeedInput {
  readonly chatId: string;
  readonly entry: AgentChatEntry;
  readonly integration: AgentIntegration;
  readonly session: LedgerSessionDetail;
  readonly carryOverRevision: string;
  readonly signal: AbortSignal;
  readonly now: () => string;
}

// Reads a session's native history as ledger drafts. Reload and native fork both rebuild a feed
// from the provider's own record, so they share the import and its lossiness: provider-native
// rendering, no Garcon-only rows, and folded prompts where inputs were combined.
export async function importNativeHistoryDrafts({
  chatId,
  entry,
  integration,
  session,
  carryOverRevision,
  signal,
  now,
}: NativeHistorySeedInput): Promise<LedgerRowDraft[]> {
  const imported: Array<{
    readonly message: ChatMessage;
    readonly providerMeta: LedgerRowDraft['providerMeta'];
  }> = [];
  const chat = toAgentChatReference(
    integration,
    chatId,
    {
      ...entry,
      agentSessionId: session.agentSessionId,
      nativeSession: session.nativeSession,
      nativeSeedReceipt: session.nativeSeedReceipt,
    },
    carryOverRevision,
  );
  for await (const batch of integration.nativeHistoryImport!.load({ chat, signal })) {
    signal.throwIfAborted();
    for (const row of batch) {
      imported.push({ message: row.message, providerMeta: row.providerMeta ?? null });
    }
  }
  const sanitized = sanitizeRecordedCarriedContext({
    messages: imported.map((row) => row.message),
    receipt: session.nativeSeedReceipt,
    agentSessionId: session.agentSessionId,
  });
  if (sanitized.kind === 'mismatch') {
    throw new DomainError(
      'CONTEXT_ENVELOPE_MISMATCH',
      'The native transcript seed does not match this chat.',
      422,
      false,
    );
  }
  return sanitized.messages.flatMap((message, index) => importedDraft(
    message,
    imported[index]!.providerMeta,
    now,
  ));
}

function importedDraft(
  message: ChatMessage,
  providerMeta: LedgerRowDraft['providerMeta'],
  now: () => string,
): readonly LedgerRowDraft[] {
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
