import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from '../../runtime/agents/integration-registry.js';
import { effectiveExecutorId, type AgentExecutionTarget } from '../../../common/executors.js';
import { DomainError } from '../../common/domain-error.js';

export interface ExecutionIntegrationDirectory {
  requireIntegration(target: AgentExecutionTarget): AgentIntegration;
  knownIntegration(target: AgentExecutionTarget): AgentIntegration | null;
  integrationsFor(executorId: string): IntegrationRegistry;
  isReady(executorId: string): boolean;
}

export class AgentDirectory {
  constructor(
    private readonly executors: ExecutionIntegrationDirectory,
  ) {
    if (!executors) throw new Error('AgentDirectory requires an executor directory');
  }

  has(agentId: string, executorId?: string | null): boolean {
    return this.get(agentId, executorId) !== null;
  }

  get(agentId: string, executorId?: string | null): AgentIntegration | null {
    return this.executors.knownIntegration({ agentId, executorId: effectiveExecutorId(executorId) });
  }

  require(agentId: string, executorId?: string | null): AgentIntegration {
    return this.executors.requireIntegration({ agentId, executorId: effectiveExecutorId(executorId) });
  }

  list(executorId?: string | null): readonly AgentIntegration[] {
    return this.executors.integrationsFor(effectiveExecutorId(executorId)).list();
  }

  isReady(executorId?: string | null): boolean {
    return this.executors.isReady(effectiveExecutorId(executorId));
  }

  // Inventory lookups cannot distinguish an unsupported agent from an executor that has
  // not connected since startup, so operations needing the executor check readiness first.
  requireReady(executorId?: string | null): void {
    if (!this.isReady(executorId)) throw executorUnavailable();
  }
}

function executorUnavailable(): DomainError {
  return new DomainError('EXECUTOR_UNAVAILABLE', 'Executor is unavailable', 503, true);
}
