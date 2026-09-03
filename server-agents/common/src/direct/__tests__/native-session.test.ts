import { afterEach, describe, expect, test } from 'bun:test';
import { appendFile } from 'node:fs/promises';
import { createPreamblePrefix } from '@garcon/common/preamble-prefix';
import type { AgentChatReference } from '@garcon/server-agent-interface';
import { FILE_CONTEXT_SEPARATOR } from '../../shared/file-mention-context.js';
import {
  createDirectNativeHistoryImport,
  createDirectNativeSessionAccess,
} from '../native-session.js';
import {
  createTestDirectSessionStore,
  removeTestDirectSessionStores,
} from './session-store-fixture.js';

const SESSION_ID = '10000000-0000-4000-8000-000000000001';

const PREAMBLE_PREFIX = createPreamblePrefix({
  viewId: 'view-native-history',
  clientMessageId: 'message-native-history',
  contents: ['Synthetic Direct instructions.'],
}).prefix;

afterEach(removeTestDirectSessionStores);

function chat(nativeSession: AgentChatReference['nativeSession']): AgentChatReference {
  return {
    chatId: 'chat-1',
    agentId: 'direct-test',
    agentSessionId: SESSION_ID,
    projectPath: '/workspace',
    model: 'model',
    nativeSession,
    carryOverRevision: '0',
    nativeSeedReceipt: null,
    settings: { ownerId: 'direct-test', schemaVersion: 1, values: {} },
  };
}

async function createSession(content = `visible request${FILE_CONTEXT_SEPARATOR}expanded file contents`) {
  const sessions = createTestDirectSessionStore();
  await sessions.create({
    sessionId: SESSION_ID,
    runId: 'run-1',
    content,
    attachments: [{
      kind: 'image',
      data: 'data:image/png;base64,YWJj',
      name: null,
      mimeType: 'image/png',
    }],
  });
  await sessions.appendAssistant({
    sessionId: SESSION_ID,
    runId: 'run-1',
    content: 'visible response',
  });
  return sessions;
}

describe('Direct native session facets', () => {
  test('preserves a framed preamble and visible prompt exactly', async () => {
    const prompt = `${PREAMBLE_PREFIX}Inspect the synthetic workspace.`;
    const sessions = await createSession(prompt);
    const importer = createDirectNativeHistoryImport(sessions);
    const batches = [];

    for await (const batch of importer.load({
      chat: chat(sessions.nativeReference(SESSION_ID)),
      signal: new AbortController().signal,
    })) {
      batches.push(...batch);
    }

    expect(batches[0]?.message).toMatchObject({ type: 'user-message', content: prompt });
  });

  test('resolves and describes only the exact durable native session', async () => {
    const sessions = await createSession();
    const access = createDirectNativeSessionAccess(sessions);
    const reference = sessions.nativeReference(SESSION_ID);
    const signal = new AbortController().signal;

    await expect(access.resolveNativeSession({ chat: chat(reference), signal }))
      .resolves.toEqual(reference);
    await expect(access.describeSource({ chat: chat(reference), signal }))
      .resolves.toEqual({
        kind: 'filesystem-path',
        value: expect.stringContaining(`${SESSION_ID}.jsonl`),
      });
    await expect(access.resolveNativeSession({
      chat: { ...chat(reference), agentSessionId: null, nativeSession: null },
      signal,
    })).resolves.toBeNull();

    await expect(access.resolveNativeSession({
      chat: chat({ ...reference, ownerId: 'other' }),
      signal,
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: false,
    });
  });

  test('imports normalized history with exact timestamps and attachment data', async () => {
    const sessions = await createSession();
    const importer = createDirectNativeHistoryImport(sessions);
    const batches = [];

    for await (const batch of importer.load({
      chat: chat(sessions.nativeReference(SESSION_ID)),
      signal: new AbortController().signal,
    })) {
      batches.push(...batch);
    }

    expect(batches).toHaveLength(2);
    expect(batches[0]?.message).toMatchObject({
      type: 'user-message',
      content: 'visible request',
      images: [{
        data: 'data:image/png;base64,YWJj',
        name: '',
        mimeType: 'image/png',
      }],
    });
    expect(batches[1]?.message).toMatchObject({
      type: 'assistant-message',
      content: 'visible response',
    });
    expect(batches.map((row) => row.message.timestamp)).toEqual([
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
      expect.stringMatching(/^\d{4}-\d{2}-\d{2}T/),
    ]);
  });

  test('discovers a corrupt selected history but fails visibly when importing it', async () => {
    const sessions = await createSession();
    const access = createDirectNativeSessionAccess(sessions);
    const reference = sessions.nativeReference(SESSION_ID);
    const signal = new AbortController().signal;
    const source = await access.describeSource({ chat: chat(reference), signal });
    if (source?.kind !== 'filesystem-path') throw new Error('Expected a Direct session path');

    await appendFile(source.value, '{malformed}\n');
    await expect(access.resolveNativeSession({ chat: chat(reference), signal }))
      .resolves.toEqual(reference);
    await expect((async () => {
      for await (const _batch of createDirectNativeHistoryImport(sessions).load({
        chat: chat(reference),
        signal,
      })) {
        void _batch;
      }
    })()).rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
        retryable: false,
        message: 'This conversation cannot be loaded because its Direct history is unavailable.',
      });

    const missingSessions = createTestDirectSessionStore();
    await expect(createDirectNativeSessionAccess(missingSessions).resolveNativeSession({
      chat: chat(missingSessions.nativeReference(SESSION_ID)),
      signal,
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: false,
    });
  });

  test('releases only the selected file and treats repeated deletion as success', async () => {
    const sessions = await createSession();
    const access = createDirectNativeSessionAccess(sessions);
    const reference = sessions.nativeReference(SESSION_ID);
    const request = {
      chat: chat(reference),
      signal: new AbortController().signal,
      reason: 'deleted' as const,
    };

    await access.release(request);
    await access.release(request);
    await expect(access.resolveNativeSession(request)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: false,
    });
  });
});
