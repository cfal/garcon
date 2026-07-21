import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage } from '@garcon/common/chat-types';
import { createJsonlForking } from '@garcon/server-agent-common/forking/jsonl-forking';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import {
  computeAgentTranscriptRevision,
  computeAgentTranscriptRevisions,
} from '@garcon/server-agent-interface';
import { rewriteClaudeForkTranscriptEntry } from '../fork-transcript.js';
import { loadClaudeChatMessages } from '../history-loader.js';

const roots = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('Claude point forking', () => {
  it('creates a provider-native bootstrap for a carry-over-only point', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-claude-forking-'));
    roots.push(root);
    const sourceAgentSessionId = 'd11dc5c4-73da-43b6-9cac-4ca08a2fd929';
    const sourcePath = path.join(root, `${sourceAgentSessionId}.jsonl`);
    const sourceEntry = {
      parentUuid: 'a9c24557-0534-4619-8faf-c3cd0b9d68fe',
      isSidechain: false,
      userType: 'external',
      cwd: '/garcon',
      sessionId: sourceAgentSessionId,
      version: '2.1.211',
      gitBranch: 'queue-good-2',
      type: 'user',
      message: { role: 'user', content: 'native prompt after carry-over' },
      uuid: 'a4912601-44aa-469d-b00e-3eee75dd027e',
      timestamp: '2026-07-17T15:20:02.808Z',
    };
    await writeFile(sourcePath, `${JSON.stringify(sourceEntry)}\n`);

    const nativeSessions = createPathNativeSessionCodec('claude');
    const transcript = {
      async resolveNativeSession({ chat }) {
        return chat.nativeSession;
      },
      async load({ chat }) {
        const nativePath = nativeSessions.decode(chat.nativeSession).path;
        const messages = await loadClaudeChatMessages(nativePath);
        return { messages, revision: computeAgentTranscriptRevision(messages) };
      },
    };
    const carriedMessage = new UserMessage('2026-07-17T15:00:00.000Z', 'carried prompt');
    const host = {
      carryOver: {
        async load() {
          return { revision: 'carry-over', messages: [carriedMessage] };
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
        carryOverRevision: 'carry-over',
        settings,
      },
      point: {
        messageSequence: 1,
        sourceRevision: {
          nativePrefix: computeAgentTranscriptRevisions([], 0).prefix,
          carryOver: 'carry-over',
        },
      },
    };
    const forking = createJsonlForking({
      host,
      supportsWhileRunning: true,
      transcript,
      nativeSessions,
      rewriteEntry: rewriteClaudeForkTranscriptEntry,
    });

    const forked = await forking.fork(request);
    const forkedPath = nativeSessions.decode(forked.nativeSession).path;
    const forkedEntry = JSON.parse((await readFile(forkedPath, 'utf8')).trim());

    expect(forkedEntry).toEqual({
      ...sourceEntry,
      sessionId: forked.agentSessionId,
      isMeta: true,
    });
    await expect(loadClaudeChatMessages(forkedPath)).resolves.toEqual([]);
  });
});
