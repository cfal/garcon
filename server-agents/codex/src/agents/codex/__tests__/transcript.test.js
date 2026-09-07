import { describe, expect, it } from 'bun:test';
import { promises as fs } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createCodexNativeEvidence } from '../transcript.ts';

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
    requestDiscoveryRefresh: [],
    load: [],
  };
  return {
    calls,
    runtime: {
      async resolveNativePath() {
        calls.discover += 1;
        return discoveredPath;
      },
      requestNativePathDiscoveryRefresh(agentSessionId) {
        calls.requestDiscoveryRefresh.push(agentSessionId);
      },
      async loadMessages(reference) {
        calls.load.push(reference);
        return reference.nativePath
          ? [new UserMessage('2026-07-24T00:00:01.000Z', 'native message')]
          : [];
      },
    },
  };
}

function createFixture(directory, nativeSession, runtimeOptions) {
  const nativeSessions = createPathNativeSessionCodec('codex');
  const { calls, runtime } = createRuntime(runtimeOptions);
  const transcript = createCodexNativeEvidence(
    runtime,
    nativeSessions,
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

describe('createCodexNativeEvidence', () => {
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

  it('preserves a pathless stored reference when discovery misses', async () => {
    await withDirectory(async (directory) => {
      const codec = createPathNativeSessionCodec('codex');
      const nativeSession = codec.encode({
        path: null,
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
      expect(fixture.calls.discover).toBe(1);
      expect(fixture.calls.requestDiscoveryRefresh).toEqual([]);
    });
  });

  it('acquires a discoverable path for a pathless stored reference', async () => {
    await withDirectory(async (directory) => {
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl');
      const codec = createPathNativeSessionCodec('codex');
      const nativeSession = codec.encode({
        path: null,
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      });
      const fixture = createFixture(directory, nativeSession, { discoveredPath });

      await expect(
        fixture.transcript.resolveNativeSession({
          chat: fixture.chat,
          signal,
        }),
      ).resolves.toEqual(codec.encode({
        path: discoveredPath,
        agentSessionId: 'thread-1',
        modelEndpointId: 'endpoint-1',
      }));
      expect(fixture.calls.discover).toBe(1);
      expect(fixture.calls.requestDiscoveryRefresh).toEqual([]);
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
        fixture.transcript.describeSource({ chat: fixture.chat, signal }),
      ).resolves.toEqual({ kind: 'filesystem-path', value: nativePath });

      expect(fixture.calls.load).toHaveLength(1);
      expect(fixture.calls.load.every((reference) => reference.nativePath === nativePath)).toBe(true);
      expect(fixture.calls.discover).toBe(0);
    });
  });

  it('fails the evidence load closed and requests a discovery refresh', async () => {
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
      await expect(fixture.transcript.load({ chat: fixture.chat, signal })).rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
        details: { provider: 'codex', reason: 'not-found' },
      });
      expect(fixture.calls.discover).toBe(1);
      expect(fixture.calls.requestDiscoveryRefresh).toEqual(['thread-1']);
      await expect(
        fixture.transcript.describeSource({ chat: fixture.chat, signal }),
      ).resolves.toBeNull();
      await expect(
        fixture.transcript.resolveNativeSession({
          chat: fixture.chat,
          signal,
        }),
      ).resolves.toBe(fixture.chat.nativeSession);
      expect(fixture.calls.discover).toBe(3);
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

  it('[TLV5-ADOPT.11-CODEX-STORED-UNIT-01] distinguishes a missing stored rollout from invalid sources and retries after repair', async () => {
    await withDirectory(async (directory) => {
      const nativePath = path.join(directory, 'stored.jsonl');
      const codec = createPathNativeSessionCodec('codex');
      const nativeSession = codec.encode({
        path: nativePath,
        agentSessionId: 'thread-1',
        modelEndpointId: null,
      });
      const missingFixture = createFixture(directory, nativeSession);

      await expect(
        missingFixture.transcript.loadLegacy({ chat: missingFixture.chat, signal }),
      ).resolves.toEqual({ messages: [] });
      expect(missingFixture.calls.discover).toBe(1);

      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl', 'thread-1');
      const nonDirectoryPath = path.join(directory, 'not-a-directory');
      await fs.writeFile(nonDirectoryPath, 'not a directory');
      const enotdirFixture = createFixture(
        directory,
        codec.encode({
          path: path.join(nonDirectoryPath, 'rollout.jsonl'),
          agentSessionId: 'thread-1',
          modelEndpointId: null,
        }),
        { discoveredPath },
      );
      await expect(
        enotdirFixture.transcript.loadLegacy({ chat: enotdirFixture.chat, signal }),
      ).rejects.toThrow();
      expect(enotdirFixture.calls.discover).toBe(0);

      await fs.rm(nonDirectoryPath);
      await fs.mkdir(nonDirectoryPath);
      await writeTranscript(nonDirectoryPath, 'rollout.jsonl', 'thread-1');
      await expect(
        enotdirFixture.transcript.loadLegacy({ chat: enotdirFixture.chat, signal }),
      ).resolves.toMatchObject({ messages: [{ content: 'native message' }] });
      expect(enotdirFixture.calls.discover).toBe(0);

      await fs.writeFile(nativePath, `${JSON.stringify({
        type: 'session_meta',
        timestamp: '2026-07-24T00:00:00.000Z',
        payload: {},
      })}\n`);
      const invalidMetadataFixture = createFixture(
        directory,
        nativeSession,
        { discoveredPath },
      );
      await expect(
        invalidMetadataFixture.transcript.loadLegacy({
          chat: invalidMetadataFixture.chat,
          signal,
        }),
      ).rejects.toThrow();
      expect(invalidMetadataFixture.calls.discover).toBe(0);

      await writeTranscript(directory, 'stored.jsonl', 'thread-1');
      await expect(
        invalidMetadataFixture.transcript.loadLegacy({
          chat: invalidMetadataFixture.chat,
          signal,
        }),
      ).resolves.toMatchObject({ messages: [{ content: 'native message' }] });
      expect(invalidMetadataFixture.calls.discover).toBe(0);
    });
  });

  it('[TLV5-ADOPT.11-CODEX-DISCOVERED-UNIT-01] rejects a mismatched discovered rollout and retries the repaired candidate', async () => {
    await withDirectory(async (directory) => {
      const discoveredPath = await writeTranscript(directory, 'discovered.jsonl', 'other-thread');
      const codec = createPathNativeSessionCodec('codex');
      const fixture = createFixture(
        directory,
        codec.encode({
          path: null,
          agentSessionId: 'thread-1',
          modelEndpointId: null,
        }),
        { discoveredPath },
      );

      await expect(
        fixture.transcript.loadLegacy({ chat: fixture.chat, signal }),
      ).rejects.toThrow();

      await writeTranscript(directory, 'discovered.jsonl', 'thread-1');
      await expect(
        fixture.transcript.loadLegacy({ chat: fixture.chat, signal }),
      ).resolves.toMatchObject({ messages: [{ content: 'native message' }] });
    });
  });
});
