import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdtemp, readFile, rm, stat, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { createJsonlForking } from '@garcon/server-agent-common/forking/jsonl-forking';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { computeAgentTranscriptRevision } from '@garcon/server-agent-interface';
import {
  claudeForkSemanticDigest,
  projectClaudeForkEntry,
  transformClaudeForkTranscript,
} from '../fork-transcript.js';
import { loadClaudeChatMessages } from '../history-loader.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude JSONL forking', () => {
  it('writes and verifies an independently resumable transcript graph', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-claude-forking-'));
    roots.push(root);
    const sourceAgentSessionId = 'd11dc5c4-73da-43b6-9cac-4ca08a2fd929';
    const sourcePath = path.join(root, `${sourceAgentSessionId}.jsonl`);
    const sourceEntries = [
      {
        parentUuid: null,
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'user',
        message: { role: 'user', content: 'source prompt' },
        uuid: 'a4912601-44aa-469d-b00e-3eee75dd027e',
        timestamp: '2026-07-17T15:20:02.808Z',
      },
      {
        parentUuid: 'a4912601-44aa-469d-b00e-3eee75dd027e',
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'source reply' }] },
        uuid: '42b019b0-3f2d-4dc4-a72f-6a428bb67a16',
        timestamp: '2026-07-17T15:20:03.808Z',
      },
    ];
    const sourceContent = `${sourceEntries.map((entry) => JSON.stringify(entry)).join('\n')}\n`;
    await writeFile(sourcePath, sourceContent);

    const nativeSessions = createPathNativeSessionCodec('claude');
    const transcript = {
      async resolveNativeSession({ chat }) {
        return chat.nativeSession;
      },
      async load({ chat }) {
        const nativePath = nativeSessions.decode(chat.nativeSession).path;
        const messages = await loadClaudeChatMessages(nativePath, undefined, { throwOnError: true });
        return { messages, revision: computeAgentTranscriptRevision(messages) };
      },
    };
    const host = {
      carryOver: {
        async load() {
          return { revision: '', messages: [] };
        },
      },
    };
    const sourceNativeSession = nativeSessions.encode({
      path: sourcePath,
      agentSessionId: sourceAgentSessionId,
      modelEndpointId: null,
    });
    const settings = { ownerId: 'claude', schemaVersion: 1, values: {} };
    const request = {
      chatId: 'target-chat',
      projectPath: root,
      model: 'claude-sonnet',
      permissionMode: 'default',
      thinkingMode: 'none',
      settings,
      endpoint: null,
      operation: {
        commandType: 'fork-run',
        clientRequestId: null,
        clientMessageId: null,
        turnId: 'turn-1',
      },
      admission: {
        signal: new AbortController().signal,
        markStarted() {},
        markAbortable() {},
      },
      source: {
        chatId: 'source-chat',
        agentId: 'claude',
        agentSessionId: sourceAgentSessionId,
        projectPath: root,
        model: 'claude-sonnet',
        nativeSession: sourceNativeSession,
        carryOverRevision: '',
        settings,
      },
      point: null,
    };
    const forking = createJsonlForking({
      host,
      supportsAtMessageWhileRunning: true,
      transcript,
      nativeSessions,
      rewriteEntry: projectClaudeForkEntry,
      transformEntries: transformClaudeForkTranscript,
      semanticDigest: claudeForkSemanticDigest,
    });

    const forked = await forking.fork(request);
    const forkedPath = nativeSessions.decode(forked.nativeSession).path;
    const forkedEntries = (await readFile(forkedPath, 'utf8')).trim().split('\n').map(JSON.parse);

    expect(forkedEntries.map((entry) => entry.sessionId)).toEqual([
      forked.agentSessionId,
      forked.agentSessionId,
    ]);
    expect(forkedEntries[0].uuid).not.toBe(sourceEntries[0].uuid);
    expect(forkedEntries[1].uuid).not.toBe(sourceEntries[1].uuid);
    expect(forkedEntries[1].parentUuid).toBe(forkedEntries[0].uuid);
    expect((await stat(forkedPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceContent);
    await expect(loadClaudeChatMessages(forkedPath)).resolves.toHaveLength(2);

    await forking.discard(forked, new AbortController().signal);
    await expect(access(forkedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });
});
