import type { ExecutorManager } from '../executors/manager.js';
import type { WorkspaceMigrationRunner } from '../migrations/index.js';
import type { ServerEventWiring } from '../server-event-wiring.js';
import type { ModelCatalogResponseCache } from '../routes/model-catalog-cache.js';
import { ApiProviderAssignmentStore } from './assignments.js';
import { ApiProviderAccess } from './access.js';
import type { ApiProviderStore } from './store.js';
import { ApiProviderService } from './service.js';

export function createApiProviderPolicy(store: ApiProviderStore, executors: ExecutorManager, workspaceDir: string) {
  const assignments = new ApiProviderAssignmentStore(workspaceDir, executors.retainReferences);
  const access = new ApiProviderAccess(store, assignments, (id) => id === 'local' || executors.config.get(id) !== null);
  return {
    access,
    assignments,
    service(references: () => readonly { referencesApiProvider(id: string): boolean }[]): ApiProviderService {
      return new ApiProviderService({
        store,
        access,
        discoverModels: (executorId, request) => executors.requireExecutor(executorId).discoverApiProviderModels(request),
        isApiProviderReferenced: (id) => references().some((owner) => owner.referencesApiProvider(id)),
      });
    },
    async initialize(migrations: WorkspaceMigrationRunner): Promise<void> {
      const executorIds = executors.config.list().map((executor) => executor.id);
      await migrations.run('provider-assignments', () =>
        assignments.migrate(['local', ...executorIds], store.legacyProviderIds));
      if (migrations.isFresh) await assignments.migrate([], []);
      await assignments.initialize();
      await assignments.prune(executorIds);
    },
    observe(cache: ModelCatalogResponseCache, events: () => ServerEventWiring | null): () => void {
      const invalidate = () => {
        cache.clear();
        events()?.broadcastApiProvidersInvalidated();
      };
      const offProfiles = store.onChanged(invalidate);
      const offAssignments = assignments.onChanged(invalidate);
      return () => {
        offProfiles();
        offAssignments();
      };
    },
  };
}
