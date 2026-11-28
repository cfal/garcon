import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AgentIntegration } from '@garcon/server-agent-interface';
import { controllerSafetyDependencies } from '../../../../server/controller/__tests__/safety-dependencies.ts';
import { createProducerFixture } from '../../../../server/controller/agents/__tests__/producer-fixture.ts';
import { AgentDirectory } from '../../../../server/controller/agents/directory.ts';
import { AgentRegistry } from '../../../../server/controller/agents/registry.ts';
import type { AgentChatEntry } from '../../../../server/controller/agents/session-types.ts';
import { ApiProviderEndpointResolver } from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import { ChatRegistry } from '../../../../server/controller/chats/store.ts';
import { TranscriptAdoptionService } from '../../../../server/controller/ledger/adoption.ts';
import { TranscriptLedgerService } from '../../../../server/controller/ledger/service.ts';
import { TranscriptLedgerStore } from '../../../../server/controller/ledger/store.ts';
import { IntegrationRegistry } from '../../../../server/runtime/agents/integration-registry.ts';

const remote = '11111111-1111-4111-8111-111111111111';

export async function describeSourceTrace(scenario: string) {
  const effects: unknown[] = [];
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
      describe: () => [], defaults: () => ({ ownerId: 'test', schemaVersion: 3, values: {} }),
      parse: input => input, migrate: async input => input, applyPatch: current => current,
    },
    lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
    migration: {
      translateLegacyModel: async ({ model }) => model, translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    attachments: null, literalExecution: null, readiness: null, auth: null, commands: null,
    compaction: null, forking: null, steering: null, endpoints: null, singleQuery: null,
    legacyHistoryImport: null, nativeHistoryImport: null, nativeActivity: null,
    nativeSessions: scenario === 'unsupported' ? null : {
      async describeSource({ chat, signal }) {
        effects.push(['describe', JSON.stringify(chat), signal.aborted]);
        if (scenario === 'failure') throw new Error('synthetic source failure');
        if (scenario === 'none') return null;
        if (scenario === 'reference') return { kind: 'provider-reference', value: ' ' };
        return { kind: 'filesystem-path', value: scenario === 'empty' ? '' : '/synthetic/transcript.jsonl' };
      },
      async resolveNativeSession() { throw new Error('fixture must not resolve a native session'); },
      async release() { throw new Error('fixture must not release a native session'); },
    },
    configurationValidation: null, sessionConfiguration: null, projectPathUpdates: null,
    usageHistory: null, cliUpdates: null,
  } satisfies AgentIntegration;
  const executors = {
    requireIntegration: () => { throw new Error('fixture must not require a live executor'); },
    knownIntegration: ({ agentId, executorId }: { agentId: string; executorId: string }) => {
      effects.push(['lookup', agentId, executorId]);
      return scenario === 'missing' ? null : integration;
    },
    integrationsFor: () => new IntegrationRegistry({ instances: [integration] }),
    isReady: () => false,
  };
  const readRevision = (session: AgentChatEntry) => {
    effects.push(['revision', session.agentOwnershipEpoch]);
    return 'frozen-revision';
  };
  const workspace = await mkdtemp(join(tmpdir(), 'garcon-describe-source-'));
  const store = new TranscriptLedgerStore(join(workspace, 'ledger'));
  const warn = console.warn;
  let warnings = 0;
  try {
    console.warn = () => { warnings++; };
    const registry = new ChatRegistry(workspace);
    const ledger = new TranscriptLedgerService(store, { serverInstanceId: 'synthetic' });
    const adoption = new TranscriptAdoptionService({
      registry, ledger, integrations: new AgentDirectory(executors), getCarryOverRevision: readRevision,
      loadFrozenPrefix: async () => { throw new Error('fixture must not load frozen history'); },
    });
    const agents = new AgentRegistry({
      ...controllerSafetyDependencies(), registry, ledger, adoption, executors,
      endpointResolver: new ApiProviderEndpointResolver(() => []),
      getCarryOverRevision: readRevision,
      createCarriedContext: async () => { throw new Error('fixture must not create carried context'); },
      getSettingsExecution: () => { throw new Error('fixture must not update settings'); },
      hasPendingOwnershipTransfer: () => false,
      preambles: { snapshot: () => ({ revision: 0, preambles: [] }) },
      resolveFileMentions: async command => command,
    });
    const source = await agents.describeTranscriptSource({
      agentId: 'test', executorId: remote, projectPath: '/project', model: 'sample-model',
      agentSessionId: 'native-1', agentOwnershipEpoch: 'owner-a',
      nativeSession: { ownerId: scenario === 'owner' ? 'other' : 'test', schemaVersion: 1, value: {} },
    }, 'chat-1');
    return { source, effects, warnings };
  } finally {
    console.warn = warn;
    store.close();
    await rm(workspace, { force: true, recursive: true });
  }
}
