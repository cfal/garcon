import type { AgentCredentialReference } from '../../../common/agent-execution.js';
import { AgentCallError, type AgentIntegrationErrorCode } from '@garcon/server-agent-interface';
import { isApiProviderId } from '../../../common/api-providers.js';
import { isExecutorId } from '../../../common/executors.js';
import { isRecord } from '../../../common/json.js';
import { DomainError } from '../../common/domain-error.js';
import type { ApiProviderAssignmentStore } from './assignments.js';
import type { ApiProviderStore } from './store.js';

export class ApiProviderAccess {
  constructor(
    readonly store: ApiProviderStore,
    readonly assignments: ApiProviderAssignmentStore,
    private readonly executorExists: (executorId: string) => boolean,
  ) {}

  list(executorId: string) {
    this.assertExecutor(executorId);
    return this.store.list().filter((profile) => this.assignments.allows(executorId, profile.id));
  }

  assertExecutor(executorId: string): void {
    if (!isExecutorId(executorId) || !this.executorExists(executorId)) {
      throw new DomainError('EXECUTOR_NOT_FOUND', 'Executor not found', 404);
    }
  }

  require(executorId: string, providerId: string, endpointId?: string, revision?: number) {
    this.assertExecutor(executorId);
    const profile = this.store.getApiProvider(providerId);
    if (!profile || !this.assignments.allows(executorId, providerId)) {
      throw new DomainError('API_PROVIDER_UNAVAILABLE', 'This provider is unavailable on the selected executor.', 409);
    }
    if (revision !== undefined && profile.revision !== revision) {
      throw new DomainError('API_PROVIDER_CONFIGURATION_CHANGED', 'Provider configuration changed. Refresh and try again.', 409);
    }
    const endpoint = endpointId
      ? profile.endpoints.find((entry) => entry.id === endpointId)
      : profile.endpoints[0];
    if (!endpoint) {
      throw new DomainError('API_PROVIDER_UNAVAILABLE', 'The endpoint does not belong to this provider.', 409);
    }
    return { apiProvider: profile, endpoint };
  }

  resolveCredential(executorId: string, reference: AgentCredentialReference) {
    try {
      if (!isRecord(reference) || reference.kind !== 'api-provider-endpoint'
        || !isApiProviderId(reference.apiProviderId) || !isApiProviderId(reference.endpointId)
        || !Number.isSafeInteger(reference.revision) || reference.revision < 1) {
        throw new DomainError('VALIDATION_FAILED', 'Invalid provider credential reference', 400);
      }
      const { endpoint } = this.require(executorId, reference.apiProviderId, reference.endpointId, reference.revision);
      return { kind: 'api-key', value: endpoint.apiKey };
    } catch (error) {
      if (!(error instanceof DomainError)) throw error;
      let code: AgentIntegrationErrorCode = 'API_PROVIDER_UNAVAILABLE';
      if (error.code === 'API_PROVIDER_CONFIGURATION_CHANGED' || error.code === 'API_PROVIDER_STORAGE_UNAVAILABLE') {
        code = error.code;
      } else if (error.code === 'VALIDATION_FAILED') {
        code = 'INVALID_ENDPOINT';
      }
      throw new AgentCallError('rejected', error.message, code);
    }
  }

  async assign(executorId: string, providerId: string): Promise<void> {
    await this.store.withLock(async () => {
      this.assertExecutor(executorId);
      if (!isApiProviderId(providerId) || !this.store.getApiProvider(providerId)) {
        throw new DomainError('API_PROVIDER_UNAVAILABLE', 'Provider not found', 404);
      }
      await this.assignments.assign(executorId, providerId);
    });
  }

  async unassign(executorId: string, providerId: string): Promise<void> {
    await this.store.withLock(async () => {
      this.assertExecutor(executorId);
      await this.assignments.unassign(executorId, providerId);
    });
  }
}
