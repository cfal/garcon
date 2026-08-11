import { describe, expect, it } from 'bun:test';
import { AgentProjectionIngress } from '../agents/projection-ingress.js';
import { createProjectionEventFanout } from '../projection-event-fanout.js';
import { ChatViewStore } from '../chats/chat-view-store.js';
import { ChatTransientFeedStore } from '../chats/chat-transient-feed.js';
import { AssistantMessage, UserMessage } from '../../common/chat-types.js';
import { AgentProjectionEventStream } from '@garcon/server-agent-common/transcript-projection/stream';
import { createProjectionMaterialization } from '@garcon/server-agent-common/transcript-projection/state';
import { sameProjectionState } from '@garcon/server-agent-common/transcript-projection/identity';
import {
  transcriptSnapshot,
  testProjectionState,
} from '../chats/__tests__/chat-transcript-test-helpers.js';

const TS = '2026-06-01T00:00:00.000Z';
const CHAT_ID = 'chat-1';
const OWNERSHIP = 'ownership-1';

function turnOwner(turnId = 'turn-1') {
  return {
    agentOwnershipEpoch: OWNERSHIP,
    commandType: 'agent-run',
    clientRequestId: `request-${turnId}`,
    turnId,
  };
}

function provenance(owner = turnOwner()) {
  return {
    agentOwnershipEpoch: OWNERSHIP,
    commandType: owner.commandType,
    clientRequestId: owner.clientRequestId,
    clientMessageId: null,
    turnId: owner.turnId,
    turnOwner: owner,
    upstreamRequestId: null,
  };
}

function entry(id, message, lifetime = 'durable', entryProvenance = provenance()) {
  return {
    id,
    lifetime,
    source: lifetime === 'durable'
      ? { namespace: 'fake:native', itemId: id, subrowId: 'row:0' }
      : null,
    provenance: entryProvenance,
    message,
  };
}

// A journal-less integration built on the real shared event stream, so every
// delivered event carries reducer-valid checkpoints and digests.
function fakeIntegration() {
  const listeners = new Set();
  const stream = new AgentProjectionEventStream({
    initial: createProjectionMaterialization({
      chatId: CHAT_ID,
      agentOwnershipEpoch: OWNERSHIP,
      epoch: 'fake-stream-epoch-1',
      contentEpoch: 'fake-content-epoch-1',
      entries: [],
    }),
  });
  stream.subscribe((event) => {
    for (const listener of listeners) listener(event);
  });
  const integration = {
    descriptor: { id: 'fake' },
    transcript: {
      subscribe(listener) {
        listeners.add(listener);
        return () => listeners.delete(listener);
      },
      async openSegment() {
        return { kind: 'ready', value: { checkpoint: stream.current.checkpoint, idle: true } };
      },
      async loadPage({ expectedProjection, beforeOrdinal, limit }) {
        const current = stream.current;
        const projection = current.checkpoint.projection;
        if (expectedProjection && !sameProjectionState(expectedProjection, projection)) {
          return { kind: 'expired', current: projection };
        }
        const end = beforeOrdinal === null ? current.entries.length : beforeOrdinal - 1;
        const start = Math.max(0, end - limit);
        return {
          kind: 'ready',
          page: {
            projection,
            entries: current.entries.slice(start, end),
            firstOrdinal: start + 1,
            hasMore: start > 0,
          },
        };
      },
      async replay() {
        return { kind: 'expired', checkpoint: stream.current.checkpoint };
      },
      async commitOffset() {},
    },
  };
  return { integration, stream };
}

async function fixture({ carryOver = [] } = {}) {
  const { integration, stream } = fakeIntegration();
  const ingress = new AgentProjectionIngress([integration]);
  const chat = { chatId: CHAT_ID, agentOwnershipEpoch: OWNERSHIP };
  const views = new ChatViewStore(() => false);
  const transientFeeds = new ChatTransientFeedStore('server-instance-test');
  const broadcasts = [];
  const tasks = { tail: Promise.resolve() };
  const composite = (messages, projectionState) => transcriptSnapshot(
    [...carryOver, ...messages],
    { archivedLogicalCount: carryOver.length, projectionState },
  );
  const fanout = createProjectionEventFanout({
    chatExists: () => true,
    scheduleChatTask: (_chatId, _label, task) => {
      const next = tasks.tail.then(task);
      tasks.tail = next.catch(() => {});
      return next;
    },
    broadcast: (payload) => broadcasts.push(payload),
    chatRegistry: {
      getChat: () => ({ agentOwnershipEpoch: OWNERSHIP, transcriptContentEpoch: null }),
      updateChat: async () => undefined,
    },
    chatViews: views,
    transientFeeds,
    metadata: { updateFromAppendedMessages: () => undefined },
    commandLedger: { appendProjectionAssistantMessages: async () => undefined },
    pendingInputs: { reconcileRetainedHistory: async () => undefined },
    markSearchChatDirty: () => undefined,
    markSearchCatalogDirty: () => undefined,
    getCarryOverMessageCount: async () => carryOver.length,
    composeProjectionSnapshot: async (_chatId, messages, _revision, projectionState) => (
      composite(messages, projectionState)
    ),
    // Registry-backed readers observe the ingress record, which is still the
    // event predecessor while a commit is being applied.
    loadChatSnapshot: async () => {
      const materialization = ingress.current(chat);
      return composite(
        materialization?.entries.map((record) => record.message) ?? [],
        materialization?.checkpoint.projection ?? null,
      );
    },
    loadChatPage: async () => null,
  });
  ingress.onApply(async (applied) => {
    await fanout(applied);
  });
  const opened = await ingress.open(integration, chat, new AbortController().signal);
  expect(opened.kind).toBe('ready');
  return { stream, views, broadcasts, tasks, ingress, chat };
}

async function settle(tasks) {
  for (let round = 0; round < 12; round += 1) {
    await tasks.tail;
    await new Promise((resolve) => setTimeout(resolve, 0));
  }
}

function viewContents(views, limit = 20) {
  return views.readPage(CHAT_ID, limit).messages.map((row) => row.message.content);
}

describe('projection fanout relist under real ingress ordering', () => {
  it('includes the first commit when no view is loaded', async () => {
    const { stream, views, broadcasts, tasks } = await fixture();

    await stream.commit([], [entry('entry-1', new AssistantMessage(TS, 'first row'))]);
    await settle(tasks);

    expect(viewContents(views)).toEqual(['first row']);
    const transition = broadcasts.find((message) => (
      message.type === 'chat-projection-generation-transition'
    ));
    expect(transition).toBeDefined();
    const relistedGeneration = views.getCursor(CHAT_ID).generationId;
    expect(transition.generationId).toBe(relistedGeneration);
    // A cold first admission still broadcasts its committed row so observers
    // and background caches see it before provider execution starts.
    const coldRows = broadcasts.filter((message) => message.type === 'chat-messages');
    expect(coldRows).toHaveLength(1);
    expect(coldRows[0].generationId).toBe(relistedGeneration);
    expect(coldRows[0].messages.map((row) => [row.seq, row.message.content]))
      .toEqual([[1, 'first row']]);
    expect(broadcasts.indexOf(transition)).toBeLessThan(broadcasts.indexOf(coldRows[0]));

    // The relisted view holds the checkpoint state, so the next commit applies
    // exactly and broadcasts its row without relisting again.
    await stream.commit([], [entry('entry-2', new AssistantMessage(TS, 'second row'))]);
    await settle(tasks);
    expect(viewContents(views)).toEqual(['first row', 'second row']);
    const rows = broadcasts.filter((message) => message.type === 'chat-messages');
    expect(rows).toHaveLength(2);
    expect(rows[1].messages.map((row) => [row.seq, row.message.content]))
      .toEqual([[2, 'second row']]);
  });

  it('includes the applied commit when the loaded view is stale', async () => {
    const carryOver = [new UserMessage(TS, 'archived prompt')];
    const { stream, views, broadcasts, tasks } = await fixture({ carryOver });
    await stream.commit([], [entry('entry-1', new AssistantMessage(TS, 'existing row'))]);
    await settle(tasks);
    views.invalidate(CHAT_ID);
    await views.getOrCreatePage(CHAT_ID, {
      loadAll: async () => transcriptSnapshot(
        [...carryOver, new AssistantMessage(TS, 'existing row')],
        {
          archivedLogicalCount: carryOver.length,
          projectionState: testProjectionState(1, { epoch: 'divergent-epoch' }),
        },
      ),
    }, 20);
    broadcasts.length = 0;

    await stream.commit([], [entry('entry-2', new AssistantMessage(TS, 'missing without fix'))]);
    await settle(tasks);

    expect(viewContents(views)).toEqual([
      'archived prompt',
      'existing row',
      'missing without fix',
    ]);
    expect(broadcasts.some((message) => (
      message.type === 'chat-projection-generation-transition'
    ))).toBe(true);
    // The relist rebroadcasts the applied commit rows at their carryover-based
    // seqs under the fresh generation.
    const rows = broadcasts.filter((message) => message.type === 'chat-messages');
    expect(rows).toHaveLength(1);
    expect(rows[0].generationId).toBe(views.getCursor(CHAT_ID).generationId);
    expect(rows[0].messages.map((row) => [row.seq, row.message.content]))
      .toEqual([[3, 'missing without fix']]);
  });

  it('advances a relisted view to the checkpoint of a promotion-only commit', async () => {
    const { stream, views, broadcasts, tasks } = await fixture();
    const owner = turnOwner('turn-active');
    await stream.commit([], [entry(
      'entry-active',
      new UserMessage(TS, 'admitted input', undefined, {
        clientRequestId: owner.clientRequestId,
      }),
      'active',
      provenance(owner),
    )]);
    await settle(tasks);
    views.invalidate(CHAT_ID);
    await views.getOrCreatePage(CHAT_ID, {
      loadAll: async () => transcriptSnapshot([new UserMessage(TS, 'admitted input')], {
        projectionState: testProjectionState(1, { epoch: 'divergent-epoch' }),
      }),
    }, 20);
    broadcasts.length = 0;

    await stream.commit([{
      entryId: 'entry-active',
      source: { namespace: 'garcon:admission', itemId: owner.clientRequestId, subrowId: 'user' },
    }], []);
    await settle(tasks);

    expect(viewContents(views)).toEqual(['admitted input']);
    expect(broadcasts.some((message) => (
      message.type === 'chat-projection-generation-transition'
    ))).toBe(true);
    // A promotion-only relist has no appended rows to rebroadcast.
    expect(broadcasts.filter((message) => message.type === 'chat-messages')).toHaveLength(0);

    // The promotion checkpoint is now the view state, so the next append is exact.
    await stream.commit([], [entry('entry-next', new AssistantMessage(TS, 'after promotion'))]);
    await settle(tasks);
    expect(viewContents(views)).toEqual(['admitted input', 'after promotion']);
    expect(broadcasts.filter((message) => message.type === 'chat-messages')).toHaveLength(1);
  });
});
