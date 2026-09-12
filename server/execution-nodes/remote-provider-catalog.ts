import type { AgentModelOption } from '../../common/agents.js';
import { isExecutionIdentity } from '../../common/execution-location.js';
import type { NodeWorkerServiceClient } from '../execution-node/worker/service-channel.js';
import type { NodeWorkerServiceResult } from '../execution-node/worker/service-protocol.js';
import { DomainError } from '../lib/domain-error.js';
import type { ProviderCatalogRequest, ProviderCatalogService } from './provider-catalog.js';
import { parseNodeProviderCatalogReply } from './transport/provider-catalog-wire.js';

export class NodeProviderCatalogUnavailableError extends DomainError {
  constructor(readonly staleModels: readonly AgentModelOption[] = [], readonly nodeCode: Extract<NodeWorkerServiceResult, { kind: 'rejected' }>['code'] = 'NODE_UNAVAILABLE') {
    const retryable = nodeCode === 'NODE_UNAVAILABLE' || nodeCode === 'NODE_CAPACITY';
    super(retryable ? nodeCode : 'NODE_INCOMPATIBLE', 'Provider model discovery is unavailable.', retryable ? 503 : 502, retryable);
    this.name = 'NodeProviderCatalogUnavailableError';
  }
}

/** Captures one instance and physical client; reconnection requires a fresh capture by its owner. */
export class RemoteProviderCatalogService implements ProviderCatalogService {
  constructor(private readonly service: Pick<NodeWorkerServiceClient, 'call'>, private readonly instanceId: string) {
    if (!isExecutionIdentity(instanceId)) throw new TypeError('Invalid catalog instance');
  }

  async snapshot(request: ProviderCatalogRequest, signal: AbortSignal) {
    signal.throwIfAborted();
    const reply = await this.service.call({ method: 'provider-catalog', instanceId: this.instanceId, strict: request.strict }, signal);
    signal.throwIfAborted();
    if (reply.kind === 'rejected') throw new NodeProviderCatalogUnavailableError([], reply.code);
    if (reply.kind === 'unknown') throw new NodeProviderCatalogUnavailableError();
    const result = parseNodeProviderCatalogReply(reply);
    if (!result || result.instanceId !== this.instanceId) throw new NodeProviderCatalogUnavailableError([], 'VALIDATION_FAILED');
    if (result.kind === 'provider-catalog-unavailable') throw new NodeProviderCatalogUnavailableError(result.staleModels);
    return result.snapshot;
  }
}
