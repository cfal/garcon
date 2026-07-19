import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatCarryOverStore, renderCarriedTranscript } from '../chat-carryover-store.js';
import { UserMessage, AssistantMessage } from '../../../common/chat-types.js';

const ts = '2026-01-01T00:00:00Z';

function segment(agentId, model, ...messages) {
  return { agentId, model, messages };
}

describe('chat-carryover-store', () => {
  let tmpDir;

  beforeEach(async () => {
    tmpDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-carryover-test-'));
  });

  afterEach(async () => {
    await fs.rm(tmpDir, { recursive: true, force: true });
  });

  it('appends segments and reads them back in order', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'first')));
    store.appendSegment('chat-1', segment('claude', 'opus', new AssistantMessage(ts, 'second')));

    const segments = store.getSegments('chat-1');
    expect(segments.length).toBe(2);
    expect(segments[0].agentId).toBe('codex');
    expect(segments[1].agentId).toBe('claude');
    expect(typeof segments[0].at).toBe('string');
  });

  it('flattens messages across segments in order', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'a'), new AssistantMessage(ts, 'b')));
    store.appendSegment('chat-1', segment('claude', 'opus', new UserMessage(ts, 'c')));

    const messages = store.getMessages('chat-1');
    expect(messages.map((m) => m.content)).toEqual(['a', 'b', 'c']);
  });

  it('copies segments from source to target', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();

    store.appendSegment('src', segment('codex', 'gpt-5', new UserMessage(ts, 'hello')));
    store.copy('src', 'dst');

    expect(store.getMessages('dst').map((m) => m.content)).toEqual(['hello']);
    // Copy is independent: mutating the source does not affect the target.
    store.appendSegment('src', segment('claude', 'opus', new UserMessage(ts, 'more')));
    expect(store.getMessages('dst').length).toBe(1);
  });

  it('clears segments for a chat', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'x')));
    store.clear('chat-1');
    expect(store.getSegments('chat-1')).toEqual([]);
  });

  it('interleaves agent-switch boundaries between segments and before the current agent', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'a')));
    store.appendSegment('chat-1', segment('claude', 'opus', new AssistantMessage(ts, 'b')));

    const rendered = renderCarriedTranscript(store.getSegments('chat-1'), {
      agentId: 'codex',
      model: 'gpt-5.5',
    });
    expect(rendered.map((m) => m.type)).toEqual([
      'user-message',
      'agent-switch',
      'assistant-message',
      'agent-switch',
    ]);

    const [, firstBoundary, , lastBoundary] = rendered;
    expect(firstBoundary.fromAgentId).toBe('codex');
    expect(firstBoundary.toAgentId).toBe('claude');
    expect(firstBoundary.toModel).toBe('opus');
    expect(lastBoundary.fromAgentId).toBe('claude');
    expect(lastBoundary.toAgentId).toBe('codex');
    expect(lastBoundary.toModel).toBe('gpt-5.5');
  });

  it('renders no boundaries when there are no segments', () => {
    expect(renderCarriedTranscript([], { agentId: 'codex', model: 'gpt-5' })).toEqual([]);
  });

  it('persists and reloads segments via a temp file', async () => {
    const filePath = path.join(tmpDir, 'chat-carryover.json');
    const store = new ChatCarryOverStore({ filePath, saveDelayMs: 0 });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'persisted question')));
    await store.flush();

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.version).toBe(4);
    expect(raw.chats['chat-1'].revision).toBe(1);
    expect(raw.chats['chat-1'].segments[0].agentId).toBe('codex');
    expect(store.getSearchDescriptor('chat-1')).toEqual({ filePath, chatRevision: 1 });

    const reloaded = new ChatCarryOverStore({ filePath });
    await reloaded.init();
    const messages = reloaded.getMessages('chat-1');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('persisted question');
    expect(messages[0].type).toBe('user-message');
  });

  it('migrates v1 entries and advances only the changed chat revision', async () => {
    const filePath = path.join(tmpDir, 'chat-carryover.json');
    await fs.writeFile(filePath, JSON.stringify({
      version: 1,
      chats: {
        first: [segment('codex', 'gpt-5', new UserMessage(ts, 'first'))],
        second: [segment('claude', 'sonnet', new UserMessage(ts, 'second'))],
      },
    }));
    const store = new ChatCarryOverStore({ filePath, saveDelayMs: 0 });
    await store.init();
    expect(store.getSearchDescriptor('first')?.chatRevision).toBe(1);
    expect(store.getSearchDescriptor('second')?.chatRevision).toBe(1);

    store.appendSegment('first', segment('codex', 'gpt-5', new UserMessage(ts, 'next')));
    await store.flush();
    expect(store.getSearchDescriptor('first')?.chatRevision).toBe(2);
    expect(store.getSearchDescriptor('second')?.chatRevision).toBe(1);
    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.version).toBe(4);
  });

  it('keeps staged fork carry-over hidden until the target ownership epoch commits', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();
    const chats = new Map();
    store.bindRegistry({
      getChat: (chatId) => chats.get(chatId) ?? null,
      onChatRemoved() {},
    });
    store.appendSegment('source', segment(
      'alpha',
      'model-a',
      new UserMessage(ts, 'first'),
      new AssistantMessage(ts, 'second'),
    ));
    store.appendSegment('source', segment('beta', 'model-b', new UserMessage(ts, 'third')));

    await store.stageFork({
      sourceChatId: 'source',
      targetChatId: 'target',
      targetEpoch: 'target-epoch',
      ownerId: 'gamma',
      ownerModel: 'model-c',
      upToSequence: 3,
    });
    expect(store.getMessages('target')).toEqual([]);

    chats.set('target', { agentId: 'gamma', agentOwnershipEpoch: 'target-epoch' });
    const stagedRendered = renderCarriedTranscript(store.getSegments('target'), {
      agentId: 'gamma',
      model: 'model-c',
    });
    expect(stagedRendered.map((message) => message.type)).toEqual([
      'user-message',
      'assistant-message',
      'agent-switch',
    ]);
    expect(stagedRendered[2]).toMatchObject({ fromAgentId: 'alpha', toAgentId: 'beta' });

    await store.promoteStaged('target', 'target-epoch');
    chats.delete('target');
    expect(store.getMessages('target').map((message) => message.content)).toEqual(['first', 'second']);
  });

  it('preserves an exact message cutoff inside carry-over and discards abandoned staging', async () => {
    const store = new ChatCarryOverStore({ filePath: null });
    await store.init();
    const chats = new Map();
    store.bindRegistry({
      getChat: (chatId) => chats.get(chatId) ?? null,
      onChatRemoved() {},
    });
    store.appendSegment('source', segment(
      'alpha',
      'model-a',
      new UserMessage(ts, 'first'),
      new AssistantMessage(ts, 'second'),
    ));

    await store.stageFork({
      sourceChatId: 'source',
      targetChatId: 'target',
      targetEpoch: 'target-epoch',
      ownerId: 'alpha',
      ownerModel: 'model-a',
      upToSequence: 1,
    });
    chats.set('target', { agentId: 'alpha', agentOwnershipEpoch: 'target-epoch' });
    expect(renderCarriedTranscript(store.getSegments('target'), {
      agentId: 'alpha',
      model: 'model-a',
    }).map((message) => message.type)).toEqual(['user-message']);

    await store.discardStaged('target', 'target-epoch');
    expect(store.getMessages('target')).toEqual([]);
  });

  it('promotes committed staged forks during recovery', async () => {
    const filePath = path.join(tmpDir, 'chat-carryover.json');
    const store = new ChatCarryOverStore({ filePath, saveDelayMs: 0 });
    await store.init();
    store.appendSegment('source', segment('alpha', 'model-a', new UserMessage(ts, 'first')));
    await store.stageFork({
      sourceChatId: 'source',
      targetChatId: 'target',
      targetEpoch: 'target-epoch',
      ownerId: 'alpha',
      ownerModel: 'model-a',
    });
    store.bindRegistry({
      getChat: (chatId) => chatId === 'target'
        ? { agentId: 'alpha', agentOwnershipEpoch: 'target-epoch' }
        : null,
      onChatRemoved() {},
    });

    await store.promoteCommittedStaged();
    const persisted = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(persisted.chats.target.staged).toBeUndefined();
    expect(store.getMessages('target')).toHaveLength(1);
  });
});
