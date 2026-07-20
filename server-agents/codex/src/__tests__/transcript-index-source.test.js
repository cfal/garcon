import { describe, expect, it, mock } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { createCodexTranscriptIndexSource } from '../transcript-index-source.ts';

const logger = { debug() {}, info() {}, warn() {}, error() {} };
const limits = {
  maxMessagesPerBatch: 2,
  maxBatchBytes: 100_000,
  maxRecordBytes: 100_000,
};

async function withRollout(payload, rows, run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-index-source-'));
  const nativePath = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(nativePath, `${[
    { type: 'session_meta', timestamp: '2026-07-20T00:00:00.000Z', payload },
    ...rows,
  ].map((row) => JSON.stringify(row)).join('\n')}\n`);
  try {
    return await run({ directory, nativePath });
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function descriptor(nativePath, historyMode = 'legacy') {
  return {
    ownerId: 'codex',
    schemaVersion: 2,
    value: { nativePath, threadId: 'thread-1', historyMode, codexHome: '/tmp/codex-home' },
  };
}

async function collect(iterable) {
  const batches = [];
  for await (const batch of iterable) batches.push(batch);
  return batches;
}

describe('Codex transcript index source', () => {
  it('loads legacy history from an immutable snapshot in bounded batches', async () => {
    await withRollout({ id: 'thread-1', history_mode: 'legacy' }, [
      {
        type: 'event_msg', timestamp: '2026-07-20T00:00:01.000Z',
        payload: { type: 'user_message', message: 'hello' },
      },
      {
        type: 'response_item', timestamp: '2026-07-20T00:00:02.000Z',
        payload: { type: 'message', role: 'assistant', content: [{ type: 'output_text', text: 'world' }] },
      },
    ], async ({ directory, nativePath }) => {
      const createClient = mock(() => { throw new Error('legacy indexing opened app-server'); });
      const source = createCodexTranscriptIndexSource({ agentId: 'codex', logger }, { createClient });
      const batches = await collect(source.load({
        source: descriptor(nativePath),
        signal: new AbortController().signal,
        limits: { ...limits, maxMessagesPerBatch: 1 },
        scratchDirectory: path.join(directory, 'scratch'),
      }));

      expect(batches.map((batch) => batch.map((message) => message.type))).toEqual([
        ['user-message'],
        ['assistant-message'],
      ]);
      expect(createClient).not.toHaveBeenCalled();
      await source.close();
    });
  });

  it('loads paginated history through one reused app-server client and probes stability', async () => {
    await withRollout({ id: 'thread-1', history_mode: 'paginated', history_base: null }, [], async ({ directory, nativePath }) => {
      const listThreadTurns = mock(async (request) => {
        const turn = {
          id: 'turn-1',
          items: request.itemsView === 'full' ? [{
            type: 'agentMessage', id: 'message-1', text: 'indexed', phase: null, memoryCitation: null,
          }] : [],
          itemsView: 'full',
          status: 'completed',
          error: null,
          startedAt: 1_753_056_000,
          completedAt: 1_753_056_001,
          durationMs: 1_000,
        };
        return { data: [turn], nextCursor: null, backwardsCursor: null };
      });
      const shutdown = mock();
      const createClient = mock(() => ({ listThreadTurns, shutdown }));
      const source = createCodexTranscriptIndexSource({ agentId: 'codex', logger }, { createClient });

      const batches = await collect(source.load({
        source: descriptor(nativePath, 'paginated'),
        signal: new AbortController().signal,
        limits,
        scratchDirectory: path.join(directory, 'scratch'),
      }));

      expect(batches.flat().map((message) => [message.type, message.content])).toEqual([
        ['assistant-message', 'indexed'],
      ]);
      expect(listThreadTurns.mock.calls.map(([request]) => request.sortDirection)).toEqual([
        'desc',
        'asc',
        'desc',
      ]);
      expect(createClient).toHaveBeenCalledTimes(1);
      expect(shutdown).not.toHaveBeenCalled();
      await source.close();
      expect(shutdown).toHaveBeenCalledTimes(1);
    });
  });

  it('requests descriptor refresh for schema one and rejects inherited paginated history', async () => {
    const source = createCodexTranscriptIndexSource({ agentId: 'codex', logger });
    await expect(source.probe({
      ownerId: 'codex', schemaVersion: 1, value: { nativePath: '/tmp/old.jsonl' },
    }, new AbortController().signal)).rejects.toMatchObject({
      failure: { code: 'SOURCE_DESCRIPTOR_INVALID', retryable: false, refreshSource: true },
    });
    await source.close();

    await withRollout({
      id: 'thread-1', history_mode: 'paginated',
      history_base: { thread_id: 'thread-0', end_ordinal_exclusive: 1, end_byte_offset: 10 },
    }, [], async ({ nativePath }) => {
      const inherited = createCodexTranscriptIndexSource({ agentId: 'codex', logger });
      await expect(inherited.probe(
        descriptor(nativePath, 'paginated'),
        new AbortController().signal,
      )).rejects.toMatchObject({
        failure: { code: 'SOURCE_UNSUPPORTED', retryable: false, refreshSource: true },
      });
      await inherited.close();
    });
  });

  it('rejects a paginated snapshot when its source changes during projection', async () => {
    await withRollout({ id: 'thread-1', history_mode: 'paginated', history_base: null }, [], async ({ directory, nativePath }) => {
      const turn = {
        id: 'turn-1',
        items: [],
        itemsView: 'full',
        status: 'completed',
        error: null,
        startedAt: 1_753_056_000,
        completedAt: 1_753_056_001,
        durationMs: 1_000,
      };
      const listThreadTurns = mock(async (request) => {
        if (request.sortDirection === 'asc') {
          await fs.appendFile(nativePath, `${JSON.stringify({ type: 'turn_context' })}\n`);
        }
        return { data: [turn], nextCursor: null, backwardsCursor: null };
      });
      const source = createCodexTranscriptIndexSource({ agentId: 'codex', logger }, {
        createClient: () => ({ listThreadTurns, shutdown() {} }),
      });

      await expect(collect(source.load({
        source: descriptor(nativePath, 'paginated'),
        signal: new AbortController().signal,
        limits,
        scratchDirectory: path.join(directory, 'scratch'),
      }))).rejects.toMatchObject({
        failure: { code: 'SOURCE_CHANGED', retryable: true, refreshSource: false },
      });
      await source.close();
    });
  });
});
