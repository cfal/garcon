import type { AgentIntegration } from '@garcon/server-agent-interface';
import type { IntegrationRegistry } from '../../runtime/agents/integration-registry.js';
import { effectiveExecutorId, LOCAL_EXECUTOR_ID, type AgentExecutionTarget } from '../../../common/executors.js';
import { DomainError } from '../../common/domain-error.js';

export interface ExecutionIntegrationDirectory {
  requireIntegration(target: AgentExecutionTarget): AgentIntegration;
  knownIntegration(target: AgentExecutionTarget): AgentIntegration | null;
  integrationsFor(executorId: string): IntegrationRegistry;
  isReady(executorId: string): boolean;
  captureInventory(executorId: string): AgentInventorySnapshot;
}

export interface AgentInventorySnapshot {
  readonly instanceId: string;
  readonly integrations: readonly AgentIntegration[];
  assertCurrent(): void;
}

export class AgentDirectory {
  readonly #emptyLocalInstanceId = crypto.randomUUID();
  constructor(
    private readonly integrations: IntegrationRegistry,
    private readonly executors?: ExecutionIntegrationDirectory,
  ) {}

  has(agentId: string, executorId?: string | null): boolean {
    return this.get(agentId, executorId) !== null;
  }

  get(agentId: string, executorId?: string | null): AgentIntegration | null {
    if (this.executors) return this.executors.knownIntegration({ agentId, executorId: effectiveExecutorId(executorId) });
    return effectiveExecutorId(executorId) === LOCAL_EXECUTOR_ID ? this.integrations.get(agentId) : null;
  }

  require(agentId: string, executorId?: string | null): AgentIntegration {
    if (this.executors) return this.executors.requireIntegration({ agentId, executorId: effectiveExecutorId(executorId) });
    if (effectiveExecutorId(executorId) !== LOCAL_EXECUTOR_ID) throw executorUnavailable();
    return this.integrations.require(agentId);
  }

  list(executorId?: string | null): readonly AgentIntegration[] {
    if (this.executors) return this.executors.integrationsFor(effectiveExecutorId(executorId)).list();
    if (effectiveExecutorId(executorId) !== LOCAL_EXECUTOR_ID) throw executorUnavailable();
    return this.integrations.list();
  }

  captureInventory(executorId?: string | null): AgentInventorySnapshot {
    if (this.executors) return this.executors.captureInventory(effectiveExecutorId(executorId));
    const integrations = this.list(executorId);
    return { integrations, instanceId: integrations[0]?.producers.scope.instanceId ?? this.#emptyLocalInstanceId, assertCurrent() {} };
  }

  isReady(executorId?: string | null): boolean {
    return this.executors?.isReady(effectiveExecutorId(executorId)) ?? effectiveExecutorId(executorId) === LOCAL_EXECUTOR_ID;
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
