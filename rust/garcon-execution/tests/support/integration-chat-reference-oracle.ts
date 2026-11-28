import type { AgentIntegration } from '@garcon/server-agent-interface';
import { createNativeSeedReceipt } from '../../../../common/transcript-seed.ts';
import { createProducerFixture } from '../../../../server/controller/agents/__tests__/producer-fixture.ts';
import { toAgentChatReference } from '../../../../server/controller/agents/integration-chat-reference.ts';
import type { AgentChatEntry } from '../../../../server/controller/agents/session-types.ts';

export function integrationChatReferenceTrace(scenario: string) {
  const effects: string[] = [];
  const producer = createProducerFixture();
  const integration = {
    descriptor: {
      id: 'test', label: 'Test', icon: null, supportedPermissionModes: [], supportedThinkingModes: [],
      supportsImages: false, supportsProjectPathUpdate: false, requiresNativePathForProjectPathUpdate: false,
      supportedEndpointProtocols: [], configuration: [],
    },
    execution: {
      start: async () => producer.reference('execution'), resume: async () => producer.reference('execution'),
      abort: async () => false, runningSessions: async () => [],
    },
    producers: producer.producers, permissions: { respond: async () => {} },
    catalog: { snapshot: async () => ({ models: [], defaultModel: '', requiresStrictModelDiscovery: false, generation: null }) },
    settings: {
      describe: () => [], defaults: () => { effects.push('defaults'); return { ownerId: 'test', schemaVersion: 1, values: {} }; },
      parse(input) {
        effects.push('parse');
        if (scenario === 'parse-fails') throw new Error('synthetic settings failure');
        return { ...input, schemaVersion: input.schemaVersion + 1 };
      },
      migrate: async input => input, applyPatch: current => current,
    },
    lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
    migration: {
      translateLegacyModel: async ({ model }) => model, translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    attachments: null, literalExecution: null, readiness: null, auth: null, commands: null,
    compaction: null, forking: null, steering: null, endpoints: null, singleQuery: null,
    legacyHistoryImport: null, nativeHistoryImport: null, nativeActivity: null, nativeSessions: null,
    configurationValidation: null, sessionConfiguration: null, projectPathUpdates: null,
    usageHistory: null, cliUpdates: null,
  } satisfies AgentIntegration;
  const entry: AgentChatEntry = { agentId: 'test', projectPath: '/project' };
  if (scenario === 'seed') {
    entry.model = 'model';
    entry.agentSessionId = 'native-1';
    entry.nativeSession = { ownerId: 'test', schemaVersion: 1, value: { session: 'synthetic' } };
    entry.nativeSeedReceipt = createNativeSeedReceipt({ agentSessionId: 'native-1', placement: 'user-prefix', prefix: 'synthetic prefix' });
    entry.agentSettingsById = {
      test: { ownerId: 'test', schemaVersion: 3, values: JSON.parse('{"n":1.0,"big":9007199254740993,"exp21":1e21,"zero":-0}') },
    };
  }
  if (scenario === 'empty-session') entry.agentSessionId = '';
  if (scenario === 'mismatch' || scenario === 'parse-fails') {
    entry.agentId = 'other';
    entry.nativeSession = { ownerId: 'other', schemaVersion: 1, value: {} };
  }
  try {
    const reference = toAgentChatReference(integration, 'chat-1', entry, 'frozen-revision');
    return { wire: JSON.stringify(reference), error: null, effects };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { wire: null, error: error.message, effects };
  }
}
