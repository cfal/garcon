import type { AgentProducedRow } from '@garcon/server-agent-interface';
import { AssistantMessage, parseChatMessage } from '../../../common/chat-types.ts';
import { decodeLedgerRow, encodeLedgerDraft } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import {
  canonicalizeGarconProducerRows, dispatchGarconCommands,
  type AgentCommandSource,
} from '../../../server/controller/ledger/garcon-command-publication.ts';
import { ledgerRowsToTranscriptMessages } from '../../../server/controller/ledger/presentation.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

function publication(rows: readonly AgentProducedRow[]) {
  return canonicalizeGarconProducerRows(rows.map(row => {
    const message = parseChatMessage(row.message);
    if (!message) throw new TypeError('Invalid fixture message');
    return { ...row, message };
  }));
}

export function canonicalizeRowsFixture(rows: readonly AgentProducedRow[]) {
  const result = publication(rows);
  return {
    drafts: result.drafts.map(draft => ({ kind: draft.kind, at: draft.at, ...encodeLedgerDraft(draft) })),
    commands: result.commands,
    rejections: result.rejections,
  };
}

export function dispatchRowsFixture(rows: readonly AgentProducedRow[], omitEvidence: boolean) {
  const result = publication(rows);
  const view = transcriptViewId('producer-fixture');
  const committedRows = omitEvidence ? [] : result.drafts.map((draft, index) => {
    const encoded = encodeLedgerDraft(draft);
    return decodeLedgerRow({
      view_id: view, ordinal: 11 + index, kind: draft.kind, at: draft.at,
      client_message_id: encoded.clientMessageId, payload_json: encoded.payloadJson,
    });
  });
  const events: unknown[] = [];
  const request = (source: AgentCommandSource, command: unknown) => { events.push({ type: 'request', source, command }); };
  dispatchGarconCommands(result, {
    chatId: 'synthetic-chat', viewId: view, runId: 'synthetic-run', committedRows,
    chatIdRequests: { request: (input) => { events.push({ type: 'chat-id', ...input }); } },
    interAgentMessages: { request: (input) => { events.push({ type: 'inter-agent', ...input }); } },
    agentStarts: { request }, agentResumes: { request }, agentStops: { request },
    agentSchedules: { request }, ticketCommands: { request },
    commandRejections: { reject: (source, issues) => { events.push({ type: 'rejected', ...source, issues }); } },
  });
  return events;
}

if (import.meta.main) {
  if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);
  const [mode, root] = Bun.argv.slice(2) as [string, string];
  const chatId = 'producer';
  const at = '2026-11-28T09:00:00.000Z';
  const viewId = transcriptViewId('publication-view');
  const store = new TranscriptLedgerStore(root, { now: () => at });
  try {
    if (mode === 'write') {
      store.initializeCurrentView(chatId, { viewId, contentStartOrdinal: 1, rows: [] });
      const publication = canonicalizeGarconProducerRows([
        { message: new AssistantMessage(at, '<garcon-get-chat-id />\n\nSynthetic answer.\n<garcon-ticket-read ticket-id="G-1" />'),
          providerMeta: { source: 'synthetic' } },
        { message: new AssistantMessage(at, '<garcon-ticket-read />') },
      ]);
      store.append(chatId, viewId, publication.drafts);
      const batch = Array.from({ length: 2_000 }, () => ({
        message: new AssistantMessage(at, '<garcon-get-chat-id />\nSynthetic answer.'),
      }));
      const start = performance.now();
      const wide = canonicalizeGarconProducerRows(batch);
      const elapsed = performance.now() - start;
      if (wide.drafts.length !== 4_000) throw new Error('Unexpected timing fixture output');
      console.error(`Bun command canonicalization (2,000 rows): ${elapsed.toFixed(2)} ms`);
    } else if (mode !== 'read') {
      throw new Error(`Unknown fixture mode: ${mode}`);
    }
    const head = store.highWatermark(chatId);
    const stored = await store.withStoredRowsThrough(chatId, head, async rows => rows);
    const visible = ledgerRowsToTranscriptMessages(store.currentRows(chatId));
    console.log(JSON.stringify({ stored, visible }));
  } finally {
    store.close();
  }
}
