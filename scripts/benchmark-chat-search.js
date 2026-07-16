#!/usr/bin/env bun

import { stat, mkdtemp, rm } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { performance } from 'node:perf_hooks';
import {
  appendChatRows,
  deleteChatRows,
  openSearchDatabase,
  replaceChatRows,
} from '../server/chats/search/schema.js';
import { searchTranscriptIndex } from '../server/chats/search/query.js';

const chatCount = positiveInteger('GARCON_SEARCH_BENCH_CHATS', 3_000);
const messagesPerChat = positiveInteger('GARCON_SEARCH_BENCH_MESSAGES', 334);
const iterations = positiveInteger('GARCON_SEARCH_BENCH_ITERATIONS', 20);
const warmups = positiveInteger('GARCON_SEARCH_BENCH_WARMUPS', 4);
const directory = await mkdtemp(path.join(os.tmpdir(), 'garcon-search-v3-benchmark-'));
const dbPath = path.join(directory, 'chat-search-v3.sqlite');
const allowedChatIds = Array.from({ length: chatCount }, (_, index) => `chat-${index}`);
let db = null;

try {
  const opened = await openSearchDatabase(dbPath);
  db = opened.db;
  const indexingStarted = performance.now();
  for (let chatIndex = 0; chatIndex < chatCount; chatIndex += 1) {
    replaceChatRows(
      db,
      `chat-${chatIndex}`,
      chatIndex + 1,
      `benchmark:${chatIndex}:sha256:fixture`,
      rowsForChat(chatIndex),
    );
  }
  const indexingMs = performance.now() - indexingStarted;

  const workloads = [
    { name: 'common', query: 'commonterm' },
    { name: 'rare', query: 'rareterm' },
    { name: 'cross-message', query: 'alphaterm betaterm' },
    { name: 'quoted', query: '"quoted phrase"' },
    { name: 'unicode', query: 'recherche' },
  ];
  for (let count = 0; count < warmups; count += 1) {
    for (const workload of workloads) runSearch(workload.query);
  }
  const search = workloads.map(measureSearch);

  const appendSamples = [];
  for (let index = 0; index < 100; index += 1) {
    const started = performance.now();
    appendChatRows(db, `chat-${index}`, chatCount + index + 1, [{
      role: 'assistant',
      timestamp: null,
      body: `live append ${index}`,
    }]);
    appendSamples.push(performance.now() - started);
  }

  const deleteStarted = performance.now();
  db = deleteChatRows(db, 'chat-0');
  const deleteMs = performance.now() - deleteStarted;
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
  };
  console.log(JSON.stringify(result, null, 2));

  const failures = [];
  for (const workload of search) {
    if (workload.p95Ms > 150) failures.push(`${workload.name} search p95 ${workload.p95Ms.toFixed(1)}ms > 150ms`);
  }
  if (result.appendP95Ms > 20) failures.push(`append p95 ${result.appendP95Ms.toFixed(1)}ms > 20ms`);
  if (deleteMs > 1_000) failures.push(`delete ${deleteMs.toFixed(1)}ms > 1000ms`);
  if (failures.length > 0) throw new Error(`Transcript search benchmark gates failed:\n${failures.join('\n')}`);
} finally {
  db?.close();
  await rm(directory, { recursive: true, force: true });
}

function rowsForChat(chatIndex) {
  return Array.from({ length: messagesPerChat }, (_, messageIndex) => {
    const terms = ['commonterm', `chatword${chatIndex % 97}`, `messageword${messageIndex % 31}`];
    if (chatIndex % 50 === 0 && messageIndex === 0) terms.push('rareterm');
    if (chatIndex % 10 === 0 && messageIndex === 1) terms.push('alphaterm');
    if (chatIndex % 10 === 0 && messageIndex === 2) terms.push('betaterm');
    if (chatIndex % 40 === 0 && messageIndex === 3) terms.push('quoted phrase');
    if (chatIndex % 30 === 0 && messageIndex === 4) terms.push('recherche');
    return {
      messageOrdinal: messageIndex + 1,
      role: messageIndex % 2 === 0 ? 'user' : 'assistant',
      timestamp: null,
      body: `${terms.join(' ')} synthetic transcript payload ${'context '.repeat(12)}`,
    };
  });
}

function runSearch(query) {
  return searchTranscriptIndex(db, { query, allowedChatIds, limit: 20 });
}

function measureSearch(workload) {
  const samples = [];
  let resultCount = 0;
  for (let count = 0; count < iterations; count += 1) {
    const started = performance.now();
    const result = runSearch(workload.query);
    samples.push(performance.now() - started);
    resultCount = result.results.length;
  }
  return {
    name: workload.name,
    resultCount,
    p50Ms: percentile(samples, 0.5),
    p95Ms: percentile(samples, 0.95),
    maxMs: Math.max(...samples),
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

