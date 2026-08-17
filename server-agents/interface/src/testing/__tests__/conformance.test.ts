import { describe, expect, test } from 'bun:test';
import type { AgentIntegration } from '../../index.js';
import {
  runAgentIntegrationConformance,
  validateAgentIntegration,
} from '../conformance.js';

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
  attachments: null,
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

  test('requires every nullable capability to declare its state', () => {
    const nullableFacets = [
      'attachments',
      'auth',
      'commands',
      'compaction',
      'forking',
      'steering',
      'goals',
      'endpoints',
      'singleQuery',
      'nativeHistoryImport',
      'nativeActivity',
      'nativeSessions',
      'sessionConfiguration',
      'projectPathUpdates',
    ] as const;

    for (const facet of nullableFacets) {
      const invalid = { ...integration } as Record<string, unknown>;
      delete invalid[facet];
      expect(() => validateAgentIntegration({
        integrationClass: { integrationId: 'other', apiVersion: 5 },
        integration: invalid as unknown as AgentIntegration,
      })).toThrow(`missing required ${facet} capability state`);
    }
  });

  test('rejects malformed required and advertised facet shapes', () => {
    const invalidFacets = [
      ['execution', { ...integration.execution, runningSessions: undefined }],
      ['catalog', {}],
      ['settings', { ...integration.settings, applyPatch: undefined }],
      ['lifecycle', { ...integration.lifecycle, migrateOwnedStorage: undefined }],
      ['migration', { ...integration.migration, translateLegacySettings: undefined }],
      ['attachments', { fileMimeTypes: ['image/png', 7] }],
      ['auth', { status: undefined }],
      ['auth', { status: async () => ({}), launchLogin: false }],
      ['commands', {}],
      ['compaction', {}],
      ['forking', { fork: async () => ({ kind: 'unmaterialized' }) }],
      ['goals', {}],
      ['endpoints', {}],
      ['singleQuery', {}],
      ['singleQuery', { run: async () => '', runsToolsWithoutPermission: false }],
      ['singleQuery', { run: async () => '', runsToolsWithoutPermission: undefined }],
      ['legacyHistoryImport', {}],
      ['nativeHistoryImport', {}],
      ['nativeActivity', {}],
      ['nativeSessions', { resolveNativeSession: async () => null }],
      ['sessionConfiguration', {}],
      ['projectPathUpdates', {}],
    ] as const;

    for (const [facet, value] of invalidFacets) {
      expect(() => validateAgentIntegration({
        integrationClass: { integrationId: 'other', apiVersion: 5 },
        integration: { ...integration, [facet]: value } as AgentIntegration,
      })).toThrow(`invalid ${facet} facet`);
    }
  });

  test('[TLV5-ADOPT.07-INTERFACE-NEGATIVE-01] rejects a missing legacy history capability declaration', () => {
    const { legacyHistoryImport: _legacyHistoryImport, ...missingLegacyHistoryImport } = integration;

    expect(() => validateAgentIntegration({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: missingLegacyHistoryImport as AgentIntegration,
    })).toThrow('missing required legacyHistoryImport capability state');
  });
});

describe('runAgentIntegrationConformance', () => {
  test('accepts an empty settings patch and a well-formed running-session snapshot', async () => {
    await expect(runAgentIntegrationConformance({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: {
        ...integration,
        execution: {
          ...integration.execution,
          runningSessions: () => [{
            agentSessionId: 'session-1',
            status: null,
            startedAt: null,
          }],
        },
      },
    })).resolves.toBeUndefined();
  });

  test('rejects an empty settings patch that changes the envelope', async () => {
    await expect(runAgentIntegrationConformance({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: {
        ...integration,
        settings: {
          ...integration.settings,
          applyPatch: (current) => ({ ...current, values: { changed: true } }),
        },
      },
    })).rejects.toThrow('changed settings for an empty patch');
  });

  test('rejects an empty settings patch that mutates the current envelope', async () => {
    await expect(runAgentIntegrationConformance({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: {
        ...integration,
        settings: {
          ...integration.settings,
          defaults: () => ({ ...settings, values: {} }),
          applyPatch: (current) => {
            (current.values as Record<string, unknown>).changed = true;
            return current;
          },
        },
      },
    })).rejects.toThrow('changed settings for an empty patch');
  });

  test('rejects a second migration that mutates its input', async () => {
    let migrationCount = 0;
    await expect(runAgentIntegrationConformance({
      integrationClass: { integrationId: 'other', apiVersion: 5 },
      integration: {
        ...integration,
        settings: {
          ...integration.settings,
          defaults: () => ({ ...settings, values: {} }),
          migrate: async (current) => {
            migrationCount += 1;
            if (migrationCount === 2) {
              (current.values as Record<string, unknown>).changed = true;
            }
            return current;
          },
        },
      },
    })).rejects.toThrow('settings migration is not idempotent');
  });

  test('rejects malformed or duplicate running-session snapshots', async () => {
    for (const runningSessions of [
      () => [{ agentSessionId: '', status: null, startedAt: null }],
      () => [
        { agentSessionId: 'duplicate', status: null, startedAt: null },
        { agentSessionId: 'duplicate', status: 'running', startedAt: null },
      ],
    ]) {
      await expect(runAgentIntegrationConformance({
        integrationClass: { integrationId: 'other', apiVersion: 5 },
        integration: {
          ...integration,
          execution: { ...integration.execution, runningSessions },
        },
      })).rejects.toThrow('invalid running session snapshot');
    }
  });
});
