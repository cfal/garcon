import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { AssistantMessage, UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import { TranscriptSearchService } from '../transcript-search-service.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('TranscriptSearchService', () => {
  it('uses one indexer and one reader for a globally ranked index', async () => {
    const root = await workspace();
    const roles: string[] = [];
    const service = createService(root, {}, (role, moduleUrl) => {
      roles.push(role);
      return new Worker(moduleUrl, { name: `test-search-${role}` });
    });
    await enable(service);
    await service.reconcile(snapshot(service, 1, [
      entry('one', 'r1', [new UserMessage(timestamp, 'native alpha')]),
      entry('two', 'r1', [new AssistantMessage(timestamp, 'unique beta')]),
    ]));

    const result = await waitForSearch(service, 'unique', ['one', 'two']);

    expect(roles).toEqual(['indexer', 'reader']);
    expect(result.results.map((hit) => hit.chatId)).toEqual(['two']);
    expect(result.index.indexedChatCount).toBe(2);
    await service.close();
  });

  it('streams carry-over before native rows and filters every query by allowlist', async () => {
    const root = await workspace();
    const carried = {
      one: [new UserMessage(timestamp, 'carried gamma')],
    };
    const service = createService(root, carried);
    await enable(service);
    await service.reconcile(snapshot(service, 1, [
      entry('one', 'r1', [new UserMessage(timestamp, 'native alpha')], 'carry-v1:1'),
      entry('two', 'r1', [new UserMessage(timestamp, 'other gamma')]),
    ]));

    const result = await waitForSearch(service, 'gamma', ['one']);

    expect(result.results.map((hit) => hit.chatId)).toEqual(['one']);
    await service.close();
  });

  it('returns from reconciliation before a provider load completes', async () => {
    const root = await workspace();
    const service = createService(root);
    await enable(service);

    const started = performance.now();
    await service.reconcile(snapshot(service, 1, [entry('one', 'r1', [
      new UserMessage(timestamp, 'background token'),
    ])]));

    expect(performance.now() - started).toBeLessThan(1_000);
    await expect(waitForSearch(service, 'background', ['one'])).resolves.toMatchObject({
      results: [{ chatId: 'one' }],
    });
    await service.close();
  });

  it('reuses sealed rows after restart and deletes all shared artifacts when disabled', async () => {
    const root = await workspace();
    const first = createService(root);
    await enable(first);
    await first.reconcile(snapshot(first, 1, [entry('one', 'r1', [
      new UserMessage(timestamp, 'durable token'),
    ])]));
    await waitForSearch(first, 'durable', ['one']);
    await first.close();

    const restarted = createService(root);
    await enable(restarted);
    const durable = await restarted.search({
      query: query('durable'),
      allowedChatIds: ['one'],
      limit: 20,
      signal: new AbortController().signal,
    });
    expect(durable.results.map((hit) => hit.chatId)).toEqual(['one']);

    await restarted.disableAndDelete(new AbortController().signal);
    expect(await Bun.file(path.join(root, 'transcript-search', 'index.sqlite')).exists()).toBe(false);
    await restarted.close();
  });

  it('atomically replaces one changed chat without retaining stale matches', async () => {
    const root = await workspace();
    const service = createService(root);
    await enable(service);
    await service.reconcile(snapshot(service, 1, [entry('one', 'r1', [
      new UserMessage(timestamp, 'legacytoken'),
    ])]));
    await waitForSearch(service, 'legacytoken', ['one']);

    await service.reconcile(snapshot(service, 2, [entry('one', 'r2', [
      new UserMessage(timestamp, 'replacementtoken'),
    ])]));
    await waitForSearch(service, 'replacementtoken', ['one']);

    const stale = await search(service, 'legacytoken', ['one']);
    expect(stale.results).toEqual([]);
    await service.close();
  });

  it('preserves sealed rows when a newer provider source fails', async () => {
    const root = await workspace();
    const service = createService(root);
    await enable(service);
    await service.reconcile(snapshot(service, 1, [entry('one', 'r1', [
      new UserMessage(timestamp, 'retainedtoken'),
    ])]));
    await waitForSearch(service, 'retainedtoken', ['one']);

    await service.reconcile(snapshot(service, 2, [{
      ...entry('one', 'r1', []),
      source: { state: 'failed' as const, code: 'SOURCE_UNAVAILABLE', retryable: false },
    }]));
    await waitForStatus(service, (status) => status.failedChatCount === 1);

    const retained = await search(service, 'retainedtoken', ['one']);
    expect(retained.results.map((hit) => hit.chatId)).toEqual(['one']);
    expect(retained.index.failedChatCount).toBe(1);
    await service.close();
  });

  it('does not resurrect a deleted chat from a stale catalog', async () => {
    const root = await workspace();
    const service = createService(root);
    await enable(service);
    const original = entry('one', 'r1', [new UserMessage(timestamp, 'deletedtoken')]);
    await service.reconcile(snapshot(service, 1, [original]));
    await waitForSearch(service, 'deletedtoken', ['one']);

    service.deleteChat({
      chatId: 'one',
      generation: { epoch: service.operationEpoch(), sequence: 3 },
    });
    await service.reconcile(snapshot(service, 2, [original]));
    await waitForStatus(service, (status) => status.indexedChatCount === 0);

    expect((await search(service, 'deletedtoken', ['one'])).results).toEqual([]);
    await service.close();
  });
});

async function workspace(): Promise<string> {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-shared-search-'));
  roots.push(root);
  return root;
}

function createService(
  root: string,
  carried: Record<string, ChatMessage[]> = {},
  workerFactory?: (role: 'indexer' | 'reader', moduleUrl: string) => Worker,
): TranscriptSearchService {
  return new TranscriptSearchService({
    workspaceDirectory: root,
    logger,
    workerFactory,
    async openCarryOverStream(request) {
      if (request.expectedRevision !== 'carry-v1:1') {
        return { revision: request.expectedRevision, batches: emptyBatches() };
      }
      return {
        revision: request.expectedRevision,
        batches: batches(carried[request.chatId] ?? []),
      };
    },
  });
}

async function enable(service: TranscriptSearchService): Promise<void> {
  await service.enable({
    modules: [{
      agentId: 'fixture',
      reference: { apiVersion: 1, moduleUrl: new URL('./fixture-index-source.ts', import.meta.url).href },
    }],
    signal: new AbortController().signal,
  });
}

function snapshot(service: TranscriptSearchService, sequence: number, chats: ReturnType<typeof entry>[]) {
  return { generation: { epoch: service.operationEpoch(), sequence }, chats };
}

function entry(chatId: string, revision: string, messages: ChatMessage[], carryOverRevision = 'carry-v1:0') {
  return {
    chatId,
    agentId: 'fixture',
    model: 'model',
    updatedAt: timestamp,
    source: {
      state: 'ready' as const,
      reference: {
        ownerId: 'fixture',
        schemaVersion: 1,
        value: { revision, messages: JSON.parse(JSON.stringify(messages)) },
      },
    },
    carryOverRevision,
  };
}

async function waitForSearch(service: TranscriptSearchService, text: string, chatIds: string[]) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const result = await service.search({
      query: query(text),
      allowedChatIds: chatIds,
      limit: 20,
      signal: new AbortController().signal,
    });
    if (result.results.length > 0) return result;
    if (Date.now() >= deadline) throw new Error(`Search result did not become available: ${text}`);
    await Bun.sleep(20);
  }
}

function search(service: TranscriptSearchService, text: string, chatIds: string[]) {
  return service.search({
    query: query(text),
    allowedChatIds: chatIds,
    limit: 20,
    signal: new AbortController().signal,
  });
}

async function waitForStatus(
  service: TranscriptSearchService,
  predicate: (status: ReturnType<TranscriptSearchService['indexStatus']>) => boolean,
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (!predicate(service.indexStatus())) {
    if (Date.now() >= deadline) throw new Error('Transcript search status did not converge');
    await Bun.sleep(20);
  }
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

async function* batches(messages: ChatMessage[]): AsyncIterable<readonly ChatMessage[]> {
  if (messages.length > 0) yield messages;
}

async function* emptyBatches(): AsyncIterable<readonly ChatMessage[]> {}
