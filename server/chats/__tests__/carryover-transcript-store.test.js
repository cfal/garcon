import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {
  AgentSwitchMessage,
  AssistantMessage,
  UserMessage,
} from '@garcon/common/chat-types';
import {
  CarryOverHistoryUnavailableError,
  CarryOverTranscriptStore,
} from '../carryover-transcript-store.js';

const FIRST = '11111111-1111-4111-8111-111111111111';
const SECOND = '22222222-2222-4222-8222-222222222222';
const EMPTY = '33333333-3333-4333-8333-333333333333';
const TIME = '2026-08-07T12:00:00.000Z';

describe('CarryOverTranscriptStore', () => {
  let workspaceDir;
  let store;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'carryover-segments-'));
    store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('writes independent immutable segments and renders explicit boundaries in array order', async () => {
    const firstMessages = [
      new UserMessage(TIME, 'question A'),
      new AssistantMessage(TIME, 'answer A'),
    ];
    const secondMessages = [new UserMessage(TIME, 'question B')];
    await commit(store, FIRST, firstMessages);
    await commit(store, SECOND, secondMessages);
    const refs = [
      ref(FIRST, 'a', 'model-a', firstMessages.length, { agentId: 'b', model: 'model-b' }),
      ref(SECOND, 'b', 'model-b', secondMessages.length, { agentId: 'c', model: 'model-c' }),
    ];

    const messages = await store.loadAll(refs);
    expect(messages.map((message) => message.type)).toEqual([
      'user-message',
      'assistant-message',
      'agent-switch',
      'user-message',
      'agent-switch',
    ]);
    expect(messages[2]).toEqual(new AgentSwitchMessage(TIME, 'a', 'b', 'model-a', 'model-b'));
    expect(messages[4]).toEqual(new AgentSwitchMessage(TIME, 'b', 'c', 'model-b', 'model-c'));
    expect(store.logicalMessageCount(refs)).toBe(5);
    expect(store.revision(refs)).toStartWith('carry-v5:');

    const firstIndex = await store.readIndex(FIRST);
    expect(firstIndex).toMatchObject({ id: FIRST, messageCount: 2, messageSchemaVersion: 1 });
    expect(firstIndex).not.toHaveProperty('parentId');
    expect(firstIndex).not.toHaveProperty('agentId');
    expect(firstIndex).not.toHaveProperty('model');
    expect(firstIndex).not.toHaveProperty('sourceNodeId');
  });

  it('loads bounded logical pages across payload and boundary positions', async () => {
    await commit(store, FIRST, [
      new UserMessage(TIME, 'one'),
      new AssistantMessage(TIME, 'two'),
      new UserMessage(TIME, 'three'),
    ]);
    const refs = [ref(FIRST, 'a', 'one', 3, { agentId: 'b', model: 'two' })];
    const page = await store.loadPage({ refs, offset: 1, limit: 2 });
    expect(page.messages.map((message) => message.type)).toEqual(['assistant-message', 'user-message']);
    const boundary = await store.loadPage({ refs, offset: 3, limit: 1 });
    expect(boundary.messages[0]).toBeInstanceOf(AgentSwitchMessage);
    expect(boundary.total).toBe(4);
  });

  it('represents an empty provider era without creating an artifact directory', async () => {
    const refs = [{
      id: EMPTY,
      agentId: 'b',
      model: 'model-b',
      capturedAt: TIME,
      storedMessageCount: 0,
      visibleMessageCount: 0,
      trailingHandoff: { agentId: 'c', model: 'model-c' },
    }];
    expect(await store.loadAll(refs)).toEqual([
      new AgentSwitchMessage(TIME, 'b', 'c', 'model-b', 'model-c'),
    ]);
    await expect(fs.stat(segmentDir(workspaceDir, EMPTY))).rejects.toMatchObject({ code: 'ENOENT' });
    await store.assertAvailable(refs);
  });

  it('creates point-fork cutoffs by slicing refs without writing transcript bytes', async () => {
    await commit(store, FIRST, [
      new UserMessage(TIME, 'one'),
      new AssistantMessage(TIME, 'two'),
      new UserMessage(TIME, 'three'),
    ]);
    const refs = [ref(FIRST, 'a', 'one', 3, { agentId: 'b', model: 'two' })];

    const inside = store.resolveCutoff(refs, 2);
    expect(inside).toEqual([{ ...refs[0], visibleMessageCount: 2, trailingHandoff: null }]);
    expect(await store.loadAll(inside)).toHaveLength(2);
    expect(store.resolveCutoff(refs, 4)).toEqual(refs);
    expect(await fs.readdir(path.join(workspaceDir, 'carryover-transcripts', 'segments')))
      .toEqual([FIRST]);
  });

  it('places an oversized message in one valid page', async () => {
    await commit(store, FIRST, [new UserMessage(TIME, 'x'.repeat(1_200_000))]);
    const index = await store.readIndex(FIRST);
    expect(index.pages).toHaveLength(1);
    expect((await store.loadAll([ref(FIRST, 'a', 'm', 1, null)]))[0].content)
      .toHaveLength(1_200_000);
  });

  it('detects corruption while treating cancellation as ordinary control flow', async () => {
    await commit(store, FIRST, [new UserMessage(TIME, 'one')]);
    const refs = [ref(FIRST, 'a', 'm', 1, null)];
    const controller = new AbortController();
    controller.abort();
    await expect(store.loadPage({ refs, offset: 0, limit: 1, signal: controller.signal }))
      .rejects.toMatchObject({ name: 'AbortError' });
    expect(await store.loadAll(refs)).toHaveLength(1);

    const index = await store.readIndex(FIRST);
    const pagePath = path.join(segmentDir(workspaceDir, FIRST), index.pages[0].file);
    const bytes = await fs.readFile(pagePath);
    bytes[Math.floor(bytes.length / 2)] ^= 0xff;
    await fs.writeFile(pagePath, bytes);
    await expect(store.loadAll(refs)).rejects.toBeInstanceOf(CarryOverHistoryUnavailableError);
    await expect(store.assertAvailable(refs)).rejects.toBeInstanceOf(CarryOverHistoryUnavailableError);
  });

  it('keeps writer roots until release and sweeps only direct unreferenced IDs', async () => {
    const prepared = await store.prepareSegment({
      operationId: 'writer',
      id: FIRST,
      seedSanitation: 'not-applicable',
      messages: [new UserMessage(TIME, 'one')],
    });
    await prepared.commit();
    expect(store.writerRoots()).toContain(FIRST);
    expect((await store.sweep(() => new Set())).removedSegmentCount).toBe(0);
    prepared.releaseRoot();
    expect((await store.sweep(() => new Set())).removedSegmentCount).toBe(1);
    await expect(fs.stat(segmentDir(workspaceDir, FIRST))).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('reuses an identical deterministic artifact and rejects a content collision', async () => {
    await commit(store, FIRST, [new UserMessage(TIME, 'same')]);
    const reused = await commit(store, FIRST, [new UserMessage(TIME, 'same')]);
    await reused.discard();
    expect(await store.loadAll([ref(FIRST, 'a', 'm', 1, null)]))
      .toEqual([new UserMessage(TIME, 'same')]);
    await expect(commit(store, FIRST, [new UserMessage(TIME, 'different')]))
      .rejects.toMatchObject({ code: 'CARRYOVER_SEGMENT_COLLISION' });
  });

  it('loads the whole archive in order for projection', async () => {
    const first = [new UserMessage(TIME, 'the original request')];
    for (let index = 0; index < 40; index += 1) {
      first.push(new AssistantMessage(TIME, `step ${index}`));
    }
    const second = [new UserMessage(TIME, 'the latest request')];
    await commit(store, FIRST, first);
    await commit(store, SECOND, second);
    const refs = [
      ref(FIRST, 'a', 'model-a', first.length, { agentId: 'b', model: 'model-b' }),
      ref(SECOND, 'b', 'model-b', second.length, null),
    ];

    const source = await store.loadProjectionSource({ refs });

    // Every turn crosses the segment boundary, including the agent-switch marker.
    expect(source).toHaveLength(first.length + second.length + 1);
    expect(source[0]).toEqual(new UserMessage(TIME, 'the original request'));
    expect(source.at(-1)).toEqual(new UserMessage(TIME, 'the latest request'));
    expect(source.filter((message) => message.type === 'user-message')).toHaveLength(2);
  });

  it('drops the oldest messages when the projection byte guard trips', async () => {
    const messages = Array.from({ length: 30 }, (_, index) => (
      new AssistantMessage(TIME, `payload ${index} ${'x'.repeat(200)}`)
    ));
    await commit(store, FIRST, messages);
    const refs = [ref(FIRST, 'a', 'model-a', messages.length, null)];

    const source = await store.loadProjectionSource({ refs, maxBytes: 2_000 });

    expect(source.length).toBeLessThan(messages.length);
    expect(source.at(-1)).toEqual(messages.at(-1));
  });
});

async function commit(store, id, messages) {
  const prepared = await store.prepareSegment({
    operationId: `operation:${id}`,
    id,
    seedSanitation: 'not-applicable',
    messages,
  });
  await prepared.commit();
  prepared.releaseRoot();
  return prepared;
}

function ref(id, agentId, model, count, trailingHandoff) {
  return {
    id,
    agentId,
    model,
    capturedAt: TIME,
    storedMessageCount: count,
    visibleMessageCount: count,
    trailingHandoff,
  };
}

function segmentDir(workspaceDir, id) {
  return path.join(workspaceDir, 'carryover-transcripts', 'segments', id);
}
