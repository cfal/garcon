import { describe, expect, test } from 'bun:test';
import type { AgentIntegration } from '../../index.js';
import { validateAgentIntegration } from '../conformance.js';

const settings = { ownerId: 'other', schemaVersion: 1, values: {} } as const;

const integration = {
  descriptor: {
    id: 'other',
    label: 'Other',
    icon: null,
    supportedPermissionModes: [],
    supportedThinkingModes: [],
    supportsImages: false,
    supportsProjectPathUpdate: false,
    requiresNativePathForProjectPathUpdate: false,
    supportedEndpointProtocols: [],
    configuration: [],
  },
  execution: {
    start: async () => ({ agentSessionId: 'session', nativeSession: null }),
    resume: async () => {},
    abort: async () => false,
    isRunning: () => false,
    runningSessions: () => [],
    subscribe: () => () => {},
  },
  transcript: {
    resolveNativeSession: async () => null,
    load: async () => ({ messages: [], revision: 'empty' }),
    preview: async () => null,
    revision: async () => 'empty',
    release: async () => {},
  },
  transcriptSearch: {
    reconcile: async () => {},
    search: async () => ({
      hits: [],
      index: { indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 },
    }),
    status: async () => ({ indexedChatCount: 0, pendingChatCount: 0, failedChatCount: 0, unsupportedChatCount: 0 }),
    disableAndDelete: async () => {},
  },
  catalog: {
    snapshot: async () => ({
      models: [],
      defaultModel: '',
      requiresStrictModelDiscovery: false,
      generation: null,
      availability: { state: 'ready', reason: 'test' },
    }),
  },
  settings: {
    describe: () => [],
    defaults: () => settings,
    parse: (input) => input,
    migrate: async (input) => input,
    applyPatch: (current) => current,
  },
  lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
  migration: {
    translateLegacyNativeSession: async () => null,
    translateLegacySettings: async () => null,
  },
  auth: null,
  commands: null,
  forking: null,
  endpoints: null,
  singleQuery: null,
} satisfies AgentIntegration;

describe('validateAgentIntegration', () => {
  test('rejects a descriptor and class ID mismatch', () => {
    const integrationClass = { integrationId: 'fake', apiVersion: 1 as const };
    expect(() => validateAgentIntegration({
      integrationClass,
      integration,
    })).toThrow('Agent integration ID mismatch');
  });
});
