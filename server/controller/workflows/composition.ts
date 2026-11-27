import type { ApiProviderAccess } from '../api-providers/access.js';
import type { RetainProviderReferences } from '../api-providers/reference-writes.js';
import type { ModelCatalog, ModelCatalogResponseCache } from '../agents/model-catalog-cache.js';
import type { AutomationService } from '../automation/service.js';
import type { IChatRegistry } from '../chats/store.js';
import type { ExecutorManager } from '../executors/manager.js';
import type { PreambleService } from '../preambles/service.js';
import type { SettingsStore } from '../settings/store.js';
import { createWorkflowRunner } from './automation-runner.js';
import { initializeWorkflows } from './setup.js';

export function createControllerWorkflows(workspaceDir: string, deps: {
  automation: AutomationService;
  executors: ExecutorManager;
  chats: Pick<IChatRegistry, 'onChatRemoved' | 'hasChat'>;
  modelCatalog: ModelCatalog;
  modelCatalogResponseCache: ModelCatalogResponseCache;
  settings: Pick<SettingsStore, 'getRecentAgentSettings' | 'getExecutionDefaults'>;
  preambles: Pick<PreambleService, 'snapshot'>;
  access: Pick<ApiProviderAccess, 'require'>;
  retainProviderReferences: RetainProviderReferences;
}) {
  const { automation, executors } = deps;
  const runtime = initializeWorkflows(workspaceDir, {
    runner: createWorkflowRunner(automation, id => executors.requireExecutor(id).getFilesService()),
    hasChat: id => deps.chats.hasChat(id),
    retainExecutorReferences: executors.retainReferences,
    retainProviderReferences: deps.retainProviderReferences,
  }, {
    ready: id => executors.isReady(id),
    inspectProject: executors.inspectProject,
    catalog: async id => (await deps.modelCatalogResponseCache.getSnapshot(deps.modelCatalog, id)).body,
    recents: () => deps.settings.getRecentAgentSettings(),
    defaults: () => deps.settings.getExecutionDefaults(),
    preambles: () => deps.preambles.snapshot(),
    providerRoute: (id, provider, endpoint) => {
      const route = deps.access.require(id, provider, endpoint);
      return { revision: route.apiProvider.revision, protocol: route.endpoint.protocol };
    },
  });
  deps.chats.onChatRemoved((id, reason) => {
    if (reason === 'user-deletion') runtime.handleChatRemoved(id);
  });
  const unsubscribe = executors.onAvailabilityChanged((id, availability) => {
    if (availability === 'ready') runtime.wakeExecutor(id);
  });
  return {
    // Keeps the throwing storage accessor lazy until a request actually needs it.
    get service() { return runtime.service; },
    prepareSettings: runtime.prepareSettings,
    referencesApiProvider: runtime.referencesApiProvider,
    referencesExecutor: runtime.referencesExecutor,
    async start() {
      await runtime.start();
      for (const { id } of executors.list()) if (executors.isReady(id)) runtime.wakeExecutor(id);
    },
    stop() {
      unsubscribe();
      runtime.stop();
      automation.beginShutdown();
    },
    close: runtime.close,
  };
}
