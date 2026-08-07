import { afterEach, beforeEach, describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage } from '../../../common/chat-types.js';
import { writeJsonFileAtomic } from '../../lib/json-file-store.js';
import {
  CarryOverTranscriptError,
  CarryOverTranscriptStore,
} from '../carryover-transcript-store.ts';

const FIRST = '7f1bb17c-0cc5-4a0d-b762-2c14b04c5f2e';
const SECOND = 'd5f2380b-6228-49f5-8484-b2d7e16380ab';
const PREFIX = 'b74d65dc-54b0-49eb-a67f-8178f31fe72c';
const OPERATION = 'operation:test';
const TIMESTAMP = '2026-01-01T00:00:00.000Z';

describe('CarryOverTranscriptStore', () => {
  let workspaceDir;
  let store;

  beforeEach(async () => {
    workspaceDir = await fs.mkdtemp(path.join(os.tmpdir(), 'garcon-linked-carryover-'));
    store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
  });

  afterEach(async () => {
    await fs.rm(workspaceDir, { recursive: true, force: true });
  });

  it('writes immutable paged nodes and reads chronological boundaries', async () => {
    const firstMessages = Array.from(
      { length: 257 },
      (_, index) => new UserMessage(TIMESTAMP, `first ${index}`),
    );
    await commitMaterialized(store, {
      id: FIRST,
      parentId: null,
      agentId: 'codex',
      model: 'gpt',
      targetAgentId: 'claude',
      targetModel: 'opus',
      messages: firstMessages,
    });
    await commitMaterialized(store, {
      id: SECOND,
      parentId: FIRST,
      agentId: 'claude',
      model: 'opus',
      targetAgentId: 'pi',
      targetModel: 'kimi',
      messages: [new AssistantMessage(TIMESTAMP, 'second')],
    });

    const firstManifest = await store.readManifest(FIRST);
    expect(firstManifest.kind).toBe('materialized');
    expect(firstManifest.pages).toHaveLength(2);
    expect(await store.logicalMessageCount(SECOND)).toBe(260);

    const all = await store.loadAll(SECOND, { agentId: 'pi', model: 'kimi' });
    expect(all).toHaveLength(260);
    expect(all[257]).toMatchObject({
      type: 'agent-switch',
      fromAgentId: 'codex',
      toAgentId: 'claude',
    });
    expect(all.at(-1)).toMatchObject({
      type: 'agent-switch',
      fromAgentId: 'claude',
      toAgentId: 'pi',
    });
    expect(store.revision(SECOND)).toBe(`carry-v2:${SECOND}`);
  });

  it('loads bounded pages without changing logical sequence positions', async () => {
    await commitMaterialized(store, {
      id: FIRST,
      parentId: null,
      agentId: 'a',
      model: 'one',
      targetAgentId: 'b',
      targetModel: 'two',
      messages: [
        new UserMessage(TIMESTAMP, 'one'),
        new AssistantMessage(TIMESTAMP, 'two'),
        new UserMessage(TIMESTAMP, 'three'),
      ],
    });

    const page = await store.loadPage({
      headId: FIRST,
      current: { agentId: 'b', model: 'two' },
      offset: 1,
      limit: 2,
    });
    expect(page.messages.map((message) => message.content)).toEqual(['two', 'three']);
    expect(page).toMatchObject({ total: 4, offset: 1, limit: 2, hasMore: true });
  });

  it('allows one oversized message in its own page', async () => {
    await commitMaterialized(store, {
      id: FIRST,
      parentId: null,
      agentId: 'a',
      model: 'one',
      targetAgentId: 'b',
      targetModel: 'two',
      messages: [new UserMessage(TIMESTAMP, 'x'.repeat(1024 * 1024 + 20))],
    });
    const manifest = await store.readManifest(FIRST);
    expect(manifest.pages).toHaveLength(1);
    expect((await store.loadAll(FIRST, { agentId: 'b', model: 'two' }))[0].content.length)
      .toBe(1024 * 1024 + 20);
  });

  it('creates no-boundary prefix nodes for exact historical cutoffs', async () => {
    await commitMaterialized(store, {
      id: FIRST,
      parentId: null,
      agentId: 'a',
      model: 'one',
      targetAgentId: 'b',
      targetModel: 'two',
      messages: [
        new UserMessage(TIMESTAMP, 'one'),
        new UserMessage(TIMESTAMP, 'two'),
        new UserMessage(TIMESTAMP, 'three'),
      ],
    });
    expect(await store.resolveCutoff(FIRST, 2)).toEqual({
      kind: 'prefix', sourceNodeId: FIRST, messageCount: 2,
    });
    const prepared = await store.preparePrefix({
      operationId: OPERATION,
      id: PREFIX,
      sourceNodeId: FIRST,
      messageCount: 2,
    });
    await prepared.commit();
    prepared.releaseRoot();

    const messages = await store.loadAll(PREFIX, { agentId: 'b', model: 'two' });
    expect(messages.map((message) => message.content)).toEqual(['one', 'two']);
    expect(messages.every((message) => message.type !== 'agent-switch')).toBeTrue();
    expect(await store.resolveCutoff(FIRST, 4)).toEqual({ kind: 'reuse', headId: FIRST });
  });

  it('detects corrupt pages and remembers degraded nodes during preflight', async () => {
    await commitMaterialized(store, {
      id: FIRST,
      parentId: null,
      agentId: 'a',
      model: 'one',
      targetAgentId: 'b',
      targetModel: 'two',
      messages: [new UserMessage(TIMESTAMP, 'one')],
    });
    const manifest = await store.readManifest(FIRST);
    await fs.writeFile(
      path.join(workspaceDir, 'carryover-transcripts', 'nodes', FIRST, manifest.pages[0].file),
      Buffer.from('not brotli'),
    );

    await expect(store.loadAll(FIRST, { agentId: 'b', model: 'two' }))
      .rejects.toBeInstanceOf(CarryOverTranscriptError);
    await expect(store.assertReachableForHandoff(FIRST))
      .rejects.toMatchObject({ code: 'CARRYOVER_HISTORY_UNAVAILABLE' });
  });

  it('rejects missing references, cycles, unsafe page paths, and aborted reads', async () => {
    const nodeDir = path.join(workspaceDir, 'carryover-transcripts', 'nodes', FIRST);
    await fs.mkdir(nodeDir, { recursive: true });
    await writeJsonFileAtomic(path.join(nodeDir, 'manifest.json'), {
      version: 1,
      kind: 'prefix',
      id: FIRST,
      parentId: SECOND,
      createdAt: TIMESTAMP,
      sourceNodeId: SECOND,
      messageCount: 1,
      source: { agentId: 'a', model: 'one', nativeSessionId: null, nativeRevision: 'r1' },
    });
    await expect(store.assertReachableForHandoff(FIRST))
      .rejects.toMatchObject({ code: 'CARRYOVER_HISTORY_UNAVAILABLE' });

    const controller = new AbortController();
    controller.abort();
    await expect(store.logicalMessageCount(FIRST, controller.signal)).rejects.toThrow();
  });

  it('keeps prepared nodes rooted until their durable owner releases them', async () => {
    const prepared = await store.prepareMaterialized(materializedRequest({
      id: FIRST,
      parentId: null,
      agentId: 'a',
      model: 'one',
      targetAgentId: 'b',
      targetModel: 'two',
      messages: [new UserMessage(TIMESTAMP, 'one')],
    }));
    expect(store.writerRoots()).toContain(FIRST);
    await prepared.commit();
    expect(store.writerRoots()).toContain(FIRST);
    prepared.releaseRoot();
    expect(store.writerRoots()).not.toContain(FIRST);
  });
});

async function commitMaterialized(store, input) {
  const prepared = await store.prepareMaterialized(materializedRequest(input));
  await prepared.commit();
  prepared.releaseRoot();
}

function materializedRequest(input) {
  return {
    operationId: OPERATION,
    id: input.id,
    parentId: input.parentId,
    source: {
      agentId: input.agentId,
      model: input.model,
      nativeSessionId: `${input.agentId}-session`,
      nativeRevision: `${input.id}-revision`,
    },
    boundary: {
      kind: 'handoff',
      targetAtCapture: { agentId: input.targetAgentId, model: input.targetModel },
    },
    seedSanitation: 'not-applicable',
    messages: input.messages,
  };
}
