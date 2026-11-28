import type { AgentHistoryImport, AgentIntegration } from '@garcon/server-agent-interface';
import { AgentSwitchMessage, AssistantMessage, UserMessage } from '../../../common/chat-types.ts';
import { ChatRegistry } from '../../../server/controller/chats/store.ts';
import { TranscriptAdoptionService } from '../../../server/controller/ledger/adoption.ts';
import { transcriptViewId } from '../../../server/controller/ledger/contracts.ts';
import { TranscriptLedgerService } from '../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../server/controller/ledger/store.ts';

if (Bun.version !== '1.4.3') throw new Error('Expected Bun 1.4.3, received ' + Bun.version);
const [mode, root] = Bun.argv.slice(2) as [string, string];
const at = '2026-11-28T09:00:00.000Z';
const viewId = transcriptViewId('adoption-view');
const chatId = '1795856400000000';
const registry = new ChatRegistry(root);
const store = new TranscriptLedgerStore(root, { now: () => at, createViewId: () => viewId });
const ledger = new TranscriptLedgerService(store);
const legacyHistoryImport = {
  async *load({ chat }) {
    if (chat.agentSessionId !== 'session-one') throw new Error('Unexpected session binding');
    yield [{ message: new UserMessage(at, 'Imported question'), providerMeta: { event: 1 } }];
    yield [
      { message: new AssistantMessage(at, '<garcon-get-chat-id />\nSynthetic answer.') },
      { message: new UserMessage(at, '<garcon-chat-id>1795856400000000</garcon-chat-id>') },
    ];
  },
} satisfies AgentHistoryImport;
const integration = {
  descriptor: { id: 'synthetic' },
  settings: {
    defaults: () => ({ ownerId: 'synthetic', schemaVersion: 1, values: {} }),
    parse: value => value,
  },
  legacyHistoryImport,
} satisfies {
  descriptor: Pick<AgentIntegration['descriptor'], 'id'>;
  settings: Pick<AgentIntegration['settings'], 'defaults' | 'parse'>;
  legacyHistoryImport: AgentHistoryImport;
};
const adoption = new TranscriptAdoptionService({
  ledger,
  registry,
  integrations: { require: () => {
    if (mode === 'read') throw new Error('Existing view consulted an integration');
    return integration as AgentIntegration;
  } },
  getCarryOverRevision: () => 'synthetic-revision',
  loadFrozenPrefix: async () => [
    new UserMessage(at, 'Frozen question', undefined, { upstreamRequestId: 'frozen-input' }),
    new AgentSwitchMessage(at, 'previous', 'synthetic', 'modelA', 'modelB'),
  ],
  now: () => at,
});

try {
  await registry.init();
  registry.addChat({
    id: chatId, agentId: 'synthetic', model: 'modelB', projectPath: root,
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
  });
  registry.updateChat(chatId, { agentSessionId: mode === 'read' ? 'old-cache' : 'session-one' });
  const view = await adoption.ensure(chatId);
  const head = store.highWatermark(chatId);
  const stored = await store.withStoredRowsThrough(chatId, head, async rows => rows);
  console.log(JSON.stringify({ view, stored, session: registry.getChat(chatId)?.agentSessionId }));
} finally {
  ledger.close();
  await registry.flush();
}
