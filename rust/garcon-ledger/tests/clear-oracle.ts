import type { AgentIntegration } from '@garcon/server-agent-interface';
import { KeyedPromiseLock } from '../../../server/common/keyed-lock.ts';
import { emptyStoredChatExecutionControl } from '../../../server/controller/chat-execution/control-state.ts';
import { ChatRegistry } from '../../../server/controller/chats/store.ts';
import { TranscriptClearService } from '../../../server/controller/ledger/clear.ts';
import { decodeLedgerRow } from '../../../server/controller/ledger/codec.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3, received ' + Bun.version);
const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const source = transcriptViewId('11111111-1111-4111-8111-111111111111');
const chatId = '1795856400000000';
const store = new TranscriptLedgerStore(root, { now: () => at });
const ledger = new TranscriptLedgerService(store);
try {
  if (mode === 'all' || mode === 'before') {
    const input = await Bun.file(new URL('./inputs/clear-rows.jsonl', import.meta.url)).text();
    const rows = input.trimEnd().split('\n').map((line, index): LedgerRowDraft => {
      const [kind, value, id] = JSON.parse(line) as [string, unknown, string?];
      const { viewId: _viewId, ordinal: _ordinal, ...draft } = decodeLedgerRow({
        kind, ordinal: index + 1, at, view_id: source, client_message_id: id ?? null,
        payload_json: JSON.stringify({ providerMeta: null, value }),
      });
      return draft;
    });
    const old = store.initializeCurrentView(chatId, { viewId: source, rows, contentStartOrdinal: 1 });
    const registry = new ChatRegistry(root);
    await registry.init();
    registry.addChat({
      id: chatId, agentId: 'shell', model: 'synthetic', projectPath: root, agentOwnershipEpoch: 'owner-1',
      pendingPreambleBoundary: { kind: 'new-chat', ownershipEpoch: 'owner-1' },
      preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
    });
    const integration = {
      literalExecution: { selectionLabel: 'Runtime', inputFormatByModel: {} },
    } satisfies Pick<AgentIntegration, 'literalExecution'>;
    const readQueue = async () => emptyStoredChatExecutionControl('synthetic-server');
    const clear = new TranscriptClearService({
      ledger, registry, ownership: { hasPending: () => false }, chatMutationLock: new KeyedPromiseLock(),
      integrations: { get: () => integration as AgentIntegration },
      adoption: { ensure: async () => old },
      execution: {
        reserveTranscriptSnapshot: () => ({ chatId, reservationId: 'synthetic-reservation' }),
        releaseTranscriptSnapshot: async () => {},
        readChatExecutionControl: readQueue,
        withChatExecutionControl: async (_chatId, promote) => promote(await readQueue()),
      },
      reopenProducer: id => { ledger.openProducer(id, 'shell'); },
    });
    try {
      const result = await clear.clear({
        chatId, transcriptViewId: source, lastOrdinal: rows.length,
        target: mode === 'all' ? { kind: 'all' } : { kind: 'before-message', ordinal: 6 },
      }, new AbortController().signal);
      if (result.transcriptViewId === source) throw new Error('View was not replaced');
      if (registry.getChat(chatId)?.pendingPreambleBoundary !== null) throw new Error('Boundary was not cleared');
    } finally {
      await registry.flush();
    }
  } else if (mode !== 'read') {
    throw new Error('Unexpected mode: ' + mode);
  }
  const view = store.currentView(chatId);
  const rows = await store.withStoredRowsThrough(chatId, store.highWatermark(chatId), async rows => rows);
  console.log(JSON.stringify({ view, rows }));
} finally {
  ledger.close();
}
