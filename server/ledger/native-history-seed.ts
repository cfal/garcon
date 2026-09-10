import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { toProviderNativeChatReference } from '../agents/integration-chat-reference.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import type { ProviderHistoryImportService } from '../execution-nodes/provider-history-import.js';
import { DomainError } from '../lib/domain-error.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';
import { importedDrafts, type ImportedRow } from './imported-drafts.js';
import {
  sanitizeRecordedPreamblePrefixes,
  type PreambleHistoryEvidence,
} from './preamble-history.js';

export type LedgerSessionDetail = Extract<LedgerRow, { readonly kind: 'session' }>['detail'];

export interface NativeHistorySeedInput {
  readonly chatId: string;
  readonly entry: AgentChatEntry;
  readonly nativeHistoryImport: ProviderHistoryImportService;
  readonly session: LedgerSessionDetail;
  readonly carryOverRevision: string;
  readonly signal: AbortSignal;
  readonly now: () => string;
  readonly preambleEvidence?: readonly PreambleHistoryEvidence[];
}

// Reads a session's native history as ledger drafts. Reload and native fork both rebuild a feed
// from the provider's own record, so they share the import and its lossiness: provider-native
// rendering, no Garcon-only rows, and folded prompts where inputs were combined.
export async function importNativeHistoryDrafts({
  chatId,
  entry,
  nativeHistoryImport,
  session,
  carryOverRevision,
  signal,
  now,
  preambleEvidence = [],
}: NativeHistorySeedInput): Promise<LedgerRowDraft[]> {
  signal.throwIfAborted();
  const imported: ImportedRow[] = [];
  const chat = toProviderNativeChatReference(
    chatId,
    {
      ...entry,
      agentSessionId: session.agentSessionId,
      nativeSession: session.nativeSession,
      nativeSeedReceipt: session.nativeSeedReceipt,
    },
    carryOverRevision,
  );
  for await (const batch of nativeHistoryImport.read({ chat }, signal)) {
    signal.throwIfAborted();
    for (const row of batch) {
      imported.push({ message: row.message, providerMeta: row.providerMeta ?? null });
    }
  }
  signal.throwIfAborted();
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
  const preambles = sanitizeRecordedPreamblePrefixes({
    messages: sanitized.messages,
    evidence: preambleEvidence,
  });
  if (preambles.kind === 'not-yet-persisted') {
    throw new DomainError(
      'HISTORY_LOAD_FAILED',
      'The native transcript has not persisted the completed turn yet. Try again shortly.',
      409,
      true,
    );
  }
  if (preambles.kind === 'mismatch') {
    throw new DomainError(
      'PREAMBLE_ENVELOPE_MISMATCH',
      'The native transcript preamble envelope does not match this chat.',
      422,
      false,
    );
  }
  // Sanitizing rewrites a seed prompt in place and never changes the count, so each message
  // keeps the provider identity it arrived with.
  return importedDrafts(
    preambles.messages.map(({ message, application }, index) => ({
      message,
      providerMeta: imported[index]!.providerMeta,
      ...(application ? { preambleApplication: application } : {}),
    })),
    now,
  );
}
