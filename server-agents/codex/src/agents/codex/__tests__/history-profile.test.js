import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { inspectCodexHistoryProfile } from '../history-profile.ts';

async function withProfile(payload, run, timestamp = '2026-07-20T00:00:00.000Z') {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-history-profile-'));
  const nativePath = path.join(directory, 'rollout.jsonl');
  await fs.writeFile(nativePath, `${JSON.stringify({ type: 'session_meta', timestamp, payload })}\n`);
  try {
    return await run(nativePath);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

describe('inspectCodexHistoryProfile', () => {
  it('treats a missing history mode as legacy', async () => {
    await withProfile({ id: 'thread-1' }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        expectedThreadId: 'thread-1',
        signal: new AbortController().signal,
      })).resolves.toEqual({
        mode: 'legacy',
        nativePath,
        threadId: 'thread-1',
        createdAt: '2026-07-20T00:00:00.000Z',
      });
    });
  });

  it('parses paginated history and its inherited base', async () => {
    await withProfile({
      id: 'thread-1',
      timestamp: '2026-07-20T01:00:00.000Z',
      history_mode: 'paginated',
      history_base: {
        thread_id: 'thread-0',
        end_ordinal_exclusive: 12,
        end_byte_offset: 4096,
      },
    }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: new AbortController().signal,
      })).resolves.toMatchObject({
        mode: 'paginated',
        threadId: 'thread-1',
        createdAt: '2026-07-20T01:00:00.000Z',
        historyBase: {
          threadId: 'thread-0',
          endOrdinalExclusive: 12,
          endByteOffset: 4096,
        },
      });
    });
  });

  it('fails closed for unknown modes', async () => {
    await withProfile({ id: 'thread-1', history_mode: 'future' }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({
        code: 'OPERATION_UNSUPPORTED',
        retryable: false,
        details: { operation: 'load-history', historyMode: 'future', provider: 'codex' },
      });
    });
  });

  it('requires an RFC 3339 metadata timestamp', async () => {
    await withProfile({ id: 'thread-1' }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    }, 'July 20, 2026');
  });

  it('rejects an oversized first record without loading the rollout', async () => {
    await withProfile({
      id: 'thread-1',
      padding: 'x'.repeat(1024 * 1024),
    }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    });
  });

  it('rejects malformed bases and mismatched thread ids', async () => {
    await withProfile({
      id: 'thread-1',
      history_mode: 'paginated',
      history_base: { thread_id: 'thread-0', end_ordinal_exclusive: -1, end_byte_offset: 0 },
    }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    });

    await withProfile({ id: 'thread-1' }, async (nativePath) => {
      await expect(inspectCodexHistoryProfile({
        nativePath,
        expectedThreadId: 'thread-2',
        signal: new AbortController().signal,
      })).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
    });
  });

  it('honors an already-aborted signal', async () => {
    await withProfile({ id: 'thread-1' }, async (nativePath) => {
      const controller = new AbortController();
      controller.abort(new Error('stop'));
      await expect(inspectCodexHistoryProfile({
        nativePath,
        signal: controller.signal,
      })).rejects.toThrow('stop');
    });
  });
});
