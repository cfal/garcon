import type { AgentIntegration } from '@garcon/server-agent-interface';
import { EXECUTION_INITIALIZATION_V1, EXECUTION_WORKFLOW_V1, supportsProviderInitialization, type ExecutorOperation } from '@garcon/common/executor-contracts';
import type { AgentDirectory } from './directory.js';
import { DomainError } from '../../common/domain-error.js';

export interface ExecutionSupportTarget {
  readonly agentId: string;
  readonly executorId?: string | null;
  readonly apiProviderId?: string | null;
  readonly modelEndpointId?: string | null;
}

export function executionRequirements(integration: AgentIntegration, target: ExecutionSupportTarget,
  operations: readonly ExecutorOperation[]): readonly ExecutorOperation[] {
  return [
    ...EXECUTION_WORKFLOW_V1.map(definition => definition.name), ...operations,
    ...(integration.configurationValidation ? ['configurationValidation.validate'] as const : []),
    ...(target.apiProviderId || target.modelEndpointId ? ['credentials.resolve', 'endpoints.validate'] as const : []),
  ];
}

export function nativeForkRequirements(integration: AgentIntegration,
  source: ExecutionSupportTarget & { readonly agentSessionId?: string | null }): readonly ExecutorOperation[] {
  if (!integration.forking || !source.agentSessionId) return [];
  return [...EXECUTION_INITIALIZATION_V1.map(definition => definition.name), 'forking.fork',
    ...(integration.nativeHistoryImport ? ['history.open'] as const : []),
    ...(source.apiProviderId || source.modelEndpointId ? ['credentials.resolve', 'endpoints.validate'] as const : [])];
}

export function supportsProviderOperations(directory: Pick<AgentDirectory, 'supportsOperations'>,
  executorId: string | null | undefined, operations: readonly ExecutorOperation[]): boolean {
  return supportsProviderInitialization(requirements => directory.supportsOperations(executorId,
    requirements.map(definition => definition.name as ExecutorOperation)))
    && directory.supportsOperations(executorId, operations);
}

export function requireProviderOperations(directory: Pick<AgentDirectory, 'requireOperations' | 'supportsOperations'>,
  executorId: string | null | undefined, operations: readonly ExecutorOperation[]): void {
  directory.requireOperations(executorId, operations);
  if (!supportsProviderOperations(directory, executorId, operations)) {
    throw new DomainError('OPERATION_UNSUPPORTED', 'Executor does not support provider initialization for this operation', 422);
  }
}
