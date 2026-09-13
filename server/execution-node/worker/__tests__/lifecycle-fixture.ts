import { NODE_WIRE_VERSION } from '@garcon/server-agent-interface';
import { parseNodeProviderManifest } from '../../../execution-nodes/provider-manifest.js';
import { PROVIDER_FACETS } from '../../../execution-nodes/provider-metadata.js';
import { DEFAULT_NODE_REPLAY } from '../../replay-cache.js';

export const session = Object.freeze({ controllerBootId: 'synthetic-controller', nodeBootId: 'synthetic-node-boot', logicalSessionId: 'synthetic-session' });

export function configuration() {
  return { role: 'session' as const, nodeId: 'synthetic-node', storageDirectory: '/synthetic/storage',
    workspaces: [{ id: 'synthetic-workspace', projectPath: '/synthetic/project' }], replay: { ...DEFAULT_NODE_REPLAY },
    instances: [{ id: 'synthetic-instance', agentId: 'synthetic', label: 'Synthetic', homeDirectory: '/synthetic/home',
      environment: { SYNTHETIC_KEY: 'synthetic-private-value' }, workspaceIds: ['synthetic-workspace'], maxOperations: 2 }] };
}

export function manifest() {
  const parsed = parseNodeProviderManifest({ nodeId: 'synthetic-node', instanceId: 'synthetic-instance', apiVersion: 5, maxOperations: 2,
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null, supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [] }, settings: [], defaultSettings: { ownerId: 'synthetic', schemaVersion: 1, values: {} },
    fileAttachmentMimeTypes: [], authCapabilities: { launchLogin: false, completeLogin: false }, facets: Object.fromEntries(PROVIDER_FACETS.map((key) => [key, null])) });
  if (!parsed) throw new Error('Invalid synthetic manifest');
  return parsed;
}

export function configureMessage() {
  return { type: 'node-worker-configure', version: NODE_WIRE_VERSION, session, connectionId: 1,
    startupTimeoutMs: 60_000, configuration: configuration() } as const;
}

export const tick = () => new Promise<void>((resolve) => setImmediate(resolve));
