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
    start: async () => ({ id: 'execution' }),
    resume: async () => ({ id: 'execution' }),
    abort: async () => false,
    runningSessions: () => [],
  },
  legacyHistoryImport: null,
  nativeHistoryImport: null,
  nativeActivity: null,
  nativeSessions: null,
  sessionConfiguration: null,
  projectPathUpdates: null,
  catalog: {
    snapshot: async () => ({
      models: [],
      defaultModel: '',
      requiresStrictModelDiscovery: false,
      generation: null,
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
  compaction: null,
  forking: null,
  steering: null,
  goals: null,
  endpoints: null,
  singleQuery: null,
} satisfies AgentIntegration & { readonly legacyHistoryImport: null };

describe('validateAgentIntegration', () => {
  test('rejects a descriptor and class ID mismatch', () => {
    const integrationClass = {
      integrationId: 'fake', apiVersion: 5 as const,
    };
    expect(() => validateAgentIntegration({
      integrationClass,
      integration,
    })).toThrow('Agent integration ID mismatch');
  });

  test('rejects duplicate descriptor values', () => {
    const integrationClass = {
      integrationId: 'other', apiVersion: 5 as const,
    };
    expect(() => validateAgentIntegration({
      integrationClass,
      integration: {
        ...integration,
        descriptor: {
          ...integration.descriptor,
          supportedPermissionModes: ['default', 'default'],
        },
      },
    })).toThrow('duplicate permission modes');
  });

  test('rejects a steering facet without admission-time target capture', () => {
    const integrationClass = {
      integrationId: 'other', apiVersion: 5 as const,
    };

    expect(() => validateAgentIntegration({
      integrationClass,
      integration: {
        ...integration,
        steering: { steer: async () => ({ kind: 'accepted' as const }) },
      } as AgentIntegration,
    })).toThrow('invalid steering facet');
  });

  test('[TLV5-ADOPT.07-INTERFACE-NEGATIVE-01] rejects a missing legacy history capability declaration', () => {
    const { legacyHistoryImport: _legacyHistoryImport, ...missingLegacyHistoryImport } = integration;

    expect(() => validateAgentIntegration({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: missingLegacyHistoryImport as AgentIntegration,
    })).toThrow('missing required legacyHistoryImport capability state');
  });
});
