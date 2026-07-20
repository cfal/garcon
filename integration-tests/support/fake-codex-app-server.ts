#!/usr/bin/env bun

import { appendFileSync, readFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

export {};

const decoder = new TextDecoder();
let buffered = '';

for await (const chunk of Bun.stdin.stream()) {
  buffered += decoder.decode(chunk, { stream: true });
  let newline = buffered.indexOf('\n');
  while (newline >= 0) {
    respond(buffered.slice(0, newline));
    buffered = buffered.slice(newline + 1);
    newline = buffered.indexOf('\n');
  }
}
if (buffered.trim()) respond(buffered);

function respond(line: string): void {
  if (!line.trim()) return;
  const request = JSON.parse(line) as { id?: number; method?: string };
  if (typeof request.id !== 'number') return;
  if (request.method === 'initialize') {
    write(request.id, {
      userAgent: 'integration-fake-codex',
      codexHome: process.env.CODEX_HOME ?? '',
      platformFamily: 'unix',
      platformOs: 'linux',
    });
    return;
  }
  if (request.method === 'thread/list') {
    const threadId = process.env.INTEGRATION_CODEX_THREAD_ID;
    const nativePath = process.env.INTEGRATION_CODEX_NATIVE_PATH;
    const discovered = process.env.INTEGRATION_CODEX_DISCOVER_JSONL === '1'
      ? discoverCodexThreads()
      : [];
    write(request.id, {
      data: threadId && nativePath ? [{ id: threadId, path: nativePath }, ...discovered] : discovered,
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (request.method === 'thread/loaded/list') {
    write(request.id, { data: [] });
    return;
  }
  if (request.method === 'thread/turns/list') {
    const items = process.env.INTEGRATION_CODEX_HISTORY_FIXTURE === '1' ? [
      { type: 'userMessage', id: 'user-1', content: [{ type: 'text', text: 'paginated prompt' }] },
      { type: 'agentMessage', id: 'assistant-1', text: 'paginated answer', phase: null, memoryCitation: null },
    ] : [];
    write(request.id, {
      data: items.length > 0 ? [{
        id: 'turn-1',
        items,
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1_753_056_000,
        completedAt: 1_753_056_001,
        durationMs: 1_000,
      }] : [],
      nextCursor: null,
      backwardsCursor: null,
    });
    return;
  }
  if (request.method === 'thread/fork') {
    const callLog = process.env.INTEGRATION_CODEX_CALL_LOG;
    if (callLog) appendFileSync(callLog, 'thread/fork\n');
    process.stdout.write(`${JSON.stringify({
      id: request.id,
      error: { code: -32601, message: 'paginated_threads is not supported yet' },
    })}\n`);
    return;
  }
  process.stdout.write(`${JSON.stringify({
    id: request.id,
    error: { code: -32601, message: `Unsupported integration fixture method ${request.method}` },
  })}\n`);
}

function write(id: number, result: unknown): void {
  process.stdout.write(`${JSON.stringify({ id, result })}\n`);
}

function discoverCodexThreads(): Array<{ id: string; path: string }> {
  const codexHome = process.env.CODEX_HOME;
  if (!codexHome) return [];
  const files: string[] = [];
  collectJsonlFiles(join(codexHome, 'sessions'), files);
  return files.flatMap((path) => {
    try {
      const firstLine = readFileSync(path, 'utf8').split('\n').find((line) => line.trim());
      const entry = firstLine ? JSON.parse(firstLine) as {
        type?: unknown;
        payload?: { id?: unknown };
      } : null;
      return entry?.type === 'session_meta' && typeof entry.payload?.id === 'string'
        ? [{ id: entry.payload.id, path }]
        : [];
    } catch {
      return [];
    }
  });
}

function collectJsonlFiles(directory: string, files: string[]): void {
  try {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const path = join(directory, entry.name);
      if (entry.isDirectory()) collectJsonlFiles(path, files);
      else if (entry.isFile() && entry.name.endsWith('.jsonl')) files.push(path);
    }
  } catch {
    return;
  }
}
