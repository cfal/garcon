import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import type { NodeSessionIdentity } from '../../../common/node-operation.js';
import type { NodeProviderManifest } from '../../execution-nodes/provider-manifest.js';
import { NodeWorkerTransportError } from './framing.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, serializeNodeWorkerChild } from './protocol.js';

/** Rejects aggregate manifest overflow before the session launches another instance. */
export class NodeWorkerReady {
  readonly #manifests: NodeProviderManifest[] = [];
  #bytes: number;

  constructor(session: NodeSessionIdentity) {
    this.#bytes = Buffer.byteLength(serializeNodeWorkerChild({ type: 'node-worker-ready', version: NODE_WIRE_VERSION,
      session, manifests: [] }));
  }

  get manifests(): readonly NodeProviderManifest[] { return Object.freeze([...this.#manifests]); }

  add(manifest: NodeProviderManifest): void {
    const bytes = this.#bytes + Buffer.byteLength(JSON.stringify(manifest)) + (this.#manifests.length ? 1 : 0);
    if (bytes > MAX_NODE_WORKER_LIFECYCLE_BYTES) throw new NodeWorkerTransportError('NODE_WORKER_CAPACITY');
    this.#bytes = bytes;
    this.#manifests.push(manifest);
  }
}
