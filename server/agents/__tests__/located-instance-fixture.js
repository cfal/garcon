import { mock } from 'bun:test';
import { createLocalProviderInstances } from '../../execution-node/local-provider-instance.js';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage } from '../../../common/chat-types.js';
import { ApiProviderEndpointResolver } from '../../api-providers/endpoint-resolver.js';
import { emptyStoredChatExecutionControl } from '../../chat-execution/control-state.js';
import { ExecutionOwnership } from '../../chat-execution/execution-ownership.js';
import { ChatRegistry } from '../../chats/store.js';
import { TranscriptAdoptionService } from '../../ledger/adoption.js';
import { TranscriptReloadService } from '../../ledger/reload.js';
import { TranscriptLedgerService } from '../../ledger/service.js';
import { TranscriptLedgerStore } from '../../ledger/store.js';
import { KeyedPromiseLock } from '../../lib/keyed-lock.js';
import { createForkNativeHistoryReader } from '../fork-native-history-reader.js';
import { AgentInstanceDirectory } from '../instance-directory.js';
import { AgentRegistry } from '../registry.js';

export const LOCATED_AT = '2026-09-10T00:00:00.000Z';
export const LOCATED_CHATS = { primary: '1000000000000001', secondary: '1000000000000002' };
const nativeSession = { ownerId: 'test', schemaVersion: 1, value: { id: 'colliding-session' } };

function createIntegration(profile) {
  const handle = Object.freeze({ profile });
  const target = Object.freeze({ profile, turn: 'original' });
  const session = { agentSessionId: 'colliding-session', nativeSession, nativeSeedReceipt: null };
  const preparation = { commit: mock(async () => {}), rollback: mock(async () => {}) };
  const legacyLoad = mock(async function* () {
    yield [{ message: new AssistantMessage(LOCATED_AT, `${profile} legacy`) }];
  });
  const nativeLoad = mock(async function* () {
    yield [{ message: new AssistantMessage(LOCATED_AT, `${profile} native`) }];
  });
  /** @satisfies {import('@garcon/server-agent-interface').AgentIntegration} */
  const integration = {
    descriptor: {
      id: 'test', label: 'Synthetic provider', icon: null,
      supportedPermissionModes: ['default'], supportedThinkingModes: ['none'],
      supportsImages: false, supportsProjectPathUpdate: true,
      requiresNativePathForProjectPathUpdate: false, supportedEndpointProtocols: [], configuration: [],
    },
    settings: {
      defaults: () => ({ ownerId: 'test', schemaVersion: 1, values: {} }),
      describe: () => [],
      parse: mock((input) => ({ ...input, values: { ...input.values, parsedBy: profile } })),
      migrate: async (input) => input,
      applyPatch: (input, patch) => ({ ...input, values: { ...input.values, ...patch } }),
    },
    execution: {
      start: mock(async (request) => {
        request.output.emit({ type: 'session', session });
        return handle;
      }),
      resume: mock(async () => handle),
      abort: mock(async () => {}),
    },
    steering: {
      captureTarget: mock(() => target),
      steer: mock(async (request) => {
        await request.prepareDelivery();
        return { kind: 'accepted' };
      }),
    },
    goals: { submitControl: mock(async () => true) },
    compaction: { compact: mock(async () => handle) },
    forking: {
      fork: mock(async () => ({ kind: 'materialized', session: {
        ...session, agentSessionId: 'colliding-fork',
      } })),
      discard: mock(async () => {}),
    },
    projectPathUpdates: { prepare: mock(async () => preparation) },
    sessionConfiguration: {
      prepare: mock(async () => ({ kind: 'prepared', target })),
      commit: mock(async () => ({ kind: 'applied' })),
      cancel: mock(() => {}),
    },
    legacyHistoryImport: { load: legacyLoad },
    nativeHistoryImport: { load: nativeLoad },
    nativeSessions: {
      resolveNativeSession: mock(async () => ({ ...nativeSession, value: { id: 'colliding-session', profile } })),
      describeSource: mock(async () => ({ kind: 'provider-reference', value: `${profile}/colliding-session` })),
      release: mock(async () => {}),
    },
    catalog: { snapshot: async () => ({
      models: [], defaultModel: 'synthetic-model', requiresStrictModelDiscovery: false, generation: null,
    }) },
    lifecycle: { start: async () => {}, stop: async () => {}, migrateOwnedStorage: async () => {} },
    migration: {
      translateLegacyModel: async ({ model }) => model,
      translateLegacyNativeSession: async () => null,
      translateLegacySettings: async () => null,
    },
    commands: { discover: mock(async () => [{ name: `${profile}-command`, source: 'command' }]) },
    attachments: null, auth: null, endpoints: null, singleQuery: null, textGeneration: null, nativeActivity: null,
  };
  return { integration, handle, target, preparation };
}

export async function createLocatedInstanceFixture(extraInstances = []) {
  const root = await mkdtemp(path.join(os.homedir(), 'garcon-located-instance-'));
  const chats = new ChatRegistry(root);
  await chats.init();
  const profiles = { primary: createIntegration('primary'), secondary: createIntegration('secondary') };
  const instances = new AgentInstanceDirectory(createLocalProviderInstances([...Object.entries(profiles).map(([profile, { integration }]) => ({
    configuration: {
      nodeId: 'local-node', id: profile, agentId: 'test', label: profile,
      storageNamespace: `instances/${profile}`, default: profile === 'primary', removedAt: null,
    },
    integration,
  })), ...extraInstances]));
  for (const [profile, id] of Object.entries(LOCATED_CHATS)) {
    chats.addChat({
      id, agentId: 'test', agentSessionId: 'colliding-session', nativeSession,
      executionLocation: { nodeId: 'local-node', instanceId: profile, workspaceId: 'project' },
      model: 'synthetic-model', projectPath: root, parentChat: null,
      permissionMode: 'default', thinkingMode: 'none',
      agentSettingsById: { test: { ownerId: 'test', schemaVersion: 1, values: {} } },
      preambleSelection: { revision: 0, orderedPreambleIds: [] },
    });
  }
  const ledger = new TranscriptLedgerService(new TranscriptLedgerStore(path.join(root, 'transcript-ledgers')));
  const adoption = new TranscriptAdoptionService({
    ledger, registry: chats, instances,
    getCarryOverRevision: () => 'synthetic-revision', loadFrozenPrefix: async () => [],
  });
  /** @satisfies {Pick<import('../type-registry.js').AgentTypeRegistry, 'has' | 'get' | 'require' | 'list'>} */
  const types = {
    has: (id) => id === 'test',
    get: (id) => id === 'test' ? profiles.primary.integration.descriptor : null,
    require: (id) => {
      if (id !== 'test') throw new Error('Unknown synthetic provider');
      return profiles.primary.integration.descriptor;
    },
    list: () => [profiles.primary.integration.descriptor],
  };
  const chatMutationLock = new KeyedPromiseLock();
  const agents = new AgentRegistry({
    fileMentions: { resolve: async (command) => command },
    localNodeId: 'local-node',
    registry: chats, types, instances, ledger, adoption, chatMutationLock,
    endpointResolver: new ApiProviderEndpointResolver(() => []),
    getCarryOverRevision: () => 'synthetic-revision',
    createCarriedContext: async () => ({ kind: 'no-history' }),
    hasPendingOwnershipTransfer: () => false,
    preambles: { snapshot: () => ({ revision: 0, preambles: [] }) },
    selectionAdmissionLock: new KeyedPromiseLock(),
  });
  const ownership = new ExecutionOwnership();
  const reload = new TranscriptReloadService({
    ledger, adoption, registry: chats, instances, chatMutationLock,
    getCarryOverRevision: () => 'synthetic-revision',
    reopenProducer: (chatId) => agents.reopenTranscriptProducer(chatId),
    execution: {
      reserveTranscriptSnapshot: (chatId) => ownership.reserveTranscriptSnapshot(chatId),
      releaseTranscriptSnapshot: async (reservation) => ownership.releaseTranscriptSnapshot(reservation),
      readChatExecutionControl: async () => emptyStoredChatExecutionControl('synthetic-boot'),
    },
  });
  const readFork = createForkNativeHistoryReader({ instances, carryOver: { revision: () => 'synthetic-revision' } });
  return {
    root, chats, ledger, adoption, agents, types, instances, reload, readFork, ...profiles,
    async dispose() {
      ledger.close();
      await chats.flush();
      await rm(root, { recursive: true, force: true });
    },
  };
}
