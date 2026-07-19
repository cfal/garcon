import { afterEach, describe, expect, it } from 'bun:test';
import { mkdir, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import type { AgentHost, AgentSearchChat } from '@garcon/server-agent-interface';
import { createTranscriptSearch } from '../transcript-search.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('common transcript search', () => {
  it('does not allocate storage for an empty integration snapshot', async () => {
    const fixture = await createFixture();
    await fixture.search.reconcile({ chats: [], generation: generation(1), signal: signal() });
    expect(await Bun.file(path.join(fixture.root, 'transcript-search', 'index.sqlite')).exists()).toBe(false);
    await fixture.search.close();
  });

  it('indexes native and carried messages, filters scope, and prunes complete snapshots', async () => {
    const fixture = await createFixture({
      native: {
        one: [new UserMessage(timestamp, 'native alpha'), new AssistantMessage(timestamp, 'assistant beta')],
        two: [new UserMessage(timestamp, 'other alpha')],
      },
      carried: { one: [new UserMessage(timestamp, 'carried gamma')] },
    });
    await fixture.search.reconcile({
      chats: [chat('one', 'carry-v1:1'), chat('two')],
      generation: generation(1),
      signal: signal(),
    });

    const alpha = await fixture.search.search({
      query: query('alpha'),
      chats: [chat('one', 'carry-v1:1')],
      limit: 20,
      signal: signal(),
    });
    expect(alpha.hits.map((hit) => hit.chatId)).toEqual(['one']);

    const carried = await fixture.search.search({
      query: query('gamma'),
      chats: [chat('one', 'carry-v1:1')],
      limit: 20,
      signal: signal(),
    });
    expect(carried.hits).toHaveLength(1);
    expect(carried.hits[0].matchedMessageCount).toBe(1);

    await fixture.search.reconcile({
      chats: [chat('two')],
      generation: generation(2),
      signal: signal(),
    });
    const pruned = await fixture.search.search({
      query: query('gamma'),
      chats: [chat('one', 'carry-v1:1'), chat('two')],
      limit: 20,
      signal: signal(),
    });
    expect(pruned.hits).toEqual([]);
    await fixture.search.close();
  });

  it('returns only the matching chat when several indexed chats are allowed', async () => {
    const fixture = await createFixture({
      native: {
        one: [new UserMessage(timestamp, 'ordinary first transcript')],
        two: [new UserMessage(timestamp, 'contains uniqueonly marker')],
        three: [new UserMessage(timestamp, 'ordinary third transcript')],
      },
    });
    const chats = [chat('one'), chat('two'), chat('three')];
    await fixture.search.reconcile({ chats, generation: generation(1), signal: signal() });

    const result = await fixture.search.search({
      query: query('uniqueonly'),
      chats,
      limit: 20,
      signal: signal(),
    });

    expect(result.hits.map((hit) => hit.chatId)).toEqual(['two']);
    expect(result.index).toEqual({
      indexedChatCount: 3,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    });
    await fixture.search.close();
  });

  it('rejects stale reconcile completion after a newer generation is accepted', async () => {
    let releaseFirst: (() => void) | null = null;
    let firstStarted: (() => void) | null = null;
    const firstStartedPromise = new Promise<void>((resolve) => { firstStarted = resolve; });
    const firstReleasePromise = new Promise<void>((resolve) => { releaseFirst = resolve; });
    let loads = 0;
    const fixture = await createFixture({
      load: async () => {
        loads += 1;
        if (loads === 1) {
          firstStarted?.();
          await firstReleasePromise;
          return [new UserMessage(timestamp, 'stale token')];
        }
        return [new UserMessage(timestamp, 'fresh token')];
      },
    });

    const stale = fixture.search.reconcile({
      chats: [chat('one')],
      generation: generation(1),
      signal: signal(),
    });
    await firstStartedPromise;
    const fresh = fixture.search.reconcile({
      chats: [chat('one')],
      generation: generation(2),
      signal: signal(),
    });
    releaseFirst?.();
    await Promise.all([stale, fresh]);

    expect((await fixture.search.search({
      query: query('fresh'), chats: [chat('one')], limit: 10, signal: signal(),
    })).hits).toHaveLength(1);
    expect((await fixture.search.search({
      query: query('stale'), chats: [chat('one')], limit: 10, signal: signal(),
    })).hits).toHaveLength(0);
    await fixture.search.close();
  });

  it('awaits admitted reads during cleanup and rejects later reads without reopening storage', async () => {
    const fixture = await createFixture({
      native: { one: [new UserMessage(timestamp, 'cleanup token')] },
    });
    await fixture.search.reconcile({ chats: [chat('one')], generation: generation(1), signal: signal() });
    const admitted = fixture.search.search({
      query: query('cleanup'), chats: [chat('one')], limit: 10, signal: signal(),
    });
    const cleanup = fixture.search.disableAndDelete({ generation: generation(2), signal: signal() });
    await expect(admitted).resolves.toMatchObject({ hits: [{ chatId: 'one' }] });
    await cleanup;
    expect(await Bun.file(path.join(fixture.root, 'transcript-search', 'index.sqlite')).exists()).toBe(false);
    expect(() => fixture.search.search({
      query: query('cleanup'), chats: [chat('one')], limit: 10, signal: signal(),
    })).toThrow('Transcript search is disabled');
  });

  it('reports pending and failed chats while preserving successful status', async () => {
    let release: (() => void) | null = null;
    let started: (() => void) | null = null;
    const startedPromise = new Promise<void>((resolve) => { started = resolve; });
    const releasePromise = new Promise<void>((resolve) => { release = resolve; });
    const fixture = await createFixture({
      load: async (candidate) => {
        if (candidate.chatId === 'pending') {
          started?.();
          await releasePromise;
          return [new UserMessage(timestamp, 'indexed later')];
        }
        throw new Error('unreadable transcript');
      },
    });
    const reconcile = fixture.search.reconcile({
      chats: [chat('pending'), chat('failed')],
      generation: generation(1),
      signal: signal(),
    });
    await startedPromise;
    expect(await fixture.search.status({
      chats: [chat('pending'), chat('failed')],
      signal: signal(),
    })).toMatchObject({ pendingChatCount: 2, indexedChatCount: 0 });
    release?.();
    await reconcile;
    expect(await fixture.search.status({
      chats: [chat('pending'), chat('failed')],
      signal: signal(),
    })).toEqual({
      indexedChatCount: 1,
      pendingChatCount: 0,
      failedChatCount: 1,
      unsupportedChatCount: 0,
    });
    await fixture.search.close();
  });

  it('rebases generations after restart and reuses the durable index', async () => {
    let body = 'before restart';
    const fixture = await createFixture({
      load: async () => [new UserMessage(timestamp, body)],
    });
    await fixture.search.reconcile({
      chats: [chat('one')],
      generation: { epoch: 'first-process', sequence: 50 },
      signal: signal(),
    });
    await fixture.search.close();

    body = 'after restart';
    const restarted = createTranscriptSearch({
      agentId: 'fixture',
      host: fixture.host,
      loadTranscript: async () => [new UserMessage(timestamp, body)],
    });
    await restarted.reconcile({
      chats: [chat('one')],
      generation: { epoch: 'second-process', sequence: 1 },
      signal: signal(),
    });
    expect((await restarted.search({
      query: query('after'),
      chats: [chat('one')],
      limit: 10,
      signal: signal(),
    })).hits).toHaveLength(1);
    expect((await restarted.search({
      query: query('before'),
      chats: [chat('one')],
      limit: 10,
      signal: signal(),
    })).hits).toHaveLength(0);
    await restarted.close();
  });

  it('keeps cleanup idempotent and rejects generations from a retired epoch', async () => {
    const fixture = await createFixture({
      native: { one: [new UserMessage(timestamp, 'retired token')] },
    });
    await fixture.search.reconcile({
      chats: [chat('one')],
      generation: { epoch: 'old', sequence: 1 },
      signal: signal(),
    });
    await fixture.search.disableAndDelete({
      generation: { epoch: 'new', sequence: 1 },
      signal: signal(),
    });
    await fixture.search.reconcile({
      chats: [chat('one')],
      generation: { epoch: 'old', sequence: 2 },
      signal: signal(),
    });
    await fixture.search.disableAndDelete({
      generation: { epoch: 'new', sequence: 2 },
      signal: signal(),
    });
    expect(await Bun.file(path.join(fixture.root, 'transcript-search', 'index.sqlite')).exists()).toBe(false);
  });
});

async function createFixture(options: {
  native?: Record<string, ChatMessage[]>;
  carried?: Record<string, ChatMessage[]>;
  load?: (chat: AgentSearchChat) => Promise<readonly ChatMessage[]>;
} = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-agent-search-'));
  roots.push(root);
  const host = {
    agentId: 'fixture',
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    storage: {
      rootDirectory: root,
      async directory(namespace: string) {
        const directory = path.join(root, namespace);
        await mkdir(directory, { recursive: true });
        return directory;
      },
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
    carryOver: {
      async load(request: { chatId: string; expectedRevision: string }) {
        return {
          revision: request.expectedRevision,
          messages: options.carried?.[request.chatId] ?? [],
        };
      },
    },
  } satisfies AgentHost;
  const search = createTranscriptSearch({
    agentId: 'fixture',
    host,
    loadTranscript: ({ chat }) => options.load?.(chat) ?? Promise.resolve(options.native?.[chat.chatId] ?? []),
  });
  return { root, host, search };
}

function chat(chatId: string, carryOverRevision = 'carry-v1:0'): AgentSearchChat {
  return {
    chatId,
    projectPath: '/repo',
    model: 'model',
    nativeSession: null,
    updatedAt: timestamp,
    carryOverRevision,
    transcriptRevision: 'native-v1',
  };
}

function generation(sequence: number) {
  return { epoch: 'test', sequence };
}

function query(text: string) {
  return {
    version: 1 as const,
    clauses: [{
      kind: 'all-words' as const,
      tokens: [{ text, normalized: text.toLowerCase(), match: 'prefix' as const }],
    }],
  };
}

function signal(): AbortSignal {
  return new AbortController().signal;
}
