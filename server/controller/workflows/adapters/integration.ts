import { GIT_OPERATION_TIMEOUT_MS } from '../../../../common/git-execution.js';
import type { WorkflowIntegrationRepositoryPort } from '../contracts.js';
import { definitelyNotDispatched, inspectWorkflowRepository, type WorkflowRuntimeResolver } from './repository-runtime.js';

export function createWorkflowIntegrationPort(resolve: WorkflowRuntimeResolver): WorkflowIntegrationRepositoryPort {
  return {
    async prepare(manifest, shutdown) {
      const runtime = await resolve(manifest.resource.target.executorId);
      const options = { signal: shutdown, timeoutMs: GIT_OPERATION_TIMEOUT_MS, instanceId: manifest.resource.instanceId };
      const git = await runtime.getGitService(options);
      return { async run() {
        try { return await git.integrateCommits(manifest.request, options); }
        catch (error) {
          if (definitelyNotDispatched(error)) return { kind: 'not-started', reason: 'Integration was rejected before mutation.' };
          throw error;
        }
      } };
    },
    inspect: (resource, inputs, signal) => inspectWorkflowRepository(resolve, resource, signal, inputs),
  };
}
