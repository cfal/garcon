import { mkdir } from 'node:fs/promises';
import { join } from 'node:path';

import { AssistantMessage, BashToolUseMessage, ThinkingMessage } from '../../../../common/chat-types.ts';
import { KeyedPromiseLock } from '../../../../server/common/keyed-lock.ts';
import { AgentRegistry } from '../../../../server/controller/agents/registry.ts';
import { ApiProviderEndpointResolver } from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';
import { TranscriptAdoptionService } from '../../../../server/controller/ledger/adoption.ts';
import { TranscriptLedgerService } from '../../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../../server/controller/ledger/store.ts';

const root = process.argv[2]!;
const chatId = '1783725900000200';
const at = '2026-08-15T00:00:00.000Z';
const next = '2026-08-15T00:01:00.000Z';
const unexpected = (): never => { throw new Error('Preview must not adopt or resolve execution'); };
await mkdir(root, { recursive: true });
const chats = new ChatRegistry(root);
await chats.init();
chats.addChat({
  id: chatId,
  agentId: 'shell',
  model: 'fixture-model',
  projectPath: '/repo',
  agentSettingsById: {},
  preambleSelection: { revision: 0, orderedPreambleIds: [] },
  parentChatId: null,
  lineage: null,
});
const ledger = new TranscriptLedgerService(
  new TranscriptLedgerStore(join(root, 'transcript-ledgers')), { now: () => at },
);
try {
  const getCarryOverRevision = () => 'fixture-carryover';
  const registry = new AgentRegistry({
    registry: chats,
    executors: {
      knownIntegration: unexpected, requireIntegration: unexpected,
      integrationsFor: unexpected, isReady: unexpected,
    },
    endpointResolver: new ApiProviderEndpointResolver(unexpected),
    getCarryOverRevision,
    createCarriedContext: unexpected,
    chatMutationLock: new KeyedPromiseLock(),
    getSettingsExecution: unexpected,
    ledger,
    adoption: new TranscriptAdoptionService({
      ledger, registry: chats, integrations: { require: unexpected },
      getCarryOverRevision, loadFrozenPrefix: unexpected,
    }),
    hasPendingOwnershipTransfer: () => false,
    preambles: { snapshot: unexpected },
    selectionAdmissionLock: new KeyedPromiseLock(),
    resolveFileMentions: unexpected,
  });
  ledger.initializeChat(chatId);
  const lease = ledger.openProducer(chatId, 'preview-fixture');
  console.log(JSON.stringify([
    new AssistantMessage(at, 'Stored conversation'),
    new ThinkingMessage(next, 'Synthetic reasoning'),
    new BashToolUseMessage(next, 'tool', 'pwd'),
  ].map(message => {
    lease.sink.publish({ type: 'rows', rows: [{ message, providerMeta: null }] });
    return registry.getExistingTranscriptPreview(chats.getChat(chatId), chatId);
  })));
} finally {
  ledger.close();
  await chats.flush();
}
