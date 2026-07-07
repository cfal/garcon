import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'fs';
import os from 'os';
import path from 'path';
import { ChatCarryOverStore } from '../chat-carryover-store.js';
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

  it('persists and reloads segments via a temp file', async () => {
    const filePath = path.join(tmpDir, 'chat-carryover.json');
    const store = new ChatCarryOverStore({ filePath, saveDelayMs: 0 });
    await store.init();

    store.appendSegment('chat-1', segment('codex', 'gpt-5', new UserMessage(ts, 'persisted question')));
    await store.flush();

    const raw = JSON.parse(await fs.readFile(filePath, 'utf8'));
    expect(raw.version).toBe(1);
    expect(raw.chats['chat-1'][0].agentId).toBe('codex');

    const reloaded = new ChatCarryOverStore({ filePath });
    await reloaded.init();
    const messages = reloaded.getMessages('chat-1');
    expect(messages.length).toBe(1);
    expect(messages[0].content).toBe('persisted question');
    expect(messages[0].type).toBe('user-message');
  });
});
