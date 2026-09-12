import { expect, test } from 'bun:test';
import { parseNodeProviderManifest } from '../../../execution-nodes/provider-manifest.js';
import { NodeWorkerReady } from '../ready.js';
import { MAX_NODE_WORKER_LIFECYCLE_BYTES, serializeNodeWorkerChild } from '../protocol.js';
import { manifest, session } from './lifecycle-fixture.js';

test('session readiness bounds the aggregate before accepting another individually valid manifest', () => {
  const ready = new NodeWorkerReady(session);
  let count = 0;
  for (let index = 0; index < 16; index++) {
    const base = manifest();
    const next = parseNodeProviderManifest({ ...base, instanceId: `synthetic-instance-${index}`, descriptor: { ...base.descriptor,
      configuration: Array.from({ length: 60 }, (_, key) => ({ key: `SYNTHETIC_KEY_${key}`, source: 'environment', description: 'x'.repeat(4096) })) } });
    if (!next) throw new Error('Invalid synthetic manifest');
    const message = { type: 'node-worker-ready', version: 1, session, manifests: [...ready.manifests, next] } as const;
    if (Buffer.byteLength(JSON.stringify(message)) > MAX_NODE_WORKER_LIFECYCLE_BYTES) {
      expect(() => ready.add(next)).toThrow('NODE_WORKER_CAPACITY');
      expect(ready.manifests).toHaveLength(count);
      expect(() => serializeNodeWorkerChild({ ...message, manifests: ready.manifests })).not.toThrow();
      expect(count).toBeGreaterThan(1);
      return;
    }
    ready.add(next);
    count++;
  }
  throw new Error('Synthetic manifests did not reach the aggregate bound');
});
