#!/usr/bin/env bun

import { mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  closeSearchDatabase,
  openSearchDatabase,
  replaceChatRows,
} from '../server/chats/search/schema.js';
import { TranscriptSearchWorkerClient } from '../server/chats/search/worker-client.js';
import { UserMessage } from '../common/chat-types.js';
import { projectLiveMessages } from '../server/chats/search/message-projector.js';

const chatCount = positiveInteger('GARCON_SEARCH_BENCH_CHATS', 3_000);
const messagesPerChat = positiveInteger('GARCON_SEARCH_BENCH_MESSAGES', 334);
const iterations = positiveInteger('GARCON_SEARCH_BENCH_ITERATIONS', 20);
const warmups = positiveInteger('GARCON_SEARCH_BENCH_WARMUPS', 4);
const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-v3-benchmark-'));
const dbPath = path.join(directory, 'chat-search-v3.sqlite');
const allowedChatIds = Array.from({ length: chatCount }, (_, index) => `chat-${index}`);
const searchAllowedChatIds = allowedChatIds.slice(0, 1_000);
let setupDb = null;
let client = null;

try {
  // Corpus creation is setup. Every measured operation crosses the production Worker boundary.
  const opened = await openSearchDatabase(dbPath);
  setupDb = opened.db;
  const indexingStarted = performance.now();
  for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
    replaceChatRows(
      setupDb,
      `chat-${chatIndex}`,
      chatIndex + 1,
      `benchmark:${chatIndex}:sha256:fixture`,
      rowsForChat(chatIndex),
    );
  }
  replaceChatRows(setupDb, 'delete-target', 1, 'benchmark:delete:sha256:fixture', rowsForDeleteTarget());
  const indexingMs = performance.now() - indexingStarted;
  closeSearchDatabase(setupDb);
  setupDb = null;

  const eventLoop = startEventLoopSampler();
  const cpuStarted = process.cpuUsage();
  const measuredStarted = performance.now();
  client = new TranscriptSearchWorkerClient(1);
  await client.open(dbPath);

  const backgroundDuty = await measureBackgroundDuty();
  const projectionP95Ms = measureLiveProjection();
  const worstCaseProjectionP95Ms = measureWorstCaseLiveProjection();

  const workloads = [
    { name: 'common', query: 'commonterm' },
    { name: 'rare', query: 'rareterm' },
    { name: 'cross-message', query: 'alphaterm betaterm' },
    { name: 'quoted', query: '"quoted phrase"' },
    { name: 'unicode', query: 'recherche' },
  ];
  for (let count = 0; count < warmups; count += 1) {
    for (const workload of workloads) await runSearch(workload.query);
  }
  const search = [];
  for (const workload of workloads) search.push(await measureSearch(workload));

  const appendSamples = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    await client.request({
      type: 'append',
      chatId: `chat-${index}`,
      generation: chatCount + index + 1,
      rows: [{ role: 'assistant', timestamp: null, body: `live append ${index}` }],
    });
    appendSamples.push(performance.now() - started);
  }

  const cancellationMs = await measureCancellation();
  const deleteStarted = performance.now();
  await client.request({ type: 'delete-chat', chatId: 'delete-target', generation: 2 });
  const deleteMs = performance.now() - deleteStarted;
  await client.close();
  client = null;

  const measuredMs = performance.now() - measuredStarted;
  const cpu = process.cpuUsage(cpuStarted);
  const processCpuMs = (cpu.user + cpu.system) / 1_000;
  const eventLoopDelay = eventLoop.stop();
  const dbBytes = (await stat(dbPath)).size;
  const result = {
    chatCount,
    messagesPerChat,
    indexedMessages: chatCount * messagesPerChat,
    indexingMs,
    dbBytes,
    search,
    appendP95Ms: percentile(appendSamples, 0.95),
    deleteMs,
    cancellationMs,
    eventLoopDelayP99Ms: percentile(eventLoopDelay, 0.99),
    processCpuMs,
    measuredMs,
    processCpuDuty: processCpuMs / measuredMs,
    backgroundDuty,
    projectionP95Ms,
    worstCaseProjectionP95Ms,
  };
  console.log(JSON.stringify(result, null, 2));

  const failures = [];
  for (const workload of search) {
    if (workload.p95Ms > 150) failures.push(`${workload.name} search p95 ${workload.p95Ms.toFixed(1)}ms > 150ms`);
    if (workload.p99Ms > 500) failures.push(`${workload.name} search p99 ${workload.p99Ms.toFixed(1)}ms > 500ms`);
  }
  if (projectionP95Ms > 5) failures.push(`live projection p95 ${projectionP95Ms.toFixed(1)}ms > 5ms`);
  if (worstCaseProjectionP95Ms > 10) {
    failures.push(`worst-case live projection p95 ${worstCaseProjectionP95Ms.toFixed(1)}ms > 10ms`);
  }
  if (result.appendP95Ms > 20) failures.push(`append p95 ${result.appendP95Ms.toFixed(1)}ms > 20ms`);
  if (deleteMs > 1_500) failures.push(`delete ${deleteMs.toFixed(1)}ms > 1500ms`);
  if (cancellationMs > 1_000) failures.push(`cancellation ${cancellationMs.toFixed(1)}ms > 1000ms`);
  if (backgroundDuty.cpuDuty > 0.35) {
    failures.push(`background CPU duty ${(backgroundDuty.cpuDuty * 100).toFixed(1)}% > 35%`);
  }
  if (result.eventLoopDelayP99Ms > 20) {
    failures.push(`event-loop delay p99 ${result.eventLoopDelayP99Ms.toFixed(1)}ms > 20ms`);
  }
  if (dbBytes > 1_200_000_000) failures.push(`database size ${dbBytes} bytes > 1.2GB`);
  if (failures.length > 0) throw new Error(`Transcript search benchmark gates failed:\n${failures.join('\n')}`);
} finally {
  if (client) await client.terminate();
  if (setupDb) closeSearchDatabase(setupDb);
  await rm(directory, { recursive: true, force: true });
}

function rowsForChat(chatIndex) {
  return Array.from({ length: messagesPerChat }, (_, messageIndex) => {
    const terms = [`chatword${chatIndex % 97}`, `messageword${messageIndex % 31}`];
    if (messageIndex === 0) terms.push('commonterm');
    if (chatIndex % 50 === 0 && messageIndex === 0) terms.push('rareterm');
    if (chatIndex % 10 === 0 && messageIndex === 1) terms.push('alphaterm');
    if (chatIndex % 10 === 0 && messageIndex === 2) terms.push('betaterm');
    if (chatIndex % 40 === 0 && messageIndex === 3) terms.push('quoted phrase');
    if (chatIndex % 30 === 0 && messageIndex === 4) terms.push('recherche');
    if (chatIndex === 0 && messageIndex === 5) terms.push('tool-output', 'x'.repeat(64_000));
    return {
      messageOrdinal: messageIndex + 1,
      role: messageIndex % 2 === 0 ? 'user' : 'assistant',
      timestamp: null,
      body: `${terms.join(' ')} synthetic transcript payload ${'context '.repeat(12)}`,
    };
  });
}

function rowsForDeleteTarget() {
  return Array.from({ length: 10_000 }, (_, index) => ({
    messageOrdinal: index + 1,
    role: index % 2 === 0 ? 'user' : 'assistant',
    timestamp: null,
    body: `large deletion target ${index} ${'payload '.repeat(8)}`,
  }));
}

async function runSearch(query) {
  const response = await client.request({ type: 'search', query, allowedChatIds: searchAllowedChatIds, limit: 20 });
  if (response.type !== 'search-result') throw new Error('Unexpected transcript search benchmark response');
  return response;
}

async function measureSearch(workload) {
  const samples = [];
  let resultCount = 0;
  for (let count = 0; count < iterations; count += 1) {
    const started = performance.now();
    const result = await runSearch(workload.query);
    samples.push(performance.now() - started);
    resultCount = result.results.length;
  }
  return {
    name: workload.name,
    resultCount,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    p99Ms: percentile(samples, 0.99),
    maxMs: Math.max(...samples),
  };
}

function measureLiveProjection() {
  const messages = Array.from({ length: 64 }, (_, index) => new UserMessage(
    new Date(index).toISOString(),
    `projection message ${index} ${'payload '.repeat(12)}`,
  ));
  const samples = [];
  for (let iteration = 0; iteration < 100; iteration += 1) {
    const started = performance.now();
    projectLiveMessages(messages);
    samples.push(performance.now() - started);
  }
  return percentile(samples, 0.95);
}

function measureWorstCaseLiveProjection() {
  const message = new UserMessage(
    '2026-01-01T00:00:00.000Z',
    'x '.repeat(32_000),
  );
  const messages = Array(2_048).fill(message);
  const samples = [];
  for (let iteration = 0; iteration < 20; iteration += 1) {
    const started = performance.now();
    projectLiveMessages(messages);
    samples.push(performance.now() - started);
  }
  return percentile(samples, 0.95);
}

async function measureCancellation() {
  const transcriptPath = path.join(directory, 'cancellation.jsonl');
  await writeFile(transcriptPath, Array.from({ length: 5_000 }, (_, index) => JSON.stringify({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `cancellation historical ${index}`,
    timestamp: new Date(index).toISOString(),
  })).join('\n'));
  const rebuild = client.request({
    type: 'rebuild-chat',
    chatId: 'cancellation-target',
    generation: 1,
    buildSource: {
      source: { kind: 'direct-jsonl', nativePath: transcriptPath },
      currentAgentId: 'direct-chat',
      currentModel: 'benchmark',
    },
  });
  await Bun.sleep(5);
  const started = performance.now();
  await client.request({
    type: 'append',
    chatId: 'cancellation-target',
    generation: 2,
    rows: [{ role: 'user', timestamp: null, body: 'cancellation winner' }],
  });
  await rebuild;
  return performance.now() - started;
}

async function measureBackgroundDuty() {
  const transcriptPath = path.join(directory, 'duty-cycle.jsonl');
  const rowCount = positiveInteger('GARCON_SEARCH_BENCH_DUTY_MESSAGES', 20_000);
  await writeFile(transcriptPath, Array.from({ length: rowCount }, (_, index) => JSON.stringify({
    role: index % 2 === 0 ? 'user' : 'assistant',
    content: `background duty transcript ${index} ${'payload '.repeat(12)}`,
    timestamp: new Date(index).toISOString(),
  })).join('\n'));
  const cpuStarted = process.cpuUsage();
  const started = performance.now();
  await client.request({
    type: 'rebuild-chat',
    chatId: 'duty-cycle-target',
    generation: 1,
    buildSource: {
      source: { kind: 'direct-jsonl', nativePath: transcriptPath },
      currentAgentId: 'direct-chat',
      currentModel: 'benchmark',
    },
  });
  const observationWindowMs = positiveInteger('GARCON_SEARCH_BENCH_DUTY_WINDOW_MS', 60_000);
  const remainingWindowMs = observationWindowMs - (performance.now() - started);
  if (remainingWindowMs > 0) await Bun.sleep(remainingWindowMs);
  const elapsedMs = performance.now() - started;
  const cpu = process.cpuUsage(cpuStarted);
  const cpuMs = (cpu.user + cpu.system) / 1_000;
  return { rowCount, observationWindowMs, elapsedMs, cpuMs, cpuDuty: cpuMs / elapsedMs };
}

function startEventLoopSampler(periodMs = 5) {
  const delays = [];
  let expected = performance.now() + periodMs;
  const timer = setInterval(() => {
    const now = performance.now();
    delays.push(Math.max(0, now - expected));
    expected = now + periodMs;
  }, periodMs);
  return {
    stop() {
      clearInterval(timer);
      return delays.length > 0 ? delays : [0];
    },
  };
}

function percentile(samples, fraction) {
  const sorted = [...samples].sort((left, right) => left - right);
  return sorted[Math.min(sorted.length - 1, Math.floor(sorted.length * fraction))];
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}
