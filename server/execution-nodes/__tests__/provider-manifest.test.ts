import { expect, test } from 'bun:test';
import type { AgentSettingDescriptor } from '../../../common/agent-integration.js';
import { loadDefaultAgentIntegrations } from '../../agents/default-agent-integrations.js';
import { IntegrationHostFactory } from '../../agents/integration-host.js';
import { IntegrationRegistry } from '../../agents/integration-registry.js';
import {
  createNodeProviderManifest, MAX_NODE_PROVIDER_MANIFEST_BYTES,
  parseNodeProviderManifest,
} from '../provider-manifest.js';
import { PROVIDER_FACETS, type ProviderFacet } from '../provider-metadata.js';

function manifest() {
  return { nodeId: 'synthetic-node', instanceId: 'synthetic-instance', apiVersion: 5, maxOperations: 2,
    descriptor: { id: 'synthetic', label: 'Synthetic', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [{ key: 'SYNTHETIC_KEY', source: 'environment', description: 'Synthetic configuration' }] },
    settings: [{ key: 'choice', label: 'Choice', type: 'enum', options: [{ value: '', label: 'Default' }] }] satisfies AgentSettingDescriptor[],
    defaultSettings: { ownerId: 'synthetic', schemaVersion: 1, values: { choice: '' } },
    fileAttachmentMimeTypes: [], authCapabilities: { launchLogin: false, completeLogin: false },
    facets: Object.fromEntries(PROVIDER_FACETS.map((key) => [key, null])),
  };
}

test('provider manifests contain frozen metadata without executable facets or configured settings', () => {
  const input = manifest();
  const parsed = parseNodeProviderManifest(input);
  expect<unknown>(parsed).toEqual(input);
  input.descriptor.label = 'Changed';
  input.descriptor.configuration[0]!.description = 'Changed';
  input.settings[0]!.options[0]!.label = 'Changed';
  input.defaultSettings.values.choice = 'Changed';
  expect(parsed?.descriptor.label).toBe('Synthetic');
  expect(parsed?.descriptor.configuration[0]?.description).toBe('Synthetic configuration');
  expect(parsed?.settings[0]).toMatchObject({ options: [{ value: '', label: 'Default' }] });
  expect(Object.isFrozen(parsed?.facets)).toBe(true);
  expect(Object.isFrozen(parsed?.descriptor.configuration[0])).toBe(true);
  expect(Object.isFrozen(parsed?.settings[0])).toBe(true);
  expect(parsed?.defaultSettings.values.choice).toBe('');
  expect(Object.isFrozen(parsed?.defaultSettings.values)).toBe(true);
});

test('every shipped integration advertises only provider facets implemented by the selected transport', async () => {
  const classes = await loadDefaultAgentIntegrations();
  const registry = new IntegrationRegistry({ integrations: classes,
    hostFactory: new IntegrationHostFactory({ workspaceDir: '/synthetic/unused', readEnvironment: () => undefined,
      loggerFactory: () => ({ debug() {}, info() {}, warn() {}, error() {} }) }),
    migrationStoreFor: () => ({ getVersion: async () => 0, read: async () => undefined, commit: async () => {} }),
  });
  const implemented = new Set<ProviderFacet>(['execution', 'catalog', 'steering', 'goals', 'textGeneration']);
  for (const integration of registry.list()) {
    const parsed = createNodeProviderManifest('synthetic-node', 'synthetic-instance', integration, implemented, 2);
    expect(parsed.descriptor).toEqual(integration.projectPathUpdates
      ? { ...integration.descriptor, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false }
      : integration.descriptor);
    expect(parsed.settings).toEqual(integration.settings.describe());
    expect(parsed.defaultSettings).toEqual(integration.settings.defaults());
    expect(parsed.authCapabilities).toEqual({ launchLogin: false, completeLogin: false });
    expect(parsed.fileAttachmentMimeTypes).toEqual([]);
    for (const facet of PROVIDER_FACETS) {
      expect(parsed.facets[facet]).toBe(implemented.has(facet) && integration[facet] !== null ? true : null);
    }
    expect(Object.values(createNodeProviderManifest('synthetic-node', 'synthetic-instance', integration, new Set(), 2).facets))
      .toEqual(PROVIDER_FACETS.map(() => null));
    const complete = createNodeProviderManifest('synthetic-node', 'synthetic-instance', integration, new Set(PROVIDER_FACETS), 2);
    expect(complete.descriptor).toEqual(integration.descriptor);
    expect(complete.fileAttachmentMimeTypes).toEqual(integration.attachments?.fileMimeTypes ?? []);
    expect(complete.authCapabilities).toEqual({
      launchLogin: Boolean(integration.auth?.launchLogin), completeLogin: Boolean(integration.auth?.completeLogin),
    });
  }
});

test('manifests reject unknown, missing and executable claims before registry admission', () => {
  const input = manifest();
  const { goals: _, ...missing } = input.facets;
  for (const edit of [{ apiVersion: 4 }, { nodeId: '../escape' }, { instanceId: '' }, { maxOperations: 257 },
    { credential: 'synthetic-private-value' }, { facets: missing }, { facets: { ...input.facets, invented: true } },
    { facets: { ...input.facets, execution: false } }, { facets: { ...input.facets, execution: {} } },
    { settings: [{ key: 'secret', label: 'Secret', type: 'string', value: 'synthetic-private-value' }] },
  ]) expect(parseNodeProviderManifest({ ...input, ...edit })).toBeNull();
  expect(parseNodeProviderManifest({ ...input, toJSON() { return input; } })).toBeNull();
});

test('descriptor identities, enums and declared configuration remain exact and bounded', () => {
  const input = manifest();
  for (const edit of [{ id: 'invalid/provider' }, { icon: 'x'.repeat(4097) }, { label: '' },
    { supportedThinkingModes: ['none', 'none'] }, { supportedThinkingModes: ['invented'] },
    { supportedPermissionModes: ['invalid'] }, { supportedEndpointProtocols: ['invented'] },
    { requiresNativePathForProjectPathUpdate: true }, { configuration: [...input.descriptor.configuration, ...input.descriptor.configuration] },
    { configuration: [{ key: 'BAD=KEY', source: 'environment', description: 'Synthetic' }] },
  ]) expect(parseNodeProviderManifest({ ...input, descriptor: { ...input.descriptor, ...edit } })).toBeNull();
});

test('setting descriptors reject duplicate values, impossible bounds and private defaults', () => {
  const input = manifest();
  for (const settings of [
    [...input.settings, ...input.settings], [{ key: 'key', label: 'Label', type: 'enum', options: [] }],
    [{ key: 'key', label: 'Label', type: 'number', min: 2, max: 1, step: 1 }],
    [{ key: 'key', label: 'Label', type: 'number', min: 0, max: 1, step: 0 }],
    [{ key: 'key', label: 'Label', type: 'number', min: 0, max: Infinity, step: 1 }],
    [{ key: 'key', label: 'Label', type: 'credential-ref' }],
    [{ key: 'key', label: 'Label', type: 'boolean', labelKey: 'invented' }],
    [{ ...input.settings[0], options: [{ value: 'a', label: 'A' }, { value: 'a', label: 'B' }] }],
    [{ ...input.settings[0], options: [{ value: 'a', label: 'A', descriptionKey: 'invented' }] }],
  ]) expect(parseNodeProviderManifest({ ...input, settings })).toBeNull();
});

test('manifest byte bound applies to the aggregate of individually valid fields', () => {
  const input = manifest();
  const configuration = Array.from({ length: 128 }, (_, i) => ({ key: `SYNTHETIC_${i}`, source: 'environment', description: 'x'.repeat(4096) }));
  const oversized = { ...input, descriptor: { ...input.descriptor, configuration } };
  expect(Buffer.byteLength(JSON.stringify(oversized))).toBeGreaterThan(MAX_NODE_PROVIDER_MANIFEST_BYTES);
  expect(parseNodeProviderManifest(oversized)).toBeNull();
});

test('manifest defaults carry only an exact owner-qualified envelope and remain deeply immutable', () => {
  const input = manifest();
  for (const defaultSettings of [null, {}, { ...input.defaultSettings, ownerId: 'foreign' },
    { ...input.defaultSettings, schemaVersion: 0 }, { ...input.defaultSettings, schemaVersion: 1.5 },
    { ...input.defaultSettings, configured: true }, { ...input.defaultSettings, values: [] },
    { ...input.defaultSettings, values: { value: () => 'executable' } },
  ]) expect(parseNodeProviderManifest({ ...input, defaultSettings })).toBeNull();
  const values = { nested: { list: ['synthetic'] } };
  const parsed = parseNodeProviderManifest({ ...input, defaultSettings: { ...input.defaultSettings, values } });
  values.nested.list[0] = 'changed';
  expect(parsed?.defaultSettings.values).toEqual({ nested: { list: ['synthetic'] } });
  const nested = parsed?.defaultSettings.values.nested;
  if (nested === null || typeof nested !== 'object' || Array.isArray(nested)) throw new Error('Missing parsed nested defaults');
  expect(Object.isFrozen(nested)).toBe(true);
  expect(Object.isFrozen(Reflect.get(nested, 'list'))).toBe(true);
});

test('auth and attachment claims cannot exceed their implemented transport facets', () => {
  const input = manifest();
  expect(parseNodeProviderManifest({ ...input, authCapabilities: { launchLogin: true, completeLogin: false } })).toBeNull();
  expect(parseNodeProviderManifest({ ...input, fileAttachmentMimeTypes: ['text/plain'] })).toBeNull();
  const supported = { ...input, facets: { ...input.facets, auth: true, attachments: true } };
  const parsed = parseNodeProviderManifest({ ...supported, authCapabilities: { launchLogin: false, completeLogin: true },
    fileAttachmentMimeTypes: ['text/plain', 'application/pdf'] });
  expect(parsed?.authCapabilities).toEqual({ launchLogin: false, completeLogin: true });
  expect(parsed?.fileAttachmentMimeTypes).toEqual(['text/plain', 'application/pdf']);
  expect(Object.isFrozen(parsed?.authCapabilities)).toBe(true);
  expect(Object.isFrozen(parsed?.fileAttachmentMimeTypes)).toBe(true);
  for (const authCapabilities of [{ launchLogin: true }, { launchLogin: 'true', completeLogin: false },
    { launchLogin: false, completeLogin: true, credential: 'synthetic' }, null]) {
    expect(parseNodeProviderManifest({ ...supported, authCapabilities })).toBeNull();
  }
  for (const fileAttachmentMimeTypes of [['text/plain', 'text/plain'], ['TEXT/PLAIN'], [''], ['text/plain\n'],
    ['*/*'], [7], Array.from({ length: 129 }, (_, index) => `text/synthetic-${index}`)]) {
    expect(parseNodeProviderManifest({ ...supported, fileAttachmentMimeTypes })).toBeNull();
  }
});
