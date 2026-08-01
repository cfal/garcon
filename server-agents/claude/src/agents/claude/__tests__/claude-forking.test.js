import { afterEach, describe, expect, it } from 'bun:test';
import { access, mkdtemp, readFile, readdir, rm, stat, writeFile } from 'node:fs/promises';
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
        parentUuid: '5ff2ba2d-fac5-421d-b522-df6cf579d2e4',
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'attachment',
        attachment: { type: 'hook_success' },
        uuid: '82a44863-8d08-40e1-8fa2-c5a0c79c3725',
        timestamp: '2026-07-17T15:20:03.324Z',
      },
      {
        parentUuid: 'a4912601-44aa-469d-b00e-3eee75dd027e',
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'attachment',
        attachment: { type: 'hook_non_blocking_error' },
        uuid: '5ff2ba2d-fac5-421d-b522-df6cf579d2e4',
        timestamp: '2026-07-17T15:20:03.262Z',
      },
      {
        parentUuid: '82a44863-8d08-40e1-8fa2-c5a0c79c3725',
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'assistant',
        message: { role: 'assistant', content: [{ type: 'text', text: 'source reply' }] },
        uuid: '42b019b0-3f2d-4dc4-a72f-6a428bb67a16',
        timestamp: '2026-07-17T15:20:03.808Z',
      },
      {
        parentUuid: '42b019b0-3f2d-4dc4-a72f-6a428bb67a16',
        isSidechain: false,
        sessionId: sourceAgentSessionId,
        type: 'attachment',
        attachment: {
          type: 'queued_command',
          prompt: 'persisted queued prompt',
          commandMode: 'prompt',
          timestamp: '2026-07-17T15:20:04.808Z',
        },
        uuid: 'b2823712-55bb-479e-c11f-7bb789cc138f',
        timestamp: '2026-07-17T15:20:04.808Z',
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
      supportsWhileRunning: true,
      transcript,
      nativeSessions,
      rewriteEntry: projectClaudeForkEntry,
      transformEntries: transformClaudeForkTranscript,
      semanticDigest: claudeForkSemanticDigest,
      allowUnmaterializedWholeSession: true,
    });

    const outcome = await forking.fork(request);
    expect(outcome.kind).toBe('materialized');
    if (outcome.kind !== 'materialized') throw new Error('Expected a materialized Claude fork');
    const forked = outcome.session;
    const forkedPath = nativeSessions.decode(forked.nativeSession).path;
    const forkedEntries = (await readFile(forkedPath, 'utf8')).trim().split('\n').map(JSON.parse);

    expect(forkedEntries.every((entry) => entry.sessionId === forked.agentSessionId)).toBe(true);
    const entriesBySourceUuid = new Map(forkedEntries.map((entry) => [
      entry.forkedFrom.messageUuid,
      entry,
    ]));
    for (const sourceEntry of sourceEntries) {
      expect(entriesBySourceUuid.get(sourceEntry.uuid)?.uuid).not.toBe(sourceEntry.uuid);
    }
    const hookSuccess = entriesBySourceUuid.get('82a44863-8d08-40e1-8fa2-c5a0c79c3725');
    const hookError = entriesBySourceUuid.get('5ff2ba2d-fac5-421d-b522-df6cf579d2e4');
    expect(hookSuccess).toBeDefined();
    expect(hookError).toBeDefined();
    expect(forkedEntries.indexOf(hookSuccess)).toBeLessThan(forkedEntries.indexOf(hookError));
    expect(hookSuccess.parentUuid).toBe(hookError.uuid);
    const targetUuids = new Set(forkedEntries.map((entry) => entry.uuid));
    for (const entry of forkedEntries) {
      if (entry.parentUuid !== null) expect(targetUuids.has(entry.parentUuid)).toBe(true);
    }
    expect((await stat(forkedPath)).mode & 0o777).toBe(0o600);
    expect(await readFile(sourcePath, 'utf8')).toBe(sourceContent);
    await expect(loadClaudeChatMessages(forkedPath)).resolves.toMatchObject([
      { type: 'user-message', content: 'source prompt' },
      { type: 'assistant-message', content: 'source reply' },
      { type: 'user-message', content: 'persisted queued prompt' },
    ]);

    await forking.discard(forked, new AbortController().signal);
    await expect(access(forkedPath)).rejects.toMatchObject({ code: 'ENOENT' });
  });

  it('leaves a source containing only task state unmaterialized', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-claude-forking-'));
    roots.push(root);
    const sourceAgentSessionId = 'd11dc5c4-73da-43b6-9cac-4ca08a2fd929';
    const sourcePath = path.join(root, `${sourceAgentSessionId}.jsonl`);
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'mode', sessionId: sourceAgentSessionId }),
      JSON.stringify({ type: 'queue-operation', sessionId: sourceAgentSessionId }),
      JSON.stringify({ type: 'last-prompt', sessionId: sourceAgentSessionId }),
      '',
    ].join('\n'));

    const nativeSessions = createPathNativeSessionCodec('claude');
    const sourceNativeSession = nativeSessions.encode({
      path: sourcePath,
      agentSessionId: sourceAgentSessionId,
      modelEndpointId: null,
    });
    const settings = { ownerId: 'claude', schemaVersion: 1, values: {} };
    const forking = createJsonlForking({
      host: {
        carryOver: {
          async load() {
            return { revision: '', messages: [] };
          },
        },
      },
      supportsWhileRunning: true,
      transcript: {
        async resolveNativeSession({ chat }) {
          return chat.nativeSession;
        },
        async load() {
          throw new Error('An unmaterialized fork must skip digest verification');
        },
      },
      nativeSessions,
      rewriteEntry: projectClaudeForkEntry,
      transformEntries: transformClaudeForkTranscript,
      semanticDigest: claudeForkSemanticDigest,
      allowUnmaterializedWholeSession: true,
    });

    const outcome = await forking.fork({
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
    });

    expect(outcome).toEqual({ kind: 'unmaterialized' });
    expect(await readdir(root)).toEqual([`${sourceAgentSessionId}.jsonl`]);
  });
});
