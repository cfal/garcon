#!/usr/bin/env bun

import { monitorEventLoopDelay, performance } from 'node:perf_hooks';
import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { TranscriptSearchService } from '../server-agents/common/src/search/transcript-search-service.ts';

const chatCount = positiveInteger('GARCON_SEARCH_BENCH_CHATS', 3_000);
const messagesPerChat = positiveInteger('GARCON_SEARCH_BENCH_MESSAGES', 334);
const iterations = positiveInteger('GARCON_SEARCH_BENCH_ITERATIONS', 20);
const warmups = positiveInteger('GARCON_SEARCH_BENCH_WARMUPS', 4);
const representedAgentCount = 10;
const agentIds = Array.from({ length: representedAgentCount }, (_, index) => `benchmark-${index}`);
const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-shared-search-benchmark-'));
const allowedChatIds = Array.from({ length: chatCount }, (_, index) => `chat-${index}`);
const workerRoles = [];
const eventLoop = monitorEventLoopDelay({ resolution: 1 });
eventLoop.enable();
const service = new TranscriptSearchService({
  workspaceDirectory: directory,
  logger: { debug() {}, info() {}, warn() {}, error() {} },
  async openCarryOverStream(request) {
    return { revision: request.expectedRevision, batches: emptyBatches() };
  },
  workerFactory(role, moduleUrl) {
    workerRoles.push(role);
    return new Worker(moduleUrl, { name: `benchmark-search-${role}` });
  },
});

try {
  await service.enable({
    modules: agentIds.map((agentId) => {
      const moduleUrl = new URL('./fixtures/search-benchmark-index-source.ts', import.meta.url);
      moduleUrl.searchParams.set('agentId', agentId);
      return {
        agentId,
        reference: {
          apiVersion: 1,
          moduleUrl: moduleUrl.href,
        },
      };
    }),
    signal: new AbortController().signal,
  });
  const generation = (sequence) => ({ epoch: service.operationEpoch(), sequence });
  const catalog = allowedChatIds.map((chatId, chatIndex) => benchmarkEntry(chatId, chatIndex));
  const indexingStarted = performance.now();
  await service.reconcile({
    generation: generation(1),
    chats: catalog,
  });
  await waitUntilIndexed();
  const indexingMs = performance.now() - indexingStarted;

  const workloads = [
    { name: 'common', text: 'commonterm' },
    { name: 'rare', text: 'rareterm' },
    { name: 'quoted', text: 'quoted phrase', phrase: true },
    { name: 'unicode', text: 'recherche' },
  ];
  for (let count = 0; count < warmups; count += 1) {
    for (const workload of workloads) await runSearch(workload);
  }
  const search = [];
  for (const workload of workloads) search.push(await measureSearch(workload));

  const burstSamples = [];
  for (let round = 0; round < 5; round += 1) {
    const started = performance.now();
    await Promise.all(workloads.map(runSearch));
    burstSamples.push(performance.now() - started);
  }

  const rebuildingCatalog = catalog.map((entry, index) => index === 0
    ? benchmarkEntry(entry.chatId, index, { revision: 'benchmark:changed', batchDelayMs: 250 })
    : entry);
  await service.reconcile({ generation: generation(2), chats: rebuildingCatalog });
  await waitForStatus((current) => current.pendingChatCount > 0);
  const activeRebuildSamples = [];
  for (let index = 0; index < 5; index += 1) {
    const started = performance.now();
    await runSearch(workloads[index % workloads.length]);
    activeRebuildSamples.push(performance.now() - started);
  }
  await waitUntilIndexed();

  const cancelled = new AbortController();
  cancelled.abort();
  const cancellationStarted = performance.now();
  await service.search({
    query: query('commonterm'),
    allowedChatIds,
    limit: 20,
    signal: cancelled.signal,
  }).catch(() => undefined);
  const cancellationMs = performance.now() - cancellationStarted;

  const deleteStarted = performance.now();
  service.deleteChat({ chatId: 'chat-1', generation: generation(3) });
  while ((await status()).indexedChatCount >= chatCount) await Bun.sleep(10);
  const deleteMs = performance.now() - deleteStarted;
  await service.close();

  eventLoop.disable();
  const dbPath = path.join(directory, 'transcript-search', 'index.sqlite');
  const databaseBytes = await totalSize([dbPath, `${dbPath}-wal`]);
  const eventLoopDelayP99Ms = Number(eventLoop.percentile(99)) / 1_000_000;
  const report = {
    implementation: 'shared indexer/reader Worker SQLite FTS',
    representedAgentCount,
    corpus: { chatCount, messagesPerChat, indexedMessages: chatCount * messagesPerChat },
    indexingMs: round(indexingMs),
    deleteMs: round(deleteMs),
    cancellationMs: round(cancellationMs),
    searchDuringActiveRebuildP99Ms: round(percentile(
      activeRebuildSamples.sort((left, right) => left - right),
      0.99,
    )),
    databaseBytes,
    eventLoopDelayP99Ms: round(eventLoopDelayP99Ms),
    workerRoles,
    concurrentSearchBurstMaxMs: round(Math.max(...burstSamples)),
    search,
  };
  console.log(JSON.stringify(report, null, 2));
  enforceGates(report);
} finally {
  eventLoop.disable();
  await service.close().catch(() => undefined);
  await rm(directory, { recursive: true, force: true });
}

async function waitUntilIndexed() {
  const deadline = Date.now() + 30 * 60_000;
  while (true) {
    const current = await status();
    if (current.indexedChatCount === chatCount) return;
    if (Date.now() >= deadline) throw new Error('Transcript search benchmark indexing timed out');
    await Bun.sleep(25);
  }
}

async function waitForStatus(predicate) {
  const deadline = Date.now() + 30_000;
  while (true) {
    const current = await status();
    if (predicate(current)) return;
    if (Date.now() >= deadline) throw new Error('Transcript search benchmark status transition timed out');
    await Bun.sleep(10);
  }
}

async function status() {
  return (await service.search({
    query: { version: 1, clauses: [] },
    allowedChatIds,
    limit: 1,
    signal: new AbortController().signal,
  })).index;
}

async function runSearch(workload) {
  return service.search({
    query: query(workload.text, workload.phrase),
    allowedChatIds,
    limit: 20,
    signal: new AbortController().signal,
  });
}

async function measureSearch(workload) {
  const samples = [];
  let resultCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    resultCount = (await runSearch(workload)).results.length;
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    name: workload.name,
    resultCount,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
    p99Ms: round(percentile(samples, 0.99)),
  };
}

function query(text, phrase = false) {
  const tokens = text.split(/\s+/u).map((token) => ({
    text: token,
    normalized: token.toLowerCase(),
    match: phrase || token.length < 3 ? 'exact' : 'prefix',
  }));
  return { version: 1, clauses: [{ kind: phrase ? 'phrase' : 'all-words', tokens }] };
}

function enforceGates(report) {
  const byName = Object.fromEntries(report.search.map((entry) => [entry.name, entry]));
  const failures = [];
  if (byName.rare.p95Ms > 150) failures.push(`rare search p95 ${byName.rare.p95Ms}ms > 150ms`);
  if (byName.common.p95Ms > 500) failures.push(`common search p95 ${byName.common.p95Ms}ms > 500ms`);
  if (Math.max(...report.search.map((entry) => entry.p99Ms)) > 500) failures.push('search p99 > 500ms');
  if (report.concurrentSearchBurstMaxMs > 1_800) failures.push('concurrent search burst > 1800ms');
  if (report.searchDuringActiveRebuildP99Ms > 500) failures.push('search during rebuild p99 > 500ms');
  if (report.deleteMs > 2_000) failures.push(`delete ${report.deleteMs}ms > 2000ms`);
  if (report.cancellationMs > 1_000) failures.push(`cancellation ${report.cancellationMs}ms > 1000ms`);
  if (report.eventLoopDelayP99Ms > 20) failures.push(`event-loop p99 ${report.eventLoopDelayP99Ms}ms > 20ms`);
  if (report.databaseBytes > 1.2 * 1024 ** 3) failures.push('database > 1.2GB');
  if (report.representedAgentCount !== 10) failures.push('benchmark does not represent ten agents');
  if (report.workerRoles.join(',') !== 'indexer,reader') failures.push('fixed Worker topology is not two Workers');
  if (failures.length > 0) throw new Error(`Transcript search benchmark gates failed:\n${failures.join('\n')}`);
}

function benchmarkEntry(chatId, chatIndex, overrides = {}) {
  const agentId = agentIds[chatIndex % agentIds.length];
  return {
    chatId,
    agentId,
    model: 'benchmark',
    updatedAt: null,
    carryOverRevision: 'carry-v1:0',
    source: {
      state: 'ready',
      reference: {
        ownerId: agentId,
        schemaVersion: 1,
        value: {
          chatIndex,
          messagesPerChat,
          revision: `benchmark:${chatIndex}`,
          ...overrides,
        },
      },
    },
  };
}

async function totalSize(files) {
  const sizes = await Promise.all(files.map((file) => (
    stat(file).then((entry) => entry.size).catch(() => 0)
  )));
  return sizes.reduce((total, size) => total + size, 0);
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

function percentile(values, quantile) {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}

async function* emptyBatches() {}
