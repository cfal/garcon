import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createCodexTranscript } from '../transcript.ts';

const signal = new AbortController().signal;

function createLogger() {
  return {
    debug() {},
    info() {},
    warn() {},
    error() {},
  };
}

async function withDirectory(run) {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'codex-transcript-'));
  try {
    return await run(directory);
  } finally {
    await fs.rm(directory, { recursive: true, force: true });
  }
}

async function writeTranscript(directory, fileName, threadId = 'thread-1') {
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

function createRuntime({ discoveredPath = null } = {}) {
  const calls = {
    discover: 0,
    load: [],
    page: [],
    preview: [],
  };
  return {
    calls,
    runtime: {
      async resolveNativePath() {
        calls.discover += 1;
        return discoveredPath;
      },
      async loadMessages(reference) {
        calls.load.push(reference);
        return reference.nativePath
          ? [new UserMessage('2026-07-24T00:00:01.000Z', 'native message')]
          : [];
      },
      async loadMessagePage(reference) {
        calls.page.push(reference);
        return null;
      },
      async getPreview(reference) {
        calls.preview.push(reference);
        return reference.nativePath
          ? {
              firstMessage: 'first',
              lastMessage: 'last',
              createdAt: '2026-07-24T00:00:00.000Z',
              lastActivity: '2026-07-24T00:00:01.000Z',
            }
          : null;
      },
    },
  };
}

function createFixture(directory, nativeSession, runtimeOptions) {
  const nativeSessions = createPathNativeSessionCodec('codex');
  const { calls, runtime } = createRuntime(runtimeOptions);
  const transcript = createCodexTranscript(
    runtime,
    nativeSessions,
    { home: () => directory },
    createLogger(),
  );
  const chat = {
    chatId: 'chat-1',
    agentId: 'codex',
    agentSessionId: nativeSessions.decode(nativeSession).agentSessionId,
    projectPath: '/repo',
    model: 'gpt-5.4',
    nativeSession,
    carryOverRevision: 'carry-over',
    settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
  };
  return { calls, chat, nativeSessions, transcript };
}

describe('createCodexTranscript', () => {
  it('returns the exact stored reference without consulting discovery', async () => {
    await withDirectory(async (directory) => {
      const nativePath = await writeTranscript(directory, 'stored.jsonl');
      const codec = createPathNativeSessionCodec('codex');
      const nativeSession = codec.encode({
        path: nativePath,
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      });
      const fixture = createFixture(directory, nativeSession);

      await expect(
        fixture.transcript.resolveNativeSession({
          chat: fixture.chat,
          signal,
        }),
      ).resolves.toBe(nativeSession);
      expect(fixture.calls.discover).toBe(0);
    });
  });

  it('persists a normally discovered replacement path', async () => {
    await withDirectory(async (directory) => {
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl');
      const codec = createPathNativeSessionCodec('codex');
      const nativeSession = codec.encode({
        path: path.join(directory, 'missing.jsonl'),
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      });
      const fixture = createFixture(directory, nativeSession, {
        discoveredPath,
      });

      await expect(
        fixture.transcript.resolveNativeSession({
          chat: fixture.chat,
          signal,
        }),
      ).resolves.toEqual(
        codec.encode({
          path: discoveredPath,
          agentSessionId: 'thread-1',
          modelEndpointId: 'endpoint-1',
        }),
      );
    });
  });

  it('uses the validated path for every transcript surface', async () => {
    await withDirectory(async (directory) => {
      const nativePath = await writeTranscript(directory, 'stored.jsonl');
      const codec = createPathNativeSessionCodec('codex');
      const fixture = createFixture(
        directory,
        codec.encode({
          path: nativePath,
          agentSessionId: 'thread-1',
          modelEndpointId: null,
        }),
      );

      await expect(fixture.transcript.load({ chat: fixture.chat, signal })).resolves.toMatchObject({
        messages: [{ content: 'native message' }],
      });
      await expect(
        fixture.transcript.loadPage({
          chat: fixture.chat,
          page: { limit: 10, offset: 0 },
          signal,
        }),
      ).resolves.toBeNull();
      await expect(
        fixture.transcript.preview({ chat: fixture.chat, signal }),
      ).resolves.toMatchObject({ firstMessage: 'first', lastMessage: 'last' });
      await expect(
        fixture.transcript.revision({ chat: fixture.chat, signal }),
      ).resolves.toBeString();
      await expect(
        fixture.transcript.describeSource({ chat: fixture.chat, signal }),
      ).resolves.toEqual({ kind: 'filesystem-path', value: nativePath });
      await expect(
        fixture.transcript.resolveIndexSource({ chat: fixture.chat, signal }),
      ).resolves.toMatchObject({
        ownerId: 'codex',
        value: { nativePath, threadId: 'thread-1' },
      });

      const references = [...fixture.calls.load, ...fixture.calls.page, ...fixture.calls.preview];
      expect(references).toHaveLength(4);
      expect(references.every((reference) => reference.nativePath === nativePath)).toBe(true);
      expect(fixture.calls.discover).toBe(0);
    });
  });

  it('fails every read closed and retries discovery when a known session has no path', async () => {
    await withDirectory(async (directory) => {
      const codec = createPathNativeSessionCodec('codex');
      const fixture = createFixture(
        directory,
        codec.encode({
          path: null,
          agentSessionId: 'thread-1',
          modelEndpointId: null,
        }),
      );
      const requests = [
        () => fixture.transcript.load({ chat: fixture.chat, signal }),
        () =>
          fixture.transcript.loadPage({
            chat: fixture.chat,
            page: { limit: 10, offset: 0 },
            signal,
          }),
        () => fixture.transcript.preview({ chat: fixture.chat, signal }),
        () => fixture.transcript.revision({ chat: fixture.chat, signal }),
      ];

      for (const request of requests) {
        await expect(request()).rejects.toMatchObject({
          code: 'TRANSCRIPT_UNAVAILABLE',
          retryable: true,
          details: { provider: 'codex', reason: 'not-found' },
        });
      }
      expect(fixture.calls.discover).toBe(requests.length);
      await expect(
        fixture.transcript.resolveNativeSession({
          chat: fixture.chat,
          signal,
        }),
      ).resolves.toBeNull();
    });
  });

  it('keeps a never-started transcript empty', async () => {
    await withDirectory(async (directory) => {
      const fixture = createFixture(directory, null);
      fixture.chat.agentSessionId = null;

      await expect(fixture.transcript.load({ chat: fixture.chat, signal })).resolves.toMatchObject({
        messages: [],
      });
      expect(fixture.calls.discover).toBe(0);
    });
  });
});
