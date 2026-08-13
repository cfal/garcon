import { describe, expect, test } from 'bun:test';
import {
  ChatSnapshotContractError,
  parseChatSnapshotResponse,
} from '../chat-snapshot.js';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-04T12:00:00.000Z';

function snapshot(overrides = {}) {
  return {
    observedAt: TIMESTAMP,
    messageLimit: 10,
    chat: {
      id: CHAT_ID,
      title: 'Implement validation',
      agentId: 'codex',
      model: 'gpt-5.4',
      apiProviderId: null,
      modelEndpointId: null,
      modelProtocol: null,
      permissionMode: 'acceptEdits',
      thinkingMode: 'high',
      agentOwnershipEpoch: 'epoch-1',
      carryOverRevision: 'carry-v1:0',
      projectPath: '/work/project',
      tags: ['cli', 'review'],
      canReloadFromNativeHistory: true,
      activity: { createdAt: TIMESTAMP, lastActivityAt: TIMESTAMP },
    },
    processingPhase: 'running',
    control: {
      serverInstanceId: 'instance-1',
      queue: {
        entries: [],
        steeringEntryId: null,
        recentlyDispatched: [],
        pause: null,
        reorderRevision: 0,
      },
      version: 0,
      updatedAt: null,
    },
    transientFeed: {
      serverInstanceId: 'instance-1',
      chatId: CHAT_ID,
      transcriptViewId: 'view-1',
      transientRevision: 0,
      rows: [],
    },
    transcript: {
      availability: 'available',
      transcriptViewId: 'view-1',
      messages: [{
        ordinal: 4,
        message: { type: 'assistant-message', timestamp: TIMESTAMP, content: 'Working' },
      }, {
        ordinal: 5,
        message: {
          type: 'bash-tool-use',
          timestamp: TIMESTAMP,
          toolId: 'tool-1',
          command: 'bun test',
        },
      }],
      lastOrdinal: 5,
      pageOldestOrdinal: 4,
      pageNewestOrdinal: 5,
      hasMore: true,
    },
    ...overrides,
  };
}

describe('chat snapshot contract', () => {
  test('parses available and unavailable transcript snapshots', () => {
    expect(parseChatSnapshotResponse(snapshot())).toMatchObject({
      chat: { id: CHAT_ID, tags: ['cli', 'review'] },
      processingPhase: 'running',
      transcript: { availability: 'available', lastOrdinal: 5 },
    });
    expect(parseChatSnapshotResponse(snapshot({
      transcript: {
        availability: 'unavailable',
        errorCode: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
        message: 'Retry the request',
      },
    }))).toMatchObject({
      transcript: { availability: 'unavailable', retryable: true },
    });
  });

  test('requires the explicit not-requested transcript variant for a zero limit', () => {
    expect(parseChatSnapshotResponse(snapshot({
      messageLimit: 0,
      transcript: { availability: 'not-requested' },
    })).transcript).toEqual({ availability: 'not-requested' });
    expect(() => parseChatSnapshotResponse(snapshot({ messageLimit: 0 })))
      .toThrow(ChatSnapshotContractError);
    expect(() => parseChatSnapshotResponse(snapshot({
      transcript: { availability: 'not-requested' },
    }))).toThrow('cannot be not-requested');
  });

  test('accepts opaque producer cursor metadata', () => {
    expect(parseChatSnapshotResponse(snapshot({
      transcript: {
        availability: 'available',
		transcriptViewId: 'view-2',
		messages: [],
		lastOrdinal: 42,
		pageOldestOrdinal: 17,
		pageNewestOrdinal: 42,
        hasMore: true,
      },
      transientFeed: {
        ...snapshot().transientFeed,
        transcriptViewId: 'view-2',
      },
	})).transcript).toMatchObject({ lastOrdinal: 42, pageOldestOrdinal: 17, hasMore: true });
  });

  test('requires transcript and transient state to share one transcript view', () => {
    expect(() => parseChatSnapshotResponse(snapshot({
      transientFeed: {
        ...snapshot().transientFeed,
        transcriptViewId: 'view-2',
      },
    }))).toThrow('views differ');
  });

  test.each([
    ['chat ID', (value) => ({ ...value, chat: { ...value.chat, id: '123' } })],
    ['processing phase', (value) => ({ ...value, processingPhase: 'busy' })],
    ['execution control', (value) => ({ ...value, control: { ...value.control, version: -1 } })],
    ['message order', (value) => ({
      ...value,
      transcript: {
        ...value.transcript,
        messages: [...value.transcript.messages].reverse(),
      },
    })],
    ['message count', (value) => ({ ...value, messageLimit: 1 })],
    ['message cursor', (value) => ({
      ...value,
        transcript: { ...value.transcript, lastOrdinal: 4 },
    })],
    ['tags', (value) => ({ ...value, chat: { ...value.chat, tags: ['review', 'cli'] } })],
    ['protocol', (value) => ({
      ...value,
      chat: { ...value.chat, modelProtocol: 'invalid' },
    })],
    ['ownership epoch', (value) => ({
      ...value,
      chat: { ...value.chat, agentOwnershipEpoch: '' },
    })],
    ['carryover revision', (value) => ({
      ...value,
      chat: { ...value.chat, carryOverRevision: null },
    })],
    ['reload capability', (value) => ({
      ...value,
      chat: { ...value.chat, canReloadFromNativeHistory: 'yes' },
    })],
    ['timestamp', (value) => ({ ...value, observedAt: 'not-a-time' })],
  ])('rejects invalid %s data', (_label, mutate) => {
    expect(() => parseChatSnapshotResponse(mutate(snapshot())))
      .toThrow(ChatSnapshotContractError);
  });
});
