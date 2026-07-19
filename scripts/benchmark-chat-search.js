#!/usr/bin/env bun

import { mkdtemp, rm, stat } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  closeSearchDatabase,
  deleteChatRows,
  openSearchDatabase,
  replaceChatRows,
} from '../server-agents/common/src/search/schema.ts';
import { searchTranscriptIndex } from '../server-agents/common/src/search/query.ts';

const chatCount = positiveInteger('GARCON_SEARCH_BENCH_CHATS', 3_000);
const messagesPerChat = positiveInteger('GARCON_SEARCH_BENCH_MESSAGES', 334);
const iterations = positiveInteger('GARCON_SEARCH_BENCH_ITERATIONS', 20);
const warmups = positiveInteger('GARCON_SEARCH_BENCH_WARMUPS', 4);
const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-integration-search-benchmark-'));
const dbPath = path.join(directory, 'index.sqlite');
const allowedChatIds = Array.from({ length: chatCount }, (_, index) => `chat-${index}`);
let database;

try {
  database = await openSearchDatabase(dbPath);
  const indexingStarted = performance.now();
  for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
    replaceChatRows(
      database.db,
      `chat-${chatIndex}`,
      chatIndex + 1,
      `benchmark:${chatIndex}`,
      rowsForChat(chatIndex),
    );
  }
  const indexingMs = performance.now() - indexingStarted;

  const workloads = [
    { name: 'common', query: 'commonterm' },
    { name: 'rare', query: 'rareterm' },
    { name: 'quoted', query: '"quoted phrase"' },
    { name: 'unicode', query: 'recherche' },
  ];
  for (let count = 0; count < warmups; count += 1) {
    for (const workload of workloads) runSearch(workload.query);
  }
  const search = workloads.map(measureSearch);

  const replaceStarted = performance.now();
  replaceChatRows(database.db, 'chat-0', chatCount + 1, 'benchmark:replacement', rowsForChat(0));
  const replaceMs = performance.now() - replaceStarted;

  const deleteStarted = performance.now();
  deleteChatRows(database.db, 'chat-1', chatCount + 2);
  const deleteMs = performance.now() - deleteStarted;

  database.db.query('PRAGMA wal_checkpoint(TRUNCATE)').get();
  const bytes = await stat(dbPath).then((entry) => entry.size);
  console.log(JSON.stringify({
    implementation: 'server-agents/common integration-owned SQLite FTS',
    corpus: { chatCount, messagesPerChat, indexedMessages: chatCount * messagesPerChat },
    indexingMs: round(indexingMs),
    replaceMs: round(replaceMs),
    deleteMs: round(deleteMs),
    databaseBytes: bytes,
    search,
  }, null, 2));
} finally {
  if (database) closeSearchDatabase(database.db);
  await rm(directory, { recursive: true, force: true });
}

function rowsForChat(chatIndex) {
  return Array.from({ length: messagesPerChat }, (_, messageIndex) => ({
    messageOrdinal: messageIndex,
    role: messageIndex % 2 === 0 ? 'user' : 'assistant',
    timestamp: null,
    body: [
      'synthetic commonterm transcript content',
      chatIndex % 997 === 0 ? 'rareterm' : '',
      messageIndex % 31 === 0 ? 'quoted phrase' : '',
      messageIndex % 47 === 0 ? 'recherche' : '',
      `chat${chatIndex} message${messageIndex}`,
    ].filter(Boolean).join(' '),
  }));
}

function runSearch(query) {
  return searchTranscriptIndex(database.db, {
    query,
    allowedChatIds,
    limit: 20,
  });
}

function measureSearch(workload) {
  const samples = [];
  let resultCount = 0;
  for (let index = 0; index < iterations; index += 1) {
    const started = performance.now();
    resultCount = runSearch(workload.query).results.length;
    samples.push(performance.now() - started);
  }
  samples.sort((left, right) => left - right);
  return {
    name: workload.name,
    resultCount,
    p50Ms: round(percentile(samples, 0.5)),
    p95Ms: round(percentile(samples, 0.95)),
  };
}

function positiveInteger(name, fallback) {
  const value = Number(process.env[name] ?? fallback);
  if (!Number.isSafeInteger(value) || value <= 0) {
    throw new Error(`${name} must be a positive integer`);
  }
  return value;
}

function percentile(values, quantile) {
  return values[Math.min(values.length - 1, Math.floor(values.length * quantile))] ?? 0;
}

function round(value) {
  return Math.round(value * 100) / 100;
}
