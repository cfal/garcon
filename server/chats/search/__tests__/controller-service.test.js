import { afterEach, describe, expect, test } from 'bun:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import {
  TranscriptSearchService,
} from '../../../../server-agents/common/src/search/transcript-search-service.ts';
import {
  SEARCH_MAX_DIRTY_FRAMES,
  SEARCH_WAL_HIGH_WATER_FRAMES,
} from '../../../../server-agents/common/src/search/worker-protocol.ts';

const services = new Set();
const roots = new Set();

afterEach(async () => {
  await Promise.allSettled([...services].map((service) => service.close()));
  services.clear();
  await Promise.all([...roots].map((root) => rm(root, { recursive: true, force: true })));
  roots.clear();
});

function searchState(overrides = {}) {
  const targetThrough = overrides.targetThrough ?? 1;
  const phase = overrides.phase ?? 'replacement-build';
  const status = overrides.status ?? 'pending';
  return {
    chatId: overrides.chatId ?? 'chat-a',
    transcriptViewId: overrides.transcriptViewId ?? 'view-a',
    status,
    phase,
    targetThrough,
    processedThrough: overrides.processedThrough ?? (status === 'indexed' ? targetThrough : 0),
    activeChunkId: overrides.activeChunkId ?? null,
    slotDocumentCount: overrides.slotDocumentCount ?? 0,
    slotTokenCount: overrides.slotTokenCount ?? 0,
    lastErrorCode: overrides.lastErrorCode ?? null,
    updatedAt: overrides.updatedAt ?? '2026-08-18T00:00:00.000Z',
  };
}

function indexedState(chatId, transcriptViewId, targetThrough) {
  return searchState({
    chatId,
    transcriptViewId,
    targetThrough,
    processedThrough: targetThrough,
    status: 'indexed',
    phase: 'idle',
  });
}

function row(ordinal, body = `body-${ordinal}`) {
  return { ordinal, role: 'user', timestamp: null, body };
}

function identity(request) {
  return { requestId: request.requestId, lifecycleEpoch: request.lifecycleEpoch };
}

class ControlledWorker {
  onmessage = null;
  onerror = null;
  onmessageerror = null;
  requests = [];
  terminateCount = 0;
  #listeners = new Map();

  addEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    listeners.push(listener);
    this.#listeners.set(type, listeners);
  }

  removeEventListener(type, listener) {
    const listeners = this.#listeners.get(type) ?? [];
    this.#listeners.set(type, listeners.filter((candidate) => candidate !== listener));
  }

  emit(event) {
    this.onmessage?.({ data: event });
  }

  closeEvent() {
    for (const listener of this.#listeners.get('close') ?? []) listener({});
  }

  terminate() {
    this.terminateCount += 1;
    this.closeEvent();
  }
}

class IndexerWorker extends ControlledWorker {
  ordinal;
  cluster;
  walEpoch = 0;
  sequence = 0;
  logFrames = 0;

  constructor(cluster, ordinal) {
    super();
    this.cluster = cluster;
    this.ordinal = ordinal;
  }

  postMessage(request) {
    this.requests.push(request);
    this.cluster.trace.push({ role: 'indexer', ordinal: this.ordinal, request });
    switch (request.type) {
      case 'open': {
        this.walEpoch = request.walEpoch;
        this.sequence = 1;
        this.logFrames = this.ordinal % 2 === 0
          ? (this.cluster.writerOpenLogs.shift() ?? 0)
          : 0;
        this.emit({ type: 'opened', ...identity(request), wal: this.observation() });
        return;
      }
      case 'checkpoint':
        this.logFrames = 0;
        this.sequence += 1;
        this.emit({
          type: 'checkpoint-complete',
          ...identity(request),
          busy: 0,
          logFrames: 0,
          checkpointedFrames: 0,
          wal: this.observation(),
        });
        return;
      case 'physical-step-grant':
        this.emit({ type: 'step-started', ...identity(request), grantId: request.grantId });
        if (this.cluster.nextStepError?.kind === request.step.kind) {
          const failure = this.cluster.nextStepError;
          this.cluster.nextStepError = null;
          this.fail(request, failure);
          return;
        }
        if (this.cluster.holdStepKinds.delete(request.step.kind)) {
          this.cluster.heldSteps.push({ worker: this, request });
          return;
        }
        this.complete(request);
        return;
      case 'indexer-quiesce':
        this.emit({ type: 'indexer-quiesced', ...identity(request) });
        if (this.cluster.holdCloseRoles.delete('indexer')) this.cluster.heldCloses.push(this);
        else this.closeEvent();
        return;
      default:
        throw new Error(`Unexpected indexer request ${request.type}`);
    }
  }

  complete(request) {
    const result = this.cluster.execute(request.step);
    this.logFrames += this.cluster.frameDelta;
    this.sequence += 1;
    const omitWal = this.cluster.omitNextWal;
    this.cluster.omitNextWal = false;
    const staleWal = this.cluster.staleNextWal;
    this.cluster.staleNextWal = false;
    this.emit({
      type: 'physical-step-complete',
      ...identity(request),
      grantId: request.grantId,
      result,
      ...(!omitWal ? {
        wal: staleWal
          ? { ...this.observation(), walObservationSequence: this.sequence - 1 }
          : this.observation(),
      } : {}),
    });
  }

  fail(request, failure) {
    this.sequence += 1;
    let wal;
    if (failure.wal === 'valid') wal = this.observation();
    if (failure.wal === 'stale') {
      wal = { ...this.observation(), walObservationSequence: this.sequence - 1 };
    }
    if (failure.wal === 'malformed') {
      wal = { ...this.observation(), checkpointedFrames: this.logFrames + 1 };
    }
    this.emit({
      type: 'error',
      ...identity(request),
      grantId: request.grantId,
      code: failure.code,
      retryable: failure.retryable,
      ...(wal ? { wal } : {}),
    });
  }

  observation() {
    return {
      walEpoch: this.walEpoch,
      walObservationSequence: this.sequence,
      logFrames: this.logFrames,
      checkpointedFrames: 0,
    };
  }
}

class ReaderWorker extends ControlledWorker {
  ordinal;
  cluster;
  #searches = new Map();

  constructor(cluster, ordinal) {
    super();
    this.cluster = cluster;
    this.ordinal = ordinal;
  }

  postMessage(request) {
    this.requests.push(request);
    this.cluster.trace.push({ role: 'reader', ordinal: this.ordinal, request });
    switch (request.type) {
      case 'open':
        this.emit({ type: 'opened', ...identity(request) });
        return;
      case 'search-start':
        this.#searches.set(request.requestId, { query: request.query, allowedChats: [] });
        this.emit({
          type: 'search-input-ack',
          ...identity(request),
          chunkIndex: null,
          ready: false,
        });
        return;
      case 'search-allowlist-chunk': {
        const search = this.#searches.get(request.requestId);
        search.allowedChats.push(...request.allowedChats);
        const acknowledgement = {
          type: 'search-input-ack',
          ...identity(request),
          chunkIndex: request.chunkIndex,
          ready: request.done,
        };
        if (this.cluster.holdAllowlistAcks) {
          this.cluster.heldAllowlistAcks.push({ worker: this, acknowledgement });
        } else {
          this.emit(acknowledgement);
        }
        return;
      }
      case 'reader-step-grant': {
        if (this.cluster.corruptNextSearch) {
          this.cluster.corruptNextSearch = false;
          this.emit({
            type: 'error',
            ...identity(request),
            grantId: request.grantId,
            code: 'SEARCH_INDEX_CORRUPT',
            retryable: true,
          });
          return;
        }
        const search = this.#searches.get(request.requestId);
        this.#searches.delete(request.requestId);
        const output = this.cluster.search(search.allowedChats);
        this.emit({
          type: 'reader-step-complete',
          ...identity(request),
          grantId: request.grantId,
          result: {
            kind: 'result-chunk',
            chunkIndex: 0,
            results: output.results,
            index: output.index,
            done: true,
          },
        });
        return;
      }
      case 'reader-quiesce':
        this.#searches.clear();
        this.emit({ type: 'reader-quiesced', ...identity(request) });
        if (this.cluster.holdCloseRoles.delete('reader')) this.cluster.heldCloses.push(this);
        else this.closeEvent();
        return;
      default:
        throw new Error(`Unexpected reader request ${request.type}`);
    }
  }
}

class WorkerCluster {
  trace = [];
  chats = new Map();
  indexers = [];
  readers = [];
  heldSteps = [];
  heldCloses = [];
  heldAllowlistAcks = [];
  holdStepKinds = new Set();
  holdCloseRoles = new Set();
  holdAllowlistAcks = false;
  writerOpenLogs = [];
  frameDelta = 1;
  omitNextWal = false;
  staleNextWal = false;
  corruptNextSearch = false;
  nextStepError = null;
  buildGrantRemainders = new Map();

  factory = (role) => {
    if (role === 'indexer') {
      const worker = new IndexerWorker(this, this.indexers.length + 1);
      this.indexers.push(worker);
      return worker;
    }
    const worker = new ReaderWorker(this, this.readers.length + 1);
    this.readers.push(worker);
    return worker;
  };

  releaseHeldSteps() {
    const held = this.heldSteps.splice(0);
    for (const entry of held) entry.worker.complete(entry.request);
  }

  releaseHeldCloses() {
    const held = this.heldCloses.splice(0);
    for (const worker of held) worker.closeEvent();
  }

  releaseNextAllowlistAck() {
    const held = this.heldAllowlistAcks.shift();
    held?.worker.emit(held.acknowledgement);
  }

  execute(step) {
    switch (step.kind) {
      case 'plan-replacement': {
        const current = this.chats.get(step.chatId);
        if (current?.state.status === 'indexed'
            && current.state.transcriptViewId === step.transcriptViewId
            && current.state.targetThrough >= step.targetThrough) {
          return {
            kind: 'sync-plan',
            disposition: 'current',
            completion: 'terminal',
            state: current.state,
          };
        }
        const state = searchState({
          chatId: step.chatId,
          transcriptViewId: step.transcriptViewId,
          targetThrough: step.targetThrough,
        });
        this.chats.set(step.chatId, { state, rows: [], staged: [] });
        return { kind: 'sync-plan', disposition: 'build', completion: 'continue', state };
      }
      case 'plan-append': {
        const chat = this.chats.get(step.chatId);
        if (!chat || chat.state.transcriptViewId !== step.transcriptViewId) {
          throw new Error('SEARCH_VIEW_MISMATCH');
        }
        if (chat.state.targetThrough !== step.expectedAfterOrdinal) {
          throw new Error('SEARCH_INDEX_GAP');
        }
        const state = searchState({
          ...chat.state,
          status: 'pending',
          phase: 'append-build',
          targetThrough: step.targetThrough,
          processedThrough: chat.state.processedThrough,
        });
        chat.state = state;
        return { kind: 'sync-plan', disposition: 'build', completion: 'continue', state };
      }
      case 'stage-raw': {
        const chat = this.chats.get(step.expectedState.chatId);
        chat.staged.push(...step.rows);
        const state = searchState({
          ...step.expectedState,
          activeChunkId: chat.staged[0].ordinal,
        });
        chat.state = state;
        return {
          kind: 'raw-staged',
          completion: 'continue',
          state,
          acceptedRows: step.rows.length,
        };
      }
      case 'build-terms': {
        const chat = this.chats.get(step.expectedState.chatId);
        const remaining = this.buildGrantRemainders.get(step.expectedState.chatId) ?? 0;
        if (remaining > 0) {
          this.buildGrantRemainders.set(step.expectedState.chatId, remaining - 1);
          return {
            kind: 'term-progress',
            completion: 'continue',
            state: chat.state,
            insertedTerms: 1,
            insertedOccurrences: 1,
            completedChunk: false,
          };
        }
        const completed = chat.staged.shift();
        chat.rows.push(completed);
        const activeChunkId = chat.staged[0]?.ordinal ?? null;
        const state = searchState({
          ...chat.state,
          processedThrough: completed.ordinal,
          activeChunkId,
          slotDocumentCount: chat.rows.length,
          slotTokenCount: chat.rows.length * 2,
        });
        chat.state = state;
        return {
          kind: 'term-progress',
          completion: 'continue',
          state,
          insertedTerms: 1,
          insertedOccurrences: 1,
          completedChunk: true,
        };
      }
      case 'advance-frontier': {
        const chat = this.chats.get(step.expectedState.chatId);
        const state = searchState({ ...step.expectedState, processedThrough: step.throughOrdinal });
        chat.state = state;
        return { kind: 'frontier-progress', completion: 'continue', state };
      }
      case 'activate': {
        const chat = this.chats.get(step.expectedState.chatId);
        const state = indexedState(
          step.expectedState.chatId,
          step.expectedState.transcriptViewId,
          step.expectedState.targetThrough,
        );
        chat.state = state;
        return { kind: 'indexed', completion: 'terminal', state };
      }
      case 'start-removal': {
        const chat = this.chats.get(step.chatId);
        if (!chat) return { kind: 'chat-deleted', completion: 'terminal', chatId: step.chatId };
        const state = searchState({
          ...chat.state,
          status: 'pending',
          phase: 'removal-cleanup',
          activeChunkId: 1,
        });
        chat.state = state;
        return { kind: 'sync-plan', disposition: 'cleanup', completion: 'continue', state };
      }
      case 'cleanup':
        this.chats.delete(step.expectedState.chatId);
        return {
          kind: 'chat-deleted',
          completion: 'terminal',
          chatId: step.expectedState.chatId,
        };
      case 'prune-mark': {
        const allowed = new Set(step.allowedChatIds);
        const cleanups = [];
        for (const [chatId, chat] of this.chats) {
          if (allowed.has(chatId) || (step.afterChatId && chatId <= step.afterChatId)) continue;
          const state = searchState({
            ...chat.state,
            status: 'pending',
            phase: 'removal-cleanup',
            activeChunkId: 1,
          });
          chat.state = state;
          cleanups.push({ expectedState: state });
        }
        return {
          kind: 'prune-progress',
          completion: 'terminal',
          cleanups,
          nextAfterChatId: null,
          done: true,
        };
      }
      case 'mark-failed':
        {
          const chat = this.chats.get(step.expectedState.chatId);
          if (!chat) {
            return { kind: 'failure-recorded', completion: 'terminal', applied: false };
          }
          chat.state = searchState({
            ...chat.state,
            status: 'failed',
            lastErrorCode: step.errorCode,
          });
          return { kind: 'failure-recorded', completion: 'terminal', applied: true };
        }
      case 'complete-replacement-checkpoint':
        return {
          kind: 'sync-plan',
          disposition: 'build',
          completion: 'continue',
          state: searchState({
            ...step.expectedState,
            phase: 'replacement-build',
            activeChunkId: null,
          }),
        };
      default:
        throw new Error(`Unhandled step ${step.kind}`);
    }
  }

  search(allowedChats) {
    const index = {
      indexedChatCount: 0,
      pendingChatCount: 0,
      failedChatCount: 0,
      unsupportedChatCount: 0,
    };
    const results = [];
    for (const allowed of allowedChats) {
      const chat = this.chats.get(allowed.chatId);
      if (!chat || chat.state.transcriptViewId !== allowed.transcriptViewId
          || chat.state.targetThrough < allowed.throughOrdinal) {
        index.pendingChatCount += 1;
        continue;
      }
      if (chat.state.status === 'failed') {
        index.failedChatCount += 1;
        continue;
      }
      if (chat.state.status !== 'indexed') {
        index.pendingChatCount += 1;
        continue;
      }
      index.indexedChatCount += 1;
      if (chat.rows.length > 0) {
        results.push({
          chatId: allowed.chatId,
          transcriptViewId: allowed.transcriptViewId,
          score: 1,
          matchedMessageCount: 1,
          snippets: [],
        });
      }
    }
    return { results, index };
  }
}

async function harness(options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'search-service-v8-'));
  roots.add(root);
  const cluster = new WorkerCluster();
  Object.assign(cluster, options.cluster ?? {});
  const service = new TranscriptSearchService({
    workspaceDirectory: root,
    logger: { debug() {}, info() {}, warn() {}, error() {} },
    workerFactory: cluster.factory,
  });
  services.add(service);
  await service.enable(new AbortController().signal);
  return { cluster, root, service };
}

async function waitFor(predicate, message = 'condition') {
  for (let attempts = 0; attempts < 1_000; attempts += 1) {
    if (predicate()) return;
    await Bun.sleep(0);
  }
  throw new Error(`Timed out waiting for ${message}`);
}

function physicalSteps(cluster) {
  return cluster.trace
    .filter((entry) => entry.request.type === 'physical-step-grant')
    .map((entry) => entry.request.step);
}

describe('TranscriptSearchService v8 lifecycle', () => {
  test('[TLV5-SEARCH.02-REENABLE-SERVICE-UNIT-01] reopens logical admission after disable and derived-database deletion', async () => {
    const testHarness = await harness();
    await testHarness.service.disableAndDelete(new AbortController().signal);
    await testHarness.service.enable(new AbortController().signal);

    await expect(testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    })).resolves.toBeUndefined();
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.02-SERVICE-UNIT-01] [TLV5-SEARCH.02-PHYSICAL-PROGRESS-SERVICE-UNIT-01] uses two logical permits and requeues continuations behind admitted work', async () => {
    const testHarness = await harness();
    const first = testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });
    const second = testHarness.service.replaceChat({
      chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1, rows: [row(1)],
    });

    await Promise.all([first, second]);

    const steps = physicalSteps(testHarness.cluster);
    expect(steps.slice(0, 4).map((step) => `${step.kind}:${step.chatId ?? step.expectedState?.chatId}`))
      .toEqual([
        'plan-replacement:chat-a',
        'plan-replacement:chat-b',
        'stage-raw:chat-a',
        'stage-raw:chat-b',
      ]);
  });

  test('[TLV5-SEARCH.08-DISPATCH-SERVICE-UNIT-01] admits cleanup after at most eight live grants', async () => {
    const testHarness = await harness();
    testHarness.cluster.holdStepKinds.add('plan-replacement');
    testHarness.cluster.buildGrantRemainders.set('chat-a', 12);
    testHarness.cluster.buildGrantRemainders.set('chat-b', 12);
    const first = testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });
    const second = testHarness.service.replaceChat({
      chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1, rows: [row(1)],
    });
    await waitFor(() => testHarness.cluster.heldSteps.length === 1, 'held live grant');
    const cleanupStateValue = searchState({
      chatId: 'chat-z',
      transcriptViewId: 'view-z',
      phase: 'removal-cleanup',
      activeChunkId: 1,
    });
    testHarness.cluster.chats.set('chat-z', { state: cleanupStateValue, rows: [], staged: [] });
    const cleanup = testHarness.service.finishPrunedChatCleanup({ expectedState: cleanupStateValue });
    testHarness.cluster.releaseHeldSteps();

    await Promise.all([first, second, cleanup]);

    const grants = physicalSteps(testHarness.cluster);
    const cleanupIndex = grants.findIndex((step) => step.kind === 'cleanup'
      && step.expectedState.chatId === 'chat-z');
    expect(cleanupIndex).toBeGreaterThanOrEqual(0);
    expect(grants.slice(Math.max(0, cleanupIndex - 8), cleanupIndex)
      .filter((step) => step.kind !== 'cleanup')).toHaveLength(Math.min(8, cleanupIndex));
  });

  test('[TLV5-SEARCH.10-ALLOWLIST-FRAMING-SERVICE-UNIT-01] builds and posts only the next allowlist frame after exact acknowledgement', async () => {
    const testHarness = await harness();
    testHarness.cluster.holdAllowlistAcks = true;
    const allowedChats = Array.from({ length: 2_001 }, (_, index) => ({
      chatId: `chat-${index}`,
      transcriptViewId: `view-${index}`,
      throughOrdinal: 1,
    }));
    let settled = false;
    const search = testHarness.service.search({
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      allowedChats,
      limit: 20,
      signal: new AbortController().signal,
    }).then((result) => {
      settled = true;
      return result;
    });

    await waitFor(() => testHarness.cluster.heldAllowlistAcks.length === 1, 'first allowlist ack');
    const reader = testHarness.cluster.readers.at(-1);
    expect(reader.requests.filter((request) => request.type === 'search-allowlist-chunk'))
      .toHaveLength(1);
    expect(settled).toBe(false);
    testHarness.cluster.releaseNextAllowlistAck();

    await waitFor(() => testHarness.cluster.heldAllowlistAcks.length === 1, 'second allowlist ack');
    const frames = reader.requests.filter((request) => request.type === 'search-allowlist-chunk');
    expect(frames).toHaveLength(2);
    expect(frames.map(({ chunkIndex, allowedChats: chunk, done }) => ({
      chunkIndex,
      rows: chunk.length,
      done,
    }))).toEqual([
      { chunkIndex: 0, rows: 2_000, done: false },
      { chunkIndex: 1, rows: 1, done: true },
    ]);
    expect(settled).toBe(false);
    testHarness.cluster.releaseNextAllowlistAck();

    await expect(search).resolves.toMatchObject({
      results: [],
      index: { pendingChatCount: 2_001 },
    });
  });

  test('[TLV5-SEARCH.09-WAL-ADMISSION-UNIT-01] checkpoints before the first unsafe reservation and steady writes resume', async () => {
    const threshold = SEARCH_WAL_HIGH_WATER_FRAMES - SEARCH_MAX_DIRTY_FRAMES;
    const testHarness = await harness({ cluster: { writerOpenLogs: [threshold + 1] } });
    const initialWriter = testHarness.cluster.indexers[1];

    await testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });

    expect(initialWriter.requests.some((request) => request.type === 'physical-step-grant')).toBe(false);
    expect(initialWriter.requests.at(-1).type).toBe('indexer-quiesce');
    expect(testHarness.cluster.indexers.length).toBeGreaterThanOrEqual(4);
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.09-WAL-BOUNDARY-UNIT-01] admits exactly at H-F then checkpoints before the continuation', async () => {
    const threshold = SEARCH_WAL_HIGH_WATER_FRAMES - SEARCH_MAX_DIRTY_FRAMES;
    const testHarness = await harness({
      cluster: { writerOpenLogs: [threshold], frameDelta: SEARCH_MAX_DIRTY_FRAMES },
    });
    const initialWriter = testHarness.cluster.indexers[1];

    await testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });

    const requestTypes = initialWriter.requests.map((request) => request.type);
    expect(requestTypes.indexOf('physical-step-grant')).toBeGreaterThanOrEqual(0);
    expect(requestTypes.indexOf('indexer-quiesce'))
      .toBeGreaterThan(requestTypes.indexOf('physical-step-grant'));
    expect(initialWriter.requests.filter((request) => request.type === 'physical-step-grant'))
      .toHaveLength(1);
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.09-WAL-MISSING-UNIT-01] releases a known completion reservation but fences the next grant without metrics', async () => {
    const testHarness = await harness();
    const initialWriter = testHarness.cluster.indexers[1];
    testHarness.cluster.omitNextWal = true;

    await testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });

    expect(initialWriter.requests.filter((request) => request.type === 'physical-step-grant'))
      .toHaveLength(1);
    expect(initialWriter.requests.at(-1).type).toBe('indexer-quiesce');
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.05-SERVICE-UNIT-01] [TLV5-SEARCH.09-WAL-ERROR-VALID-UNIT-01] records only the three frozen build errors after releasing their exact reservations', async () => {
    for (const [index, code] of [
      'SEARCH_TOKENIZER_INVALID',
      'SEARCH_TOKENIZER_LIMIT',
      'SEARCH_POSTING_INVALID',
    ].entries()) {
      const testHarness = await harness();
      const initialWriter = testHarness.cluster.indexers[1];
      const input = {
        chatId: `chat-${index}`,
        transcriptViewId: 'view-a',
        throughOrdinal: 1,
        rows: [row(1)],
      };
      testHarness.cluster.nextStepError = {
        kind: 'stage-raw',
        code,
        retryable: false,
        wal: 'valid',
      };

      await expect(testHarness.service.replaceChat(input)).rejects.toThrow(code);

      expect(initialWriter.requests.some((request) => request.type === 'indexer-quiesce')).toBe(false);
      expect(initialWriter.requests.some((request) => (
        request.type === 'physical-step-grant'
          && request.step.kind === 'mark-failed'
          && request.step.errorCode === code
      ))).toBe(true);
      expect(testHarness.cluster.chats.get(input.chatId).state).toMatchObject({
        status: 'failed',
        lastErrorCode: code,
      });

      await expect(testHarness.service.replaceChat(input)).resolves.toBeUndefined();
      expect(testHarness.cluster.chats.get(input.chatId).state).toMatchObject({
        status: 'indexed',
        phase: 'idle',
        lastErrorCode: null,
      });
    }
  });

  test('[TLV5-SEARCH.09-WAL-ERROR-STALE-UNIT-01] does not regress a newer observation but still releases the exact reservation', async () => {
    const testHarness = await harness();
    const initialWriter = testHarness.cluster.indexers[1];
    testHarness.cluster.nextStepError = {
      kind: 'stage-raw',
      code: 'SEARCH_TOKENIZER_LIMIT',
      retryable: false,
      wal: 'stale',
    };

    await expect(testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    })).rejects.toThrow('SEARCH_TOKENIZER_LIMIT');

    expect(initialWriter.requests.some((request) => request.type === 'indexer-quiesce')).toBe(false);
    expect(initialWriter.requests.some((request) => (
      request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
    ))).toBe(true);
  });

  test('[TLV5-SEARCH.09-WAL-ERROR-MISSING-UNIT-01] releases a known error without metrics then fences through maintenance', async () => {
    const testHarness = await harness();
    const initialWriter = testHarness.cluster.indexers[1];
    testHarness.cluster.nextStepError = {
      kind: 'stage-raw',
      code: 'SEARCH_TOKENIZER_LIMIT',
      retryable: false,
      wal: 'missing',
    };

    await expect(testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    })).rejects.toThrow('SEARCH_TOKENIZER_LIMIT');

    expect(initialWriter.requests.at(-1).type).toBe('indexer-quiesce');
    expect(initialWriter.requests.some((request) => (
      request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
    ))).toBe(false);
    expect(testHarness.cluster.indexers.at(-1).requests.some((request) => (
      request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
    ))).toBe(true);
  });

  test('[TLV5-SEARCH.09-WAL-ERROR-NONRECORDABLE-UNIT-01] never converts state or WAL authority errors into chat failure', async () => {
    for (const code of ['SEARCH_STATE_INVARIANT', 'SEARCH_WAL_OBSERVATION_INVALID']) {
      const testHarness = await harness();
      const initialWriter = testHarness.cluster.indexers[1];
      testHarness.cluster.nextStepError = {
        kind: 'stage-raw',
        code,
        retryable: false,
        wal: 'valid',
      };

      await expect(testHarness.service.replaceChat({
        chatId: `chat-${code}`, transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
      })).rejects.toThrow(code);

      expect(initialWriter.requests.some((request) => (
        request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
      ))).toBe(false);
      await testHarness.service.close();
      services.delete(testHarness.service);
    }
  });

  test('[TLV5-SEARCH.09-WAL-ERROR-MALFORMED-UNIT-01] invalidates malformed optional metrics and retains the reservation through retirement', async () => {
    const testHarness = await harness();
    const initialWriter = testHarness.cluster.indexers[1];
    testHarness.cluster.nextStepError = {
      kind: 'stage-raw',
      code: 'SEARCH_TOKENIZER_LIMIT',
      retryable: false,
      wal: 'malformed',
    };

    await expect(testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    })).rejects.toThrow('invalid message');

    expect(initialWriter.requests.at(-1).type).toBe('indexer-quiesce');
    expect(initialWriter.terminateCount).toBe(0);
    expect(testHarness.cluster.indexers.flatMap((worker) => worker.requests).some((request) => (
      request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
    ))).toBe(false);
  });

  test('[TLV5-SEARCH.02-RESYNC-SERVICE-UNIT-01] [TLV5-SEARCH.08-RETIREMENT-SERVICE-UNIT-01] retires a failed resync Worker before starting its successor', async () => {
    const testHarness = await harness();
    const input = {
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    };
    let resyncCount = 0;
    testHarness.service.setResyncHandler(async () => {
      resyncCount += 1;
      if (resyncCount === 1) {
        testHarness.cluster.nextStepError = {
          kind: 'stage-raw',
          code: 'SEARCH_TOKENIZER_LIMIT',
          retryable: false,
          wal: 'malformed',
        };
        testHarness.cluster.holdCloseRoles.add('indexer');
        testHarness.cluster.holdCloseRoles.add('reader');
      }
      await testHarness.service.replaceChat(input);
    });
    testHarness.cluster.nextStepError = {
      kind: 'stage-raw',
      code: 'SEARCH_TOKENIZER_LIMIT',
      retryable: false,
      wal: 'malformed',
    };
    const failed = testHarness.service.replaceChat(input);
    void failed.catch(() => undefined);

    await waitFor(() => testHarness.cluster.heldCloses.length === 2, 'failed resync close pair');
    expect(testHarness.cluster.indexers).toHaveLength(4);
    expect(testHarness.cluster.indexers[3].terminateCount).toBe(0);
    testHarness.cluster.releaseHeldCloses();
    await expect(failed).rejects.toThrow('invalid message');
    await waitFor(() => resyncCount === 2, 'successor resync');

    expect(resyncCount).toBe(2);
    expect(testHarness.cluster.indexers).toHaveLength(6);
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.08-INDEXER-CORRUPTION-RECOVERY-UNIT-01] releases known corruption then recreates and resyncs the whole derived database', async () => {
    const testHarness = await harness();
    const input = {
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    };
    const databasePath = path.join(testHarness.root, 'transcript-search', 'index.sqlite');
    await writeFile(databasePath, 'synthetic-derived-marker');
    let resyncCount = 0;
    testHarness.service.setResyncHandler(async () => {
      resyncCount += 1;
      await testHarness.service.replaceChat(input);
    });
    testHarness.cluster.nextStepError = {
      kind: 'stage-raw',
      code: 'SEARCH_INDEX_CORRUPT',
      retryable: false,
      wal: 'valid',
    };

    await expect(testHarness.service.replaceChat(input)).rejects.toThrow('SEARCH_INDEX_CORRUPT');
    await waitFor(() => resyncCount === 1, 'indexer corruption resync');

    await expect(Bun.file(databasePath).exists()).resolves.toBe(false);
    expect(testHarness.cluster.indexers.flatMap((worker) => worker.requests).some((request) => (
      request.type === 'physical-step-grant' && request.step.kind === 'mark-failed'
    ))).toBe(false);
    expect(testHarness.cluster.chats.get('chat-a').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.09-SECURE-BARRIER-SERVICE-UNIT-01] deletion waits for both acknowledgements, actual closes, and verified TRUNCATE', async () => {
    const testHarness = await harness();
    await testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });
    testHarness.cluster.holdCloseRoles.add('indexer');
    testHarness.cluster.holdCloseRoles.add('reader');
    let settled = false;
    const deletion = testHarness.service.deleteChat('chat-a').then(() => { settled = true; });

    await waitFor(() => testHarness.cluster.heldCloses.length === 2, 'cooperative close pair');
    let replacementSettled = false;
    const replacement = testHarness.service.replaceChat({
      chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1, rows: [row(1)],
    }).then(() => { replacementSettled = true; });
    let searchSettled = false;
    const search = testHarness.service.search({
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'body', normalized: 'body', match: 'exact' }],
        }],
      },
      allowedChats: [{ chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1 }],
      limit: 20,
      signal: new AbortController().signal,
    }).then((result) => {
      searchSettled = true;
      return result;
    });
    await Bun.sleep(0);
    expect(settled).toBe(false);
    expect(replacementSettled).toBe(false);
    expect(searchSettled).toBe(false);
    expect(testHarness.cluster.indexers).toHaveLength(2);
    expect(physicalSteps(testHarness.cluster).some((step) => (
      step.kind === 'plan-replacement' && step.chatId === 'chat-b'
    ))).toBe(false);
    testHarness.cluster.releaseHeldCloses();
    await Promise.all([deletion, replacement, search]);

    expect(settled).toBe(true);
    expect(replacementSettled).toBe(true);
    expect(searchSettled).toBe(true);
    expect(testHarness.cluster.indexers.some((worker) => (
      worker.requests.some((request) => request.type === 'checkpoint')
    ))).toBe(true);
    const maintenanceIndex = testHarness.cluster.trace.findIndex((entry) => (
      entry.request.type === 'checkpoint'
    ));
    const replacementIndex = testHarness.cluster.trace.findIndex((entry) => (
      entry.request.type === 'physical-step-grant'
        && entry.request.step.kind === 'plan-replacement'
        && entry.request.step.chatId === 'chat-b'
    ));
    expect(maintenanceIndex).toBeGreaterThanOrEqual(0);
    expect(replacementIndex).toBeGreaterThan(maintenanceIndex);
    expect(testHarness.cluster.chats.has('chat-a')).toBe(false);
    expect(testHarness.cluster.chats.get('chat-b').state.status).toBe('indexed');
  });

  test('[TLV5-SEARCH.09-MAINTENANCE-SEARCH-UNIT-01] retries a reader request interrupted by a known secure barrier', async () => {
    const testHarness = await harness();
    await testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });
    await testHarness.service.replaceChat({
      chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1, rows: [row(1)],
    });
    testHarness.cluster.holdStepKinds.add('cleanup');
    const deletion = testHarness.service.deleteChat('chat-a');
    await waitFor(() => testHarness.cluster.heldSteps.length === 1, 'held cleanup');

    testHarness.cluster.holdAllowlistAcks = true;
    const search = testHarness.service.search({
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'body', normalized: 'body', match: 'exact' }],
        }],
      },
      allowedChats: [{ chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1 }],
      limit: 20,
      signal: new AbortController().signal,
    });
    await waitFor(
      () => testHarness.cluster.heldAllowlistAcks.length === 1,
      'held pre-barrier reader acknowledgement',
    );

    testHarness.cluster.holdAllowlistAcks = false;
    testHarness.cluster.releaseHeldSteps();
    await expect(search).resolves.toMatchObject({
      index: { indexedChatCount: 1, pendingChatCount: 0 },
    });
    await deletion;
    expect(testHarness.cluster.readers.length).toBeGreaterThanOrEqual(2);
  });

  test('[TLV5-L01.02-SEARCH-CATALOG-PRUNE-SERVICE-01] snapshots after admitted writes drain and invokes the callback before reopening', async () => {
    const testHarness = await harness();
    testHarness.cluster.holdStepKinds.add('plan-replacement');
    const admitted = testHarness.service.replaceChat({
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1)],
    });
    await waitFor(() => testHarness.cluster.heldSteps.length === 1, 'held admitted write');
    const order = [];
    const prune = testHarness.service.pruneChats(
      () => { order.push('snapshot'); return ['chat-a']; },
      () => { order.push('callback'); },
    );
    const later = testHarness.service.replaceChat({
      chatId: 'chat-b', transcriptViewId: 'view-b', throughOrdinal: 1, rows: [row(1)],
    }).then(() => order.push('later'));
    await Bun.sleep(0);
    expect(order).toEqual([]);
    testHarness.cluster.releaseHeldSteps();

    await Promise.all([admitted, prune, later]);

    expect(order.slice(0, 2)).toEqual(['snapshot', 'callback']);
    expect(order.at(-1)).toBe('later');
  });

  test('[TLV5-SEARCH.03-PRUNE-FAILURE-SERVICE-UNIT-01] reopens write admission after a known prune rejection', async () => {
    const testHarness = await harness();
    testHarness.cluster.nextStepError = {
      kind: 'prune-mark',
      code: 'SEARCH_PRUNE_INVALID',
      retryable: false,
      wal: 'valid',
    };

    await expect(testHarness.service.pruneChats(() => [], () => {}))
      .rejects.toThrow('SEARCH_PRUNE_INVALID');
    await expect(testHarness.service.replaceChat({
      chatId: 'chat-after-prune',
      transcriptViewId: 'view-after-prune',
      throughOrdinal: 1,
      rows: [row(1)],
    })).resolves.toBeUndefined();
  });

  test('[TLV5-SEARCH.08-CORRUPTION-RECOVERY-UNIT-01] fences, recreates, resyncs, and returns no malformed result frame', async () => {
    const testHarness = await harness();
    const input = {
      chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1, rows: [row(1, 'needle')],
    };
    await testHarness.service.replaceChat(input);
    const databasePath = path.join(testHarness.root, 'transcript-search', 'index.sqlite');
    await writeFile(databasePath, 'synthetic-derived-marker');
    let resyncCount = 0;
    testHarness.service.setResyncHandler(async () => {
      resyncCount += 1;
      await testHarness.service.replaceChat(input);
    });
    testHarness.cluster.chats.clear();
    testHarness.cluster.corruptNextSearch = true;

    await expect(testHarness.service.search({
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      allowedChats: [{ chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1 }],
      limit: 20,
      signal: new AbortController().signal,
    })).rejects.toThrow('SEARCH_INDEX_CORRUPT');

    expect(resyncCount).toBe(1);
    await expect(Bun.file(databasePath).exists()).resolves.toBe(false);
    await expect(testHarness.service.search({
      query: {
        version: 1,
        clauses: [{
          kind: 'all-words',
          tokens: [{ text: 'needle', normalized: 'needle', match: 'exact' }],
        }],
      },
      allowedChats: [{ chatId: 'chat-a', transcriptViewId: 'view-a', throughOrdinal: 1 }],
      limit: 20,
      signal: new AbortController().signal,
    })).resolves.toMatchObject({
      results: [expect.objectContaining({ chatId: 'chat-a', transcriptViewId: 'view-a' })],
    });
  });
});
