import { describe, expect, it } from 'bun:test';
import {
  BashToolUseMessage,
  PermissionRequestMessage,
  UserMessage,
} from '../../../common/chat-types.ts';
import { agentOwnershipEpoch } from '@garcon/server-agent-interface';
import {
  newAgentStreamEpoch,
  newAgentTranscriptContentEpoch,
  newAgentTranscriptEntryId,
} from '@garcon/server-agent-common/transcript-projection/identity';
import { createProjectionMaterialization } from '@garcon/server-agent-common/transcript-projection/state';
import { AgentProjectionEventStream } from '@garcon/server-agent-common/transcript-projection/stream';
import {
  ChatTransientFeedStore,
  TransientControlActionError,
} from '../chat-transient-feed.ts';

const CHAT_ID = '1785337200123456';
const TIMESTAMP = '2026-08-11T00:00:00.000Z';

function fixture() {
  const ownershipEpoch = agentOwnershipEpoch('owner-1');
  const initial = createProjectionMaterialization({
    chatId: CHAT_ID,
    agentOwnershipEpoch: ownershipEpoch,
    epoch: newAgentStreamEpoch(),
    contentEpoch: newAgentTranscriptContentEpoch(),
  });
  const operation = {
    agentOwnershipEpoch: ownershipEpoch,
    commandType: 'agent-run',
    clientRequestId: 'request-1',
    clientMessageId: 'message-1',
    turnId: 'turn-1',
    turnOwner: {
      agentOwnershipEpoch: ownershipEpoch,
      commandType: 'agent-run',
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    },
  };
  return {
    operation,
    stream: new AgentProjectionEventStream({ initial }),
    feed: new ChatTransientFeedStore('server-1'),
  };
}

function permission(id, incarnation, operation, anchorEntryId = null) {
  return {
    id,
    incarnation,
    operation,
    anchorEntryId,
    displayOrder: 0,
    message: new PermissionRequestMessage(
      TIMESTAMP,
      id,
      new BashToolUseMessage(TIMESTAMP, `tool-${id}`, 'bun test'),
    ),
  };
}

async function emit(stream, operation) {
  const previous = stream.current;
  const event = await operation();
  return { event, previous, current: stream.current };
}

const context = { generationId: 'generation-1', carryOverMessageCount: 2 };

describe('ChatTransientFeedStore', () => {
  it('folds incarnations in source order and fences actions to the current row', async () => {
    const testFixture = fixture();
    const upsert = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'one', testFixture.operation) },
    ));
    const published = testFixture.feed.apply(upsert, context);
    expect(published).toMatchObject({
      kind: 'mutation',
      value: {
        transientRevision: 1,
        mutation: { kind: 'upsert', row: { transcript: { afterSeq: 2 } } },
      },
    });
    const action = {
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      agentOwnershipEpoch: 'owner-1',
      turnOwner: testFixture.operation.turnOwner,
      id: 'permission-1',
      incarnation: 'one',
    };
    expect(testFixture.feed.validateAction(action)).toMatchObject({ id: 'permission-1' });

    const remove = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'remove', id: 'permission-1', incarnation: 'one' },
    ));
    expect(testFixture.feed.apply(remove, context)).toMatchObject({
      kind: 'mutation',
      value: { transientRevision: 2, mutation: { kind: 'remove' } },
    });
    expect(() => testFixture.feed.validateAction(action)).toThrow(TransientControlActionError);

    const replacement = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'two', testFixture.operation) },
    ));
    expect(testFixture.feed.apply(replacement, context)).toMatchObject({
      kind: 'mutation',
      value: {
        transientRevision: 3,
        mutation: { kind: 'upsert', row: { incarnation: 'two' } },
      },
    });
  });

  it('clears the current operation before publishing its terminal lifecycle', async () => {
    const testFixture = fixture();
    const upsert = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'one', testFixture.operation) },
    ));
    testFixture.feed.apply(upsert, context);
    const terminal = await emit(testFixture.stream, () => testFixture.stream.terminal({
      operation: testFixture.operation,
      outcome: { kind: 'failed', error: { code: 'UNKNOWN', message: 'failed', retryable: false } },
      completeness: { acceptedInputEntryIds: [], attributableEntryCount: 0 },
      sourceSettlement: 'unresolved',
    }));

    expect(testFixture.feed.apply(terminal, context)).toMatchObject({
      kind: 'mutation',
      value: {
        transientRevision: 2,
        mutation: { kind: 'clear-operation', turnOwner: testFixture.operation.turnOwner },
      },
    });
    expect(testFixture.feed.currentSnapshot(CHAT_ID)?.rows).toEqual([]);
  });

  it('preserves one permission through an input-not-sent generation reset', async () => {
    const testFixture = fixture();
    const activeEntry = {
      id: newAgentTranscriptEntryId(),
      lifetime: 'active',
      source: null,
      provenance: { ...testFixture.operation, upstreamRequestId: null },
      message: new UserMessage(TIMESTAMP, 'steer'),
    };
    await testFixture.stream.commit([], [activeEntry]);
    const upsert = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'one', testFixture.operation) },
    ));
    testFixture.feed.apply(upsert, context);
    const reset = await emit(testFixture.stream, () => testFixture.stream.reset({
      reason: 'input-not-sent',
      epoch: newAgentStreamEpoch(),
      contentEpoch: testFixture.stream.current.checkpoint.projection.contentEpoch,
      entries: [],
    }));

    const transition = testFixture.feed.apply(reset, {
      previousGenerationId: 'generation-1',
      generationId: 'generation-2',
      carryOverMessageCount: 2,
    });
    expect(transition).toMatchObject({
      kind: 'generation-transition',
      value: {
        previousGenerationId: 'generation-1',
        generationId: 'generation-2',
        rows: [{ id: 'permission-1', incarnation: 'one' }],
      },
    });
  });

  it('keeps empty snapshots read-only before the first source mutation', async () => {
    const testFixture = fixture();
    expect(testFixture.feed.snapshot({
      chatId: CHAT_ID,
      agentOwnershipEpoch: 'owner-1',
      generationId: 'pending:owner-1',
    })).toMatchObject({ generationId: 'pending:owner-1', transientRevision: 0, rows: [] });
    expect(testFixture.feed.currentSnapshot(CHAT_ID)).toBeNull();
    const upsert = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'one', testFixture.operation) },
    ));

    expect(testFixture.feed.apply(upsert, context)).toMatchObject({
      kind: 'mutation',
      value: {
        generationId: 'generation-1',
        transientRevision: 1,
        mutation: { kind: 'upsert', row: { id: 'permission-1' } },
      },
    });
  });

  it('rejects stale server, ownership, turn, and incarnation action fences', async () => {
    const testFixture = fixture();
    const upsert = await emit(testFixture.stream, () => testFixture.stream.control(
      testFixture.operation,
      { kind: 'upsert', row: permission('permission-1', 'one', testFixture.operation) },
    ));
    testFixture.feed.apply(upsert, context);
    const valid = {
      serverInstanceId: 'server-1',
      chatId: CHAT_ID,
      agentOwnershipEpoch: 'owner-1',
      turnOwner: testFixture.operation.turnOwner,
      id: 'permission-1',
      incarnation: 'one',
    };

    for (const action of [
      { ...valid, serverInstanceId: 'server-2' },
      { ...valid, agentOwnershipEpoch: 'owner-2' },
      { ...valid, turnOwner: { ...valid.turnOwner, turnId: 'turn-2' } },
      { ...valid, incarnation: 'two' },
    ]) {
      expect(() => testFixture.feed.validateAction(action)).toThrow(TransientControlActionError);
    }
  });
});
