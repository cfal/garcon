import { KeyedPromiseLock } from '../../common/keyed-lock.js';
import { DomainError } from '../../common/domain-error.js';
import type { ChatExecutionCoordinatorOptions } from '../chat-execution/types.js';
import type { ExecutionIntegrationDirectory } from '../agents/directory.js';
import type { IntegrationRegistry } from '../../runtime/agents/integration-registry.js';

export function controllerSafetyDependencies() {
  return {
    selectionAdmissionLock: new KeyedPromiseLock(),
    chatMutationLock: new KeyedPromiseLock(),
    canDispatch: () => true,
    isExecutorConfigured: () => true,
  } satisfies Pick<ChatExecutionCoordinatorOptions, 'canDispatch'> & {
    selectionAdmissionLock: KeyedPromiseLock;
    chatMutationLock: KeyedPromiseLock;
    isExecutorConfigured(executorId: string): boolean;
  };
}

export function localIntegrationDirectory(integrations: IntegrationRegistry): ExecutionIntegrationDirectory {
  const requireLocal = (id: string) => { if (id !== 'local') throw new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true); };
  return {
    knownIntegration: ({ agentId, executorId }) => executorId === 'local' ? integrations.get(agentId) : null,
    requireIntegration: ({ agentId, executorId }) => { requireLocal(executorId); return integrations.require(agentId); },
    integrationsFor: id => { requireLocal(id); return integrations; },
    isReady: id => id === 'local',
  };
}
