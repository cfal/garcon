import { afterEach, describe, expect, it } from 'bun:test';
import { Database } from 'bun:sqlite';
import { mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  AssistantMessage,
  PermissionResolvedMessage,
  UserMessage,
  type ChatMessage,
} from '@garcon/common/chat-types';
import { TranscriptSearchService } from '../transcript-search-service.js';

const timestamp = '2026-01-01T00:00:00.000Z';
const roots: string[] = [];
const contentEpochs = new Map<string, string>();
const logger = { debug() {}, info() {}, warn() {}, error() {} };

afterEach(async () => {
  contentEpochs.clear();
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
    expect(result.results[0]?.snippets[0]?.anchor).toEqual({
      kind: 'current-entry',
      agentOwnershipEpoch: 'owner:two',
      entryId: 'fixture-entry-1',
    });
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
    expect(result.results[0]?.snippets[0]?.anchor).toEqual({
      kind: 'carryover-entry',
      segmentId: 'segment-one',
      localOrdinal: 1,
    });
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
    await restarted.reconcile(snapshot(restarted, 1, [entry('one', 'r1', [
      new UserMessage(timestamp, 'durable token'),
    ])]));
    const durable = await restarted.search({
      query: query('durable'),
      allowedChats: allowed(['one']),
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

    const replacement = entry('one', 'r2', [
      new UserMessage(timestamp, 'replacementtoken'),
    ], 'carry-v1:0', 'content:one:v2');
    await service.reconcile(snapshot(service, 2, [replacement]));

    expect((await search(service, 'legacytoken', ['one'])).results).toEqual([]);
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

  it('indexes only a validated suffix when the ledger content epoch is unchanged', async () => {
    const root = await workspace();
    const service = createService(root);
    await enable(service);
    const initial = entry('one', 'r1', [new UserMessage(timestamp, 'prefixonlytoken')]);
    await service.reconcile(snapshot(service, 1, [initial]));
    await waitForSearch(service, 'prefixonlytoken', ['one']);
    await service.reconcile(snapshot(service, 2, [entry('one', 'r3', [
      new UserMessage(timestamp, 'prefixonlytoken'),
      new PermissionResolvedMessage(timestamp, 'permission-one', true),
      new AssistantMessage(timestamp, 'suffixonlytoken'),
    ])]));
    const suffix = await waitForSearch(service, 'suffixonlytoken', ['one']);
    const prefix = await search(service, 'prefixonlytoken', ['one']);
    expect(prefix.results).toHaveLength(1);
    expect(prefix.results[0]?.snippets[0]?.anchor).toEqual({
      kind: 'current-entry',
      agentOwnershipEpoch: 'owner:one',
      entryId: 'fixture-entry-1',
    });
    expect(suffix.results[0]?.snippets[0]).toMatchObject({
      messageOrdinal: 3,
      anchor: {
        kind: 'current-entry',
        agentOwnershipEpoch: 'owner:one',
        entryId: 'fixture-entry-3',
      },
    });
    const db = new Database(path.join(root, 'transcript-search', 'index.sqlite'), {
      readonly: true,
      create: false,
    });
    const persisted = db.query<{ indexedDurableCount: number }, []>(`
      SELECT indexed_durable_count AS indexedDurableCount
      FROM search_chat_state WHERE chat_id = 'one'
    `).get();
    db.close();
    expect(persisted?.indexedDurableCount).toBe(3);
    await service.close();
  });

  it('delivers source refresh events for chats with and without a seed receipt', async () => {
    const root = await workspace();
    const service = createService(root);
    const refreshes: string[] = [];
    service.setSourceRefreshHandler(async (request) => {
      refreshes.push(request.chatId);
    });
    await service.enable({
      modules: [{
        agentId: 'fixture-failing',
        reference: {
          apiVersion: 2,
          moduleUrl: new URL('./fixture-index-source-failure.ts', import.meta.url).href,
        },
      }],
      signal: new AbortController().signal,
    });
    // Regression: the host hashed the receipt raw while the indexer hashed its
    // digest, so the descriptor comparison dropped every refresh event.
    await service.reconcile(snapshot(service, 1, [
      failingEntry('one', null, null),
      failingEntry('two', 'native-two', null),
    ]));

    const deadline = Date.now() + 5_000;
    while (!refreshes.includes('one') || !refreshes.includes('two')) {
      if (Date.now() >= deadline) throw new Error(`Source refresh was not delivered: ${refreshes}`);
      await Bun.sleep(20);
    }
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
      if (request.expectedRevision === 'carry-v1:0') {
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
      reference: { apiVersion: 2, moduleUrl: new URL('./fixture-index-source.ts', import.meta.url).href },
    }],
    signal: new AbortController().signal,
  });
}

function snapshot(service: TranscriptSearchService, sequence: number, chats: ReturnType<typeof entry>[]) {
  return { generation: { epoch: service.operationEpoch(), sequence }, chats };
}

function entry(
  chatId: string,
  revision: string,
  messages: ChatMessage[],
  carryOverRevision = 'carry-v1:0',
  contentEpoch = `content:${chatId}`,
) {
  contentEpochs.set(chatId, contentEpoch);
  return {
    chatId,
    agentId: 'fixture',
    model: 'model',
    updatedAt: timestamp,
    source: {
      state: 'ready' as const,
      reference: {
        apiVersion: 2 as const,
        ownerId: 'fixture',
        schemaVersion: 2 as const,
        checkpoint: {
          chatId,
          agentOwnershipEpoch: `owner:${chatId}`,
          contentEpoch: `segment:${chatId}`,
          durableCount: messages.length,
          durableRevision: revision,
        },
        value: { messages: JSON.parse(JSON.stringify(messages)) },
      },
    },
    contentEpoch,
    carryOverRevision,
    agentSessionId: null,
    nativeSeedReceipt: null,
  };
}

function failingEntry(
  chatId: string,
  agentSessionId: string | null,
  nativeSeedReceipt: null,
) {
  return {
    chatId,
    agentId: 'fixture-failing',
    model: 'model',
    updatedAt: timestamp,
    source: {
      state: 'ready' as const,
      reference: {
        apiVersion: 2 as const,
        ownerId: 'fixture-failing',
        schemaVersion: 2 as const,
        checkpoint: {
          chatId,
          agentOwnershipEpoch: `owner:${chatId}`,
          contentEpoch: `segment:${chatId}`,
          durableCount: 0,
          durableRevision: 'r1',
        },
        value: { messages: [] },
      },
    },
    contentEpoch: `content:${chatId}`,
    carryOverRevision: 'carry-v1:0',
    agentSessionId,
    nativeSeedReceipt,
  };
}

async function waitForSearch(service: TranscriptSearchService, text: string, chatIds: string[]) {
  const deadline = Date.now() + 5_000;
  while (true) {
    const result = await service.search({
      query: query(text),
      allowedChats: allowed(chatIds),
      limit: 20,
      signal: new AbortController().signal,
    });
    if (result.results.length > 0) return result;
    if (Date.now() >= deadline) throw new Error(`Search result did not become available: ${text}`);
    await Bun.sleep(20);
  }
}

async function waitForMissingSearch(
  service: TranscriptSearchService,
  text: string,
  chatIds: string[],
): Promise<void> {
  const deadline = Date.now() + 5_000;
  while (true) {
    if ((await search(service, text, chatIds)).results.length === 0) return;
    if (Date.now() >= deadline) throw new Error(`Stale search result remained available: ${text}`);
    await Bun.sleep(20);
  }
}

function search(service: TranscriptSearchService, text: string, chatIds: string[]) {
  return service.search({
    query: query(text),
    allowedChats: allowed(chatIds),
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

function allowed(chatIds: readonly string[]) {
  return chatIds.flatMap((chatId) => {
    const contentEpoch = contentEpochs.get(chatId);
    return contentEpoch ? [{ chatId, contentEpoch }] : [];
  });
}

async function* batches(messages: ChatMessage[]): AsyncIterable<readonly {
  message: ChatMessage;
  anchor: { kind: 'carryover-entry'; segmentId: string; localOrdinal: number };
}[]> {
  if (messages.length > 0) yield messages.map((message, index) => ({
    message,
    anchor: { kind: 'carryover-entry', segmentId: 'segment-one', localOrdinal: index + 1 },
  }));
}

async function* emptyBatches(): AsyncIterable<readonly never[]> {}
