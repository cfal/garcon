import type { AgentImportedTranscriptRow } from '@garcon/server-agent-interface';
import { parseChatMessage, type ChatMessage } from '../../../common/chat-types.ts';
import { encodeLedgerDraft } from '../../../server/controller/ledger/codec.ts';
import type { LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { frozenDrafts, importedDrafts } from '../../../server/controller/ledger/imported-drafts.ts';
import type { PreambleHistoryEvidence } from '../../../server/controller/ledger/preamble-history.ts';

function parsed(raw: ChatMessage): ChatMessage {
  const message = parseChatMessage(raw);
  if (!message) throw new TypeError('Invalid fixture message');
  return message;
}

function encoded(drafts: readonly LedgerRowDraft[]) {
  return drafts.map(draft => ({ kind: draft.kind, at: draft.at, ...encodeLedgerDraft(draft) }));
}

export async function importedDraftsFixture(
  rows: readonly (AgentImportedTranscriptRow & { readonly preambleApplication?: PreambleHistoryEvidence })[],
  at: string,
) {
  return encoded(await importedDrafts(rows.map(row => ({
    ...row, message: parsed(row.message), providerMeta: row.providerMeta ?? null,
  })), () => at));
}

export function frozenDraftsFixture(messages: readonly ChatMessage[], at: string) {
  return encoded(frozenDrafts(messages.map(parsed), () => at));
}
