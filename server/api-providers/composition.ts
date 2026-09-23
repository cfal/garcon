import type { ExecutionNodeManager } from '../execution-nodes/manager.js';
import type { WorkspaceMigrationRunner } from '../migrations/index.js';
import type { ServerEventWiring } from '../server-event-wiring.js';
import type { ModelCatalogResponseCache } from '../routes/model-catalog-cache.js';
import { ApiProviderAssignmentStore } from './assignments.js';
import { ApiProviderAccess } from './access.js';
import type { ApiProviderStore } from './store.js';
import { ApiProviderService } from './service.js';

export function createApiProviderPolicy(store: ApiProviderStore, nodes: ExecutionNodeManager, workspaceDir: string) {
  const assignments = new ApiProviderAssignmentStore(workspaceDir, nodes.retainReferences);
  const access = new ApiProviderAccess(store, assignments, (id) => id === 'local' || nodes.config.get(id) !== null);
  return {
    access,
    assignments,
    service(references: () => readonly { referencesApiProvider(id: string): boolean }[]): ApiProviderService {
      return new ApiProviderService({
        store,
        access,
        discoverModels: (nodeId, request) => nodes.requireNode(nodeId).discoverApiProviderModels(request),
        isApiProviderReferenced: (id) => references().some((owner) => owner.referencesApiProvider(id)),
      });
    },
    async initialize(migrations: WorkspaceMigrationRunner): Promise<void> {
      const nodeIds = nodes.config.list().map((node) => node.id);
      await migrations.run('provider-assignments', () =>
        assignments.migrate(['local', ...nodeIds], store.legacyProviderIds));
      if (migrations.isFresh) await assignments.migrate([], []);
      await assignments.initialize();
      await assignments.prune(nodeIds);
    },
    observe(cache: ModelCatalogResponseCache, events: () => ServerEventWiring | null): () => void {
      const invalidate = () => {
        cache.clear();
        events()?.broadcastApiProvidersInvalidated();
      };
      const offProfiles = store.onChanged(invalidate);
      const offAssignments = assignments.onChanged(invalidate);
      const stop = store.observe();
      return () => {
        stop();
        offProfiles();
        offAssignments();
      };
    },
  };
}
