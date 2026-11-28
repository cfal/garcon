import type { AgentIntegration } from '@garcon/server-agent-interface';
import { DomainError } from '../../../../server/common/domain-error.ts';
import { controllerSafetyDependencies } from '../../../../server/controller/__tests__/safety-dependencies.ts';
import { createProducerFixture } from '../../../../server/controller/agents/__tests__/producer-fixture.ts';
import { AgentDirectory } from '../../../../server/controller/agents/directory.ts';
import { AgentSessionSettingsService, type SettingsExecutionPort } from '../../../../server/controller/agents/session-settings-service.ts';
import { ApiProviderEndpointResolver, type ResolvedModelSelection } from '../../../../server/controller/api-providers/endpoint-resolver.ts';
import { emptyStoredChatExecutionControl } from '../../../../server/controller/chat-execution/control-state.ts';
import type { ChatRegistryEntry } from '../../../../server/controller/chats/registry-contracts.ts';
import { ChatRegistry, type ChatRegistryPatch, type ChatRegistryResolvedEntry } from '../../../../server/controller/chats/store.ts';
import { IntegrationRegistry } from '../../../../server/runtime/agents/integration-registry.ts';

export async function sessionSettingsTrace(scenario: string) {
  const effects: string[] = [];
  const fail = (phase: string) => {
    if (scenario === `${phase}-fails`) throw new Error('synthetic failure');
  };
  const literal = !['conversation', 'stale', 'assignment', 'thinking', 'reference-fails'].includes(scenario);
  const initial = {
    executorId: 'local', agentId: 'test', agentSessionId: 'native', nativeSession: null,
    agentOwnershipEpoch: 'owner', agentSettingsById: {}, projectPath: '/project', tags: [],
    model: 'medium', apiProviderId: null, modelEndpointId: null, modelProtocol: null,
    permissionMode: 'bypassPermissions', thinkingMode: 'high', carryOverSegments: [],
    nativeSeedReceipt: null, carryOverMigrationQuarantine: null, pendingPreambleBoundary: null,
    preambleSelection: { revision: 0, orderedPreambleIds: [] }, parentChatId: null, lineage: null,
  } satisfies ChatRegistryEntry;

  class Registry extends ChatRegistry {
    constructor() { super('/unused'); }
    override getChat(): ChatRegistryEntry { return initial; }
    override updateChat(id: string, patch: ChatRegistryPatch): ChatRegistryResolvedEntry;
    override updateChat(id: string, patch: ChatRegistryPatch, options: { flush: true }): Promise<ChatRegistryResolvedEntry>;
    override updateChat(id: string, patch: ChatRegistryPatch, options?: { flush: true }) {
      if (!options?.flush) throw new Error('settings did not request a durable write');
      effects.push('save');
      fail('save');
      return Promise.resolve({ ...initial, ...patch, id });
    }
  }

  class EndpointResolver extends ApiProviderEndpointResolver {
    #read = false;
    override resolveSelection(input: Parameters<ApiProviderEndpointResolver['resolveSelection']>[0]) {
      effects.push('resolve');
      if (scenario === 'assignment') throw new Error('synthetic failure');
      return super.resolveSelection(input);
    }

    override describePrevious(input: Parameters<ApiProviderEndpointResolver['describePrevious']>[0]) {
      effects.push('previous');
      return super.describePrevious(input);
    }

    override resolveEndpointReference(selection: ResolvedModelSelection) {
      effects.push(this.#read ? 'reference' : 'endpoint');
      if (this.#read) fail('reference');
      this.#read = true;
      return super.resolveEndpointReference(selection);
    }
  }

  const control = emptyStoredChatExecutionControl('server');
  const queueControlInput = () => control.controlEntries.push({
    id: 'pending', content: 'input', transcriptViewId: 'view', createdAt: '',
  });
  if (scenario === 'public-input') control.entries.push({
    id: 'pending', content: 'input', images: [], kind: 'turn', revision: 1,
    status: 'queued', createdAt: '', updatedAt: '',
  });
  if (scenario === 'control-input') queueControlInput();
  let reserved = false;
  const execution = {
    ownsExecution: () => reserved,
    reserveTranscriptSnapshot: chatId => {
      effects.push('reserve');
      reserved = true;
      return { chatId, reservationId: 'reservation' };
    },
    async releaseTranscriptSnapshot() {
      effects.push('release');
      reserved = false;
    },
    async readChatExecutionControl() { effects.push('read-control'); return control; },
    async withChatExecutionControl(_id, apply) {
      effects.push('lock-control');
      try { return await apply(control); }
      finally { effects.push('unlock-control'); }
    },
  } satisfies SettingsExecutionPort;

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
      describe: () => [], defaults: () => ({ ownerId: 'test', schemaVersion: 2, values: {} }),
      parse: input => input, migrate: async input => input, applyPatch: current => current,
    },
    lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
    migration: {
      translateLegacyModel: async ({ model }) => model, translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    attachments: null, literalExecution: literal ? { selectionLabel: 'Mode', inputFormatByModel: {} } : null,
    readiness: null, auth: null, commands: null, compaction: null, forking: null, steering: null,
    endpoints: null, singleQuery: null, legacyHistoryImport: null, nativeHistoryImport: null,
    nativeActivity: null, nativeSessions: null, projectPathUpdates: null, usageHistory: null, cliUpdates: null,
    configurationValidation: scenario === 'assignment' ? null : {
      async validate() {
        effects.push('validate');
        if (scenario === 'late-input') queueControlInput();
        fail('validate');
      },
    },
    sessionConfiguration: { async apply() { effects.push('apply'); fail('apply'); } },
  } satisfies AgentIntegration;
  const service = new AgentSessionSettingsService({
    ...controllerSafetyDependencies(), registry: new Registry(),
    directory: new AgentDirectory({
      requireIntegration: () => { effects.push('require'); return integration; },
      knownIntegration: () => integration, isReady: () => true,
      integrationsFor: () => new IntegrationRegistry({ instances: [integration] }),
    }),
    execution, hasAdmittedProviderTurn: () => false,
    endpointResolver: new EndpointResolver(() => []),
    onCommitted: () => effects.push('committed'),
  });
  try {
    if (scenario === 'assignment') {
      await service.validateConfiguration({
        agentId: 'test', executorId: 'remote', model: 'model', apiProviderId: 'provider', modelEndpointId: 'endpoint',
        permissionMode: 'default', thinkingMode: 'none', agentSettings: integration.settings.defaults(),
      });
      return { result: null, effects };
    }
    const entry = await service.updateSessionSettings('chat-1', {
      model: 'next', ...(scenario === 'thinking' ? { thinkingMode: 'high' as const } : {}),
    }, scenario === 'stale' ? 'previous' : undefined);
    return { result: { model: entry.model, permissionMode: entry.permissionMode, thinkingMode: entry.thinkingMode }, effects };
  } catch (error) {
    if (!(error instanceof Error)) throw error;
    return { result: {
      message: error.message,
      code: error instanceof DomainError ? error.code : null,
      status: error instanceof DomainError ? error.status : null,
      retryable: error instanceof DomainError ? error.retryable : null,
    }, effects };
  }
}
