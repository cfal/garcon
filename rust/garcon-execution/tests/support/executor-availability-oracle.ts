import type { ExecutorSnapshot } from '../../../../common/executors.ts';
import type { ChatRegistryEntry } from '../../../../server/controller/chats/registry-contracts.ts';
import { emptyStoredChatExecutionControl } from '../../../../server/controller/chat-execution/control-state.ts';
import { wireExecutorAvailability } from '../../../../server/controller/executors/availability-wiring.ts';

const id = '11111111-1111-4111-8111-111111111111';
const local: ExecutorSnapshot = {
  id: 'local', label: 'Local', kind: 'local', enabled: true, direction: null,
  allowControllerCli: true, allowExecutorManagement: true, availability: 'ready',
  projectBasePath: '/synthetic', instanceId: 'synthetic-instance', bulk: null, lastError: null,
  executorServices: { files: true, git: true, gh: true, terminals: true, directoryCreation: false },
};

export async function executorAvailabilityTrace(scenario: string) {
  const effects: string[][] = [];
  let observe: Parameters<Parameters<typeof wireExecutorAvailability>[0]['executors']['onAvailabilityChanged']>[0] | undefined;
  const chat = (executorId: string): ChatRegistryEntry => ({
    executorId, agentId: 'test', nativeSession: null, agentOwnershipEpoch: 'synthetic', agentSettingsById: {},
    projectPath: '/synthetic', tags: [], agentSessionId: null, model: 'test', permissionMode: 'default', thinkingMode: 'none',
    carryOverSegments: [], nativeSeedReceipt: null, carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
  });
  const chats = new Map([['target', chat(id)], ['different', chat('local')]]);
  const control = emptyStoredChatExecutionControl('synthetic');
  if (scenario !== 'empty') control.entries.push({
    id: 'queue-1', content: 'synthetic', kind: 'turn', images: [], revision: 1,
    status: 'queued', createdAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z',
  });
  const tick = () => new Promise<void>(resolve => setImmediate(resolve));
  const stop = wireExecutorAvailability({
    executors: { list: () => [local], onAvailabilityChanged(listener) {
      observe = listener; return () => { observe = undefined; };
    } },
    agentRegistry: {
      executionSessionLost: executor => { effects.push(['lost', executor ?? '']); },
      executionSessionResumed: executor => { effects.push(['resumed', executor]); },
    },
    chatRegistry: { listChatIds: () => [...chats.keys()], getChat: id => chats.get(id) ?? null },
    ownershipJournal: { async retryProviderCleanup(executor) { effects.push(['cleanup', executor]); } },
    queue: {
      async readChatExecutionControl(chatId) {
        effects.push(['read', chatId]);
        await Promise.resolve();
        if (scenario === 'retarget') chats.set(chatId, chat('local'));
        if (scenario === 'deleted') chats.delete(chatId);
        return control;
      },
      retryQueuedSteers: chatId => { effects.push(['steer', chatId]); },
      async triggerDrain(chatId) { effects.push(['drain', chatId]); },
    },
    publishProcessing: executor => { effects.push(['processing', executor]); },
  });
  observe?.(id, 'reconnecting');
  observe?.(id, 'ready');
  await tick();
  observe?.(id, 'offline');
  stop();
  observe?.(id, 'ready');
  await tick();
  return effects;
}
