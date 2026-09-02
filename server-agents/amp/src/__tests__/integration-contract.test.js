import { describe, expect, it } from 'bun:test';
import AmpAgentIntegration from '../index.js';

describe('Amp integration contract', () => {
  it('exposes current Amp modes without a duplicate Mode setting', async () => {
    const integration = new AmpAgentIntegration(createHost());
    const catalog = await integration.catalog.snapshot({
      strict: false,
      signal: new AbortController().signal,
    });

    expect(catalog.defaultModel).toBe('medium');
    expect(catalog.models).toEqual([
      { value: 'low', label: 'Amp Low', supportsImages: true },
      { value: 'medium', label: 'Amp Medium', supportsImages: true },
      { value: 'high', label: 'Amp High', supportsImages: true },
      { value: 'ultra', label: 'Amp Ultra', supportsImages: true },
    ]);
    expect(integration.settings.describe()).toEqual([]);
    expect(integration.settings.defaults()).toEqual({
      ownerId: 'amp',
      schemaVersion: 2,
      values: {},
    });
    await expect(integration.settings.migrate({
      ownerId: 'amp',
      schemaVersion: 1,
      values: { ampAgentMode: 'deep' },
    })).resolves.toEqual({
      ownerId: 'amp',
      schemaVersion: 2,
      values: {},
    });
    expect(integration.descriptor.supportsImages).toBe(true);
    expect(integration.attachments?.fileMimeTypes).toEqual([
      'image/jpeg',
      'image/png',
      'image/gif',
      'image/webp',
    ]);
    expect(integration.steering).not.toBeNull();
    expect(integration.descriptor.supportedPermissionModes).toEqual(['bypassPermissions']);
    expect(integration.descriptor.supportedThinkingModes).toEqual([]);
    await expect(integration.migration.translateLegacyModel({
      scope: { kind: 'chat', recordId: 'chat-1', selectedAgentId: 'amp' },
      model: 'deep',
      signal: new AbortController().signal,
    })).resolves.toBe('medium');
  });
});

function createHost() {
  return {
    agentId: 'amp',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: '/tmp',
      directory: async () => '/tmp',
      claimLegacyWorkspaceDirectory: async () => ({ moved: 0, skipped: 0 }),
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
  };
}
