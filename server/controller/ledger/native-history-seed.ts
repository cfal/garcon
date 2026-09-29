import type { AgentHistoryImport, AgentIntegration } from '@garcon/server-agent-interface';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import type { ChatMessage } from '../../../common/chat-types.js';
import type { JsonObject } from '../../../common/json.js';
import { sanitizeRecordedCarriedContext } from '../../../common/transcript-seed.js';
import { toAgentChatReference } from '../agents/integration-chat-reference.js';
import type { AgentChatEntry } from '../agents/session-types.js';
import { DomainError } from '../../common/domain-error.js';
import type { LedgerRow, LedgerRowDraft } from './contracts.js';
import { importedDrafts, type ImportedRow } from './imported-drafts.js';
import {
  sanitizeRecordedPreamblePrefixes,
  type PreambleHistoryEvidence,
  type SanitizedPreambleMessage,
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
  readonly onRowsRead?: (rows: number) => void;
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
  onRowsRead,
}: NativeHistorySeedInput): Promise<LedgerRowDraft[]> {
  const messages: ChatMessage[] = [];
  const providerMetas: (JsonObject | null)[] = [];
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
  const steps = new EventLoopSteps('native-history-import');
  for await (const batch of nativeHistoryImport.load({ chat, signal })) {
    signal.throwIfAborted();
    for (const row of batch) {
      messages.push(row.message);
      providerMetas.push(row.providerMeta ?? null);
    }
    onRowsRead?.(messages.length);
    await steps.next();
  }
  const sanitized = sanitizeRecordedCarriedContext({
    messages,
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
  return importedDrafts(importedRows(preambles.messages, providerMetas), now, steps);
}

// Sanitizing rewrites a seed prompt in place and never changes the count, so each message
// keeps the provider identity it arrived with. Rows are produced lazily so the stepped
// conversion, not an extra whole-history pass, pays for them.
function* importedRows(
  messages: readonly SanitizedPreambleMessage[],
  providerMetas: readonly (JsonObject | null)[],
): Generator<ImportedRow> {
  for (const [index, { message, application }] of messages.entries()) {
    yield {
      message,
      providerMeta: providerMetas[index]!,
      ...(application ? { preambleApplication: application } : {}),
    };
  }
}
