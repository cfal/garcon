import { expect, test } from 'bun:test';
import type { IntegrationManifest } from '../transport/rpc-protocol.js';
import { freezeInventory, validateManifest } from '../transport/executor-inventory.js';
import { integrationFixture } from './integration-fixture.js';

const native = integrationFixture();
const manifest = {
  descriptor: native.integration.descriptor,
  scope: native.scope,
  settings: { defaults: native.integration.settings.defaults(), descriptors: native.integration.settings.describe() },
  attachments: null,
  capabilities: {
    readiness: false, auth: false, commands: false, compaction: false, forking: false, steering: false,
    endpoints: false, singleQuery: true, legacyHistoryImport: false, nativeHistoryImport: true,
    nativeActivity: false, nativeSessions: false, configurationValidation: false, sessionConfiguration: false, projectPathUpdates: false, usageHistory: false,
  },
  authMethods: { launchLogin: false, completeLogin: false, loginStatus: false },
  literalExecution: null,
  singleQueryRunsToolsWithoutPermission: false,
} satisfies IntegrationManifest;

test('valid received manifests are frozen without freezing worker-owned metadata', () => {
  const received = JSON.parse(JSON.stringify(manifest));
  validateManifest(received);
  freezeInventory(received);
  expect(Reflect.set(received.descriptor, 'label', 'Changed')).toBe(false);
  expect(Reflect.set(received.settings.defaults, 'schemaVersion', 2)).toBe(false);
  expect(Object.isFrozen(received.descriptor.supportedPermissionModes)).toBe(true);
  expect(Object.isFrozen(manifest.descriptor)).toBe(false);
});

test('accepts null metadata, empty lists and extra fields without projecting them away', () => {
  const received = {
    ...manifest,
    descriptor: { ...manifest.descriptor, icon: null, supportedPermissionModes: [], supportedThinkingModes: [],
      supportedEndpointProtocols: [], configuration: [] },
    settings: { ...manifest.settings, descriptors: [] },
    attachments: null,
    literalExecution: null,
    extra: 'synthetic extension',
  };
  const original = structuredClone(received);
  expect(() => validateManifest(received)).not.toThrow();
  expect(received).toEqual(original);
});

for (const [name, fields] of Object.entries({
  descriptor: { descriptor: null },
  scope: { scope: null },
  settings: { settings: null },
  settingList: { settings: { ...manifest.settings, descriptors: null } },
  owner: { settings: { ...manifest.settings, defaults: { ...manifest.settings.defaults, ownerId: 'different' } } },
  schema: { settings: { ...manifest.settings, defaults: { ...manifest.settings.defaults, schemaVersion: 0 } } },
  facets: { capabilities: { ...manifest.capabilities, nativeSessions: 'yes' } },
  missingFacet: { capabilities: {} },
  auth: { authMethods: {} },
  attachment: { attachments: { fileMimeTypes: [], inlineTextMaxBytes: -1 } },
  mode: { descriptor: { ...manifest.descriptor, supportedPermissionModes: ['future-mode'] } },
  duplicateMode: { descriptor: { ...manifest.descriptor, supportedPermissionModes: ['default', 'default'] } },
  duplicateThinkingMode: { descriptor: { ...manifest.descriptor, supportedThinkingModes: ['none', 'none'] } },
  duplicateSetting: { settings: { ...manifest.settings, descriptors: [
    { key: 'synthetic', label: 'Synthetic', type: 'boolean' },
    { key: 'synthetic', label: 'Synthetic', type: 'boolean' },
  ] } },
  setting: { settings: { ...manifest.settings, descriptors: [{ key: 'unknown', label: 'Unknown', type: 'future-setting' }] } },
  literal: { literalExecution: { selectionLabel: 'Literal', inputFormatByModel: {} } },
  missingCapabilitiesWithLiteral: { capabilities: null, literalExecution: { selectionLabel: 'Literal', inputFormatByModel: {} } },
  missingAttachments: { attachments: undefined },
  missingLiteral: { literalExecution: undefined },
})) {
  test(`invalid ${name} is rejected before constructing a generation`, () => {
    expect(() => validateManifest(JSON.parse(JSON.stringify({ ...manifest, ...fields })))).toThrow('manifest is invalid');
  });
}
