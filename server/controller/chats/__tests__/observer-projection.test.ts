import { expect, test } from 'bun:test';
import { ChatListProjector, type ChatListProjectorDeps } from '../chat-list-projector.js';
import { normalizeChatRegistryEntry } from '../registry-entry-codec.js';
import type { ChatObservation } from '../../../../common/chat-observation.js';

test('observer list and snapshot expose child activity and reported model without native locators', () => {
  const id = '1783725900000101';
  const entry = normalizeChatRegistryEntry({
    agentId: 'synthetic', agentSettingsById: {}, agentOwnershipEpoch: 'epoch',
    parentChatId: '1783725900000100', lineage: null, carryOverSegments: [],
    nativeSession: null, nativeSeedReceipt: null,
    carryOverMigrationQuarantine: null,
    model: 'parent-fallback', projectPath: '/synthetic',
    nativeObservation: { kind: 'native-child', sourceChatId: '1783725900000100',
      sourceOwnershipEpoch: 'source-epoch', sourceAgentSessionId: 'root',
      child: { ownerId: 'synthetic', schemaVersion: 1, key: 'child-key', value: { namespace: 'private-namespace' } },
      parentKey: null, reportedModel: null },
  }, id);
  let observation: ChatObservation = { kind: 'native-child', captureStatus: 'attached', isWorking: true };
  const deps = {
    registry: { getChat: () => entry },
    settings: { getPinnedChatIds: () => [], getNormalChatIds: () => [id], getArchivedChatIds: () => [], getChatName: () => 'Child' },
    metadata: { listAllChatMetadata: () => new Map(), getChatMetadata: () => null, getRunOutcome: () => null },
    processing: { phase: () => null }, transientFeeds: { hasPendingUserAction: () => false },
    observers: { projection: () => observation }, canReloadFromNativeHistory: () => true,
  } satisfies ChatListProjectorDeps;
  const projector = new ChatListProjector(deps);
  for (const attached of [true, false]) {
    observation = { kind: 'native-child', captureStatus: attached ? 'attached' : 'detached', isWorking: attached };
    const list = projector.buildOne(id);
    const summary = projector.buildSummary(id);
    expect(list).toMatchObject({ observation, model: null, isProcessing: false, processingPhase: null });
    expect(summary?.chat.observation).toEqual(observation);
    expect(JSON.stringify(list)).not.toContain('private-namespace');
    expect(JSON.stringify(summary)).not.toContain('child-key');
  }
});
