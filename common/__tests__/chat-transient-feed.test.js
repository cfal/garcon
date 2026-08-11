import { describe, expect, it } from 'bun:test';
import {
  parseChatProjectionGenerationTransition,
  parseChatTransientControlAction,
  parseChatTransientFeedMutation,
  parseChatTransientFeedSnapshot,
} from '../chat-transient-feed.ts';

const CHAT_ID = '1785337200123456';
const OWNER = {
  agentOwnershipEpoch: 'owner-1',
  commandType: 'agent-run',
  clientRequestId: 'request-1',
  turnId: 'turn-1',
};

function row(overrides = {}) {
  return {
    id: 'permission-1',
    incarnation: 'incarnation-1',
    operationTurnId: 'turn-1',
    turnOwner: OWNER,
    transcript: { generationId: 'generation-1', afterSeq: 3 },
    displayOrder: 0,
    message: {
      type: 'permission-request',
      timestamp: '2026-08-11T00:00:00.000Z',
      permissionRequestId: 'permission-1',
      requestedTool: {
        type: 'bash-tool-use',
        timestamp: '2026-08-11T00:00:00.000Z',
        toolId: 'tool-1',
        command: 'bun test',
      },
    },
    ...overrides,
  };
}

function snapshot(overrides = {}) {
  return {
    serverInstanceId: 'server-1',
    chatId: CHAT_ID,
    agentOwnershipEpoch: 'owner-1',
    generationId: 'generation-1',
    resetTransactionId: null,
    transientRevision: 1,
    stateDigest: 'transient-v1:digest',
    rows: [row()],
    ...overrides,
  };
}

describe('chat transient feed contracts', () => {
  it('parses snapshots, mutations, transitions, and action fences', () => {
    expect(parseChatTransientFeedSnapshot(snapshot())).toMatchObject({
      rows: [{ id: 'permission-1', operationTurnId: 'turn-1' }],
    });
    expect(parseChatTransientFeedMutation({
      ...snapshot({ rows: undefined, resetTransactionId: undefined }),
      mutation: { kind: 'upsert', row: row() },
    })).toMatchObject({ mutation: { kind: 'upsert', row: { id: 'permission-1' } } });
    expect(parseChatProjectionGenerationTransition({
      ...snapshot({ generationId: 'generation-2', resetTransactionId: undefined }),
      resetTransactionId: 'reset-1',
      previousGenerationId: 'generation-1',
      rows: [row({ transcript: { generationId: 'generation-2', afterSeq: 3 } })],
    })).toMatchObject({ resetTransactionId: 'reset-1', generationId: 'generation-2' });
    expect(parseChatTransientControlAction({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      agentOwnershipEpoch: 'owner-1',
      turnOwner: OWNER,
      id: 'permission-1',
      incarnation: 'incarnation-1',
    })).toMatchObject({ id: 'permission-1', incarnation: 'incarnation-1' });
  });

  it('rejects duplicate slots even when their incarnations differ', () => {
    expect(parseChatTransientFeedSnapshot(snapshot({
      rows: [row(), row({ incarnation: 'incarnation-2' })],
    }))).toBeNull();
  });

  it('rejects ownership, generation, and turn mismatches', () => {
    expect(parseChatTransientFeedSnapshot(snapshot({
      rows: [row({ turnOwner: { ...OWNER, agentOwnershipEpoch: 'owner-2' } })],
    }))).toBeNull();
    expect(parseChatTransientFeedMutation({
      ...snapshot({ rows: undefined, resetTransactionId: undefined }),
      mutation: {
        kind: 'upsert',
        row: row({ transcript: { generationId: 'generation-2', afterSeq: 3 } }),
      },
    })).toBeNull();
    expect(parseChatTransientFeedSnapshot(snapshot({
      rows: [row({ operationTurnId: 'turn-2' })],
    }))).toBeNull();
    expect(parseChatTransientControlAction({
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      agentOwnershipEpoch: 'owner-2',
      turnOwner: OWNER,
      id: 'permission-1',
      incarnation: 'incarnation-1',
    })).toBeNull();
  });

  it('rejects invalid reset identities instead of treating them as null', () => {
    expect(parseChatTransientFeedSnapshot(snapshot({ resetTransactionId: '' }))).toBeNull();
    expect(parseChatProjectionGenerationTransition({
      ...snapshot({ generationId: 'generation-2' }),
      resetTransactionId: 'reset-1',
      previousGenerationId: 'generation-2',
      rows: [],
    })).toBeNull();
  });
});
