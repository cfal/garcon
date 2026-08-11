import { describe, expect, test } from 'bun:test';
import type { AgentIntegrationV4 } from '../../index.js';
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
    start: async () => ({ agentSessionId: 'session', nativeSession: null, nativeSeedReceipt: null }),
    resume: async () => {},
    abort: async () => false,
    isRunning: () => false,
    runningSessions: () => [],
  },
  transcript: {
    openSegment: async () => { throw new Error('not used'); },
    subscribe: () => () => {},
    replay: async () => { throw new Error('not used'); },
    loadPage: async () => { throw new Error('not used'); },
    commitOffset: async () => {},
    prepareInput: async () => { throw new Error('not used'); },
    resolveInputAdmission: async () => ({ kind: 'absent' as const }),
    prepareHandoffLease: async () => { throw new Error('not used'); },
    prepareOwnershipSegment: async () => { throw new Error('not used'); },
    resolveNativeSession: async () => ({ kind: 'ready' as const, value: null }),
    preview: async () => ({ kind: 'ready' as const, value: null }),
    resolveIndexSource: async () => ({ kind: 'ready' as const, value: null }),
    refreshIndexSource: async () => ({ kind: 'ready' as const, value: null }),
    describeSource: async () => ({ kind: 'ready' as const, value: null }),
    release: async () => {},
  },
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
  forking: null,
  steering: null,
  goals: null,
  transientControls: null,
  endpoints: null,
  singleQuery: null,
} satisfies AgentIntegrationV4;

describe('validateAgentIntegration', () => {
  test('rejects a descriptor and class ID mismatch', () => {
    const integrationClass = {
      integrationId: 'fake', apiVersion: 4 as const,
      transcriptIndex: { apiVersion: 1 as const, moduleUrl: import.meta.url },
    };
    expect(() => validateAgentIntegration({
      integrationClass,
      integration,
    })).toThrow('Agent integration ID mismatch');
  });

  test('rejects duplicate descriptor values', () => {
    const integrationClass = {
      integrationId: 'other', apiVersion: 4 as const,
      transcriptIndex: { apiVersion: 1 as const, moduleUrl: import.meta.url },
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
      integrationId: 'other', apiVersion: 4 as const,
      transcriptIndex: { apiVersion: 1 as const, moduleUrl: import.meta.url },
    };

    expect(() => validateAgentIntegration({
      integrationClass,
      integration: {
        ...integration,
        steering: { steer: async () => ({ kind: 'accepted' as const }) },
      } as AgentIntegrationV4,
    })).toThrow('invalid steering facet');
  });
});
