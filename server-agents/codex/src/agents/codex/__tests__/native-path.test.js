import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { resolveCodexNativePath } from '../native-path.ts';

function createLogger() {
  const entries = [];
  return {
    entries,
    logger: {
      debug(message, fields) {
        entries.push({ level: 'debug', message, fields });
      },
      info(message, fields) {
        entries.push({ level: 'info', message, fields });
      },
      warn(message, fields) {
        entries.push({ level: 'warn', message, fields });
      },
      error(message, fields) {
        entries.push({ level: 'error', message, fields });
      },
    },
  };
}

async function writeTranscript(directory, fileName, threadId) {
  const nativePath = path.join(directory, fileName);
  await fs.writeFile(
    nativePath,
    `${JSON.stringify({
      type: 'session_meta',
      timestamp: '2026-07-24T00:00:00.000Z',
      payload: { id: threadId },
    })}\n`,
  );
  return nativePath;
}

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-native-path-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

function options(discover, logger, signal = new AbortController().signal) {
  return { discover, logger, signal };
}

describe('resolveCodexNativePath', () => {
  it('preserves a valid stored path without discovery', async () => {
    await withDirectory(async (directory) => {
      const nativePath = await writeTranscript(directory, 'stored.jsonl', 'thread-1');
      let discoveryCalls = 0;
      const { logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          { agentSessionId: 'thread-1', nativePath },
          options(async () => {
            discoveryCalls += 1;
            return null;
          }, logger),
        ),
      ).resolves.toBe(nativePath);
      expect(discoveryCalls).toBe(0);
    });
  });

  it('uses a valid discovered path when the stored path is missing', async () => {
    await withDirectory(async (directory) => {
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl', 'thread-1');
      const { logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          {
            agentSessionId: 'thread-1',
            nativePath: path.join(directory, 'missing.jsonl'),
          },
          options(async () => discoveredPath, logger),
        ),
      ).resolves.toBe(discoveredPath);
    });
  });

  it('uses normal discovery for a pathless reference', async () => {
    await withDirectory(async (directory) => {
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl', 'thread-1');
      const { logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          { agentSessionId: 'thread-1', nativePath: null },
          options(async () => discoveredPath, logger),
        ),
      ).resolves.toBe(discoveredPath);
    });
  });

  it('returns null when a missing stored path is not discovered', async () => {
    await withDirectory(async (directory) => {
      const { logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          {
            agentSessionId: 'thread-1',
            nativePath: path.join(directory, 'missing.jsonl'),
          },
          options(async () => null, logger),
        ),
      ).resolves.toBeNull();
    });
  });

  it('propagates non-missing stored path failures without attempting discovery', async () => {
    await withDirectory(async (directory) => {
      let discoveryCalls = 0;
      const { logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          { agentSessionId: 'thread-1', nativePath: directory },
          options(async () => {
            discoveryCalls += 1;
            return null;
          }, logger),
        ),
      ).rejects.toMatchObject({
        code: 'UNAVAILABLE',
        retryable: true,
        details: {
          provider: 'codex',
          agentSessionId: 'thread-1',
          nativePath: directory,
          reason: 'path-read-error',
        },
      });
      expect(discoveryCalls).toBe(0);
    });
  });

  it('rejects mismatched stored and discovered transcripts', async () => {
    await withDirectory(async (directory) => {
      const storedPath = await writeTranscript(directory, 'stored.jsonl', 'other-thread');
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl', 'another-thread');
      const { entries, logger } = createLogger();

      await expect(
        resolveCodexNativePath(
          { agentSessionId: 'thread-1', nativePath: storedPath },
          options(async () => discoveredPath, logger),
        ),
      ).rejects.toThrow();
      expect(entries.some((entry) => entry.fields?.reason === 'thread-mismatch')).toBeTrue();
    });
  });

  it('propagates discovery failures as retryable provider errors', async () => {
    const { logger } = createLogger();
    await expect(
      resolveCodexNativePath(
        { agentSessionId: 'thread-1', nativePath: null },
        options(async () => {
          throw new Error('app server unavailable');
        }, logger),
      ),
    ).rejects.toMatchObject({
      code: 'UNAVAILABLE',
      retryable: true,
      details: {
        provider: 'codex',
        agentSessionId: 'thread-1',
        reason: 'discovery-error',
      },
    });
  });

  it('returns null without discovery when the session id is absent', async () => {
    let discoveryCalls = 0;
    const { logger } = createLogger();
    await expect(
      resolveCodexNativePath(
        { agentSessionId: null, nativePath: '/tmp/unused.jsonl' },
        options(async () => {
          discoveryCalls += 1;
          return null;
        }, logger),
      ),
    ).resolves.toBeNull();
    expect(discoveryCalls).toBe(0);
  });

  it('honors an aborted signal', async () => {
    const controller = new AbortController();
    controller.abort(new Error('stop'));
    const { logger } = createLogger();
    await expect(
      resolveCodexNativePath(
        { agentSessionId: 'thread-1', nativePath: null },
        options(async () => null, logger, controller.signal),
      ),
    ).rejects.toThrow('stop');
  });
});
