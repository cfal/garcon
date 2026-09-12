import type { ProviderCatalogRequest, ProviderCatalogService } from '../execution-nodes/provider-catalog.js';
import { captureNodeCatalogModels, captureNodeCatalogSnapshot, parseNodeProviderCatalogReply } from '../execution-nodes/transport/provider-catalog-wire.js';
import type { NodeProviderCapacity } from './provider-capacity.js';
import type { NodeWorkerServiceResult } from './worker/service-protocol.js';

/** Retains discovery capacity across physical connections until each native read settles. */
export class NodeProviderCatalogHost {
  constructor(private readonly capacity: NodeProviderCapacity, private readonly instanceId: string, private readonly catalog: ProviderCatalogService) {}

  async snapshot(request: ProviderCatalogRequest, signal: AbortSignal): Promise<NodeWorkerServiceResult> {
    signal.throwIfAborted();
    const release = this.capacity.reserve('work');
    if (!release) return { kind: 'rejected', code: 'NODE_CAPACITY' };
    try {
      let snapshot;
      try { snapshot = await this.catalog.snapshot({ strict: request.strict }, signal); }
      catch (error) {
        signal.throwIfAborted();
        // Stale fallback metadata must be an own data property; accessors are never evaluated.
        const staleModels = error instanceof Error ? captureNodeCatalogModels(Object.getOwnPropertyDescriptor(error, 'staleModels')?.value) : null;
        return parseNodeProviderCatalogReply({ kind: 'provider-catalog-unavailable', instanceId: this.instanceId, staleModels: staleModels ?? [] })
          ?? { kind: 'rejected', code: 'VALIDATION_FAILED' };
      }
      signal.throwIfAborted();
      return parseNodeProviderCatalogReply({ kind: 'provider-catalog', instanceId: this.instanceId, snapshot: captureNodeCatalogSnapshot(snapshot) })
        ?? { kind: 'rejected', code: 'VALIDATION_FAILED' };
    } finally { release(); }
  }
}
