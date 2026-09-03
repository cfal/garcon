import type { AgentHistoryImport, AgentIntegration } from '@garcon/server-agent-interface';
import { sanitizeRecordedCarriedContext } from '../../common/transcript-seed.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { AgentChatEntry } from '../agents/session-types.js';
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
  readonly integration: AgentIntegration;
  // Taken separately so the caller's capability check, not an assertion here, proves it exists.
  readonly nativeHistoryImport: AgentHistoryImport;
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
  integration,
  nativeHistoryImport,
  session,
  carryOverRevision,
  signal,
  now,
  preambleEvidence = [],
}: NativeHistorySeedInput): Promise<LedgerRowDraft[]> {
  const imported: ImportedRow[] = [];
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
  for await (const batch of nativeHistoryImport.load({ chat, signal })) {
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
  const preambles = sanitizeRecordedPreamblePrefixes({
    messages: sanitized.messages,
    evidence: preambleEvidence,
  });
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
