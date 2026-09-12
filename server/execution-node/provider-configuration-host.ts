import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { isExecutionIdentity } from '../../common/execution-location.js';
import type { ProviderConfigurationService } from '../execution-nodes/provider-configuration.js';
import { captureNodeProviderConfigurationReply, type NodeProviderConfigurationCommand } from '../execution-nodes/transport/provider-configuration-update-wire.js';
import { DomainError } from '../lib/domain-error.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

export class NodeProviderConfigurationHost {
  constructor(
    private readonly capacity: NodeProviderCapacity,
    private readonly instanceId: string,
    private readonly configuration: Pick<ProviderConfigurationService, 'prepareUpdate'>,
  ) {
    if (!isExecutionIdentity(instanceId)) throw new TypeError('Invalid configuration instance');
  }

  async prepareUpdate(command: NodeProviderConfigurationCommand, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    if (command.instanceId !== this.instanceId) return { kind: 'rejected', code: 'VALIDATION_FAILED' };
    const release = this.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    try {
      const configuration = await this.configuration.prepareUpdate(command.request, signal);
      signal.throwIfAborted();
      return captureNodeProviderConfigurationReply(this.instanceId, configuration)
        ?? { kind: 'rejected', code: 'VALIDATION_FAILED' };
    } catch (error) {
      signal.throwIfAborted();
      if (error instanceof DomainError && error.code === 'VALIDATION_FAILED' && error.status === 422) {
        return { kind: 'provider-configuration-rejected', instanceId: this.instanceId, code: 'VALIDATION_FAILED' };
      }
      if (error instanceof AgentIntegrationError && (error.code === 'INVALID_ENDPOINT' || error.code === 'INVALID_SETTINGS')) {
        return { kind: 'provider-configuration-rejected', instanceId: this.instanceId, code: error.code };
      }
      return { kind: 'unknown' };
    } finally { release(); }
  }
}
