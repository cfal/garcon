import { ChatRegistry } from '../../../server/controller/chats/store.ts';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.ts';
import { transcriptViewId, type LedgerRowDraft } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';
import { TranscriptViewReader } from '../../../server/controller/ledger/view-reader.ts';

if (Bun.version !== '1.4.3') throw new Error(`Expected Bun 1.4.3, received ${Bun.version}`);

const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const viewId = transcriptViewId('reader-view');
const chatId = '1795856400000000';
const registry = new ChatRegistry(root);
const store = new TranscriptLedgerStore(root, { now: () => at });
const ledger = new TranscriptLedgerService(store);
const reader = new TranscriptViewReader(ledger, new TranscriptAdoptionService({
  ledger,
  registry,
  integrations: { require: () => { throw new Error('Current views must not consult an integration'); } },
  getCarryOverRevision: () => { throw new Error('Current views must not consult carryover'); },
  loadFrozenPrefix: async () => { throw new Error('Current views must not load a prefix'); },
}));

try {
  await registry.init();
  registry.addChat({
    id: chatId,
    agentId: 'shell',
    model: 'synthetic',
    projectPath: root,
    preambleSelection: { revision: 0, orderedPreambleIds: [] },
    parentChatId: null,
    lineage: null,
  });
  if (mode === 'write') {
    const terminal: LedgerRowDraft = { kind: 'run-ended', at, origin: 'core', outcome: 'finished' };
    const notice = (message: string): LedgerRowDraft => ({ kind: 'notice', at, message, detail: {} });
    store.initializeCurrentView(chatId, { viewId, contentStartOrdinal: 1,
      rows: [notice('First'), ...Array<LedgerRowDraft>(202).fill(terminal), notice('Last')],
    });
  } else if (mode !== 'read') {
    throw new Error(`Invalid oracle mode: ${mode}`);
  }
  const newest = await reader.page(chatId, 1, 999, viewId);
  const hidden = await reader.page(chatId, 1, newest.nextBeforeOrdinal!, viewId);
  const empty = await reader.page(chatId, 1, 1, viewId);
  const replay = await reader.replay(chatId, viewId, 1);
  const continued = await reader.replay(chatId, viewId, replay.nextAfterOrdinal, replay.throughOrdinal);
  const anchor = await reader.anchorPage({ chatId, direction: 'backward', anchorsRemaining: 1 });
  const snapshot = await reader.withStoredSnapshot(chatId, async (snapshot) => snapshot);
  console.log(JSON.stringify({ newest, hidden, empty, replay, continued, anchor, snapshot }));
} finally {
  reader.close();
  ledger.close();
  await registry.flush();
}
