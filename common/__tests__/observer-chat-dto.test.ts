import { expect, test } from 'bun:test';
import { parseChatListResponse, type ChatListEntry } from '../chat-list.js';
import { parseChatSnapshotResponse } from '../chat-snapshot.js';
import type { ChatObservation } from '../chat-observation.js';
import { emptyChatExecutionControlState } from '../chat-execution-control.js';

const entry = {
  id: '1783725900000101', parentChatId: '1783725900000100', lineage: null,
  agentId: 'synthetic', agentOwnershipEpoch: 'epoch', model: null,
  apiProviderId: null, modelEndpointId: null, modelProtocol: null,
  permissionMode: 'default', thinkingMode: 'none',
  agentSettings: { ownerId: 'synthetic', schemaVersion: 1, values: {} },
  title: 'Child', projectPath: '/synthetic', orderGroup: 'normal', tags: [],
  activity: { createdAt: null, lastActivityAt: null, lastReadAt: null },
  preview: { lastMessage: '' }, isPinned: false, isArchived: false,
  isActive: false, isProcessing: false, processingPhase: null, activityStatus: null,
  isUnread: false, canReloadFromNativeHistory: true, observation: null,
} satisfies ChatListEntry;

function list(observation: unknown) {
  return parseChatListResponse({ sessions: [{ ...entry, observation }], total: 1, lastSelectedChatId: null });
}

function snapshot(observation: unknown) {
  return parseChatSnapshotResponse({
    observedAt: '2026-11-24T00:00:00.000Z', messageLimit: 0,
    chat: { ...entry, carryOverRevision: 'carry-v1:0', observation }, processingPhase: null,
    control: emptyChatExecutionControlState('server'),
    transientFeed: { serverInstanceId: 'server', chatId: entry.id, transcriptViewId: 'view', transientRevision: 0, rows: [] },
    transcript: { availability: 'not-requested' },
  });
}

test('list and snapshot preserve child-only activity and reject an absent discriminator', () => {
  for (const observation of [null,
    { kind: 'native-child', captureStatus: 'attached', isWorking: true },
    { kind: 'native-child', captureStatus: 'detached', isWorking: false },
  ] satisfies Array<ChatObservation | null>) {
    expect(list(observation).sessions[0]?.observation).toEqual(observation);
    expect(snapshot(observation).chat.observation).toEqual(observation);
  }
  for (const invalid of [undefined, {}, { kind: 'native-child', captureStatus: 'detached', isWorking: true }]) {
    expect(() => list(invalid)).toThrow();
    expect(() => snapshot(invalid)).toThrow();
  }
});
