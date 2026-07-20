import { afterEach, describe, expect, it } from 'bun:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import {
  attachNativeMessageSource,
  computeAgentTranscriptRevision,
  getNativeMessageRevisionSource,
  type AgentForkRequest,
  type AgentHost,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import { createJsonlForking } from '../jsonl-forking.js';

const roots: string[] = [];

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

describe('createJsonlForking', () => {
  it('validates rewritten forks by ordered message content rather than native offsets', async () => {
    const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-jsonl-forking-'));
    roots.push(root);
    const sourcePath = path.join(root, 'source.jsonl');
    const sourceAgentSessionId = '11111111-1111-1111-1111-111111111111';
    await writeFile(sourcePath, [
      JSON.stringify({ type: 'session', sessionId: sourceAgentSessionId }),
      JSON.stringify({ type: 'fallback', content: 'suppressed duplicate' }),
      JSON.stringify({ type: 'message', content: 'first' }),
      JSON.stringify({ type: 'message', content: 'second' }),
      '',
    ].join('\n'));

    const nativeSessions = createPathNativeSessionCodec('test');
    const loadMessages = async (nativePath: string): Promise<ChatMessage[]> => {
      const content = await readFile(nativePath, 'utf8');
      const messages: ChatMessage[] = [];
      let byteOffset = 0;
      for (const [index, line] of content.split('\n').entries()) {
        if (line) {
          const entry = JSON.parse(line) as { type?: string; content?: string };
          if (entry.type === 'message' && entry.content) {
            messages.push(attachNativeMessageSource(
              new UserMessage('2026-07-20T00:00:00.000Z', entry.content),
              { lineNumber: index + 1, byteOffset, withinSourceOrdinal: 0 },
            ));
          }
        }
        byteOffset += Buffer.byteLength(line) + 1;
      }
      return messages;
    };
    const transcript = {
      async resolveNativeSession({ chat }) {
        return chat.nativeSession;
      },
      async load({ chat }) {
        const native = nativeSessions.decode(chat.nativeSession);
        const messages = await loadMessages(native.path!);
        return { messages, revision: computeAgentTranscriptRevision(messages) };
      },
      async revision({ chat }) {
        const native = nativeSessions.decode(chat.nativeSession);
        return computeAgentTranscriptRevision(await loadMessages(native.path!));
      },
    } satisfies Pick<AgentTranscript, 'load' | 'revision' | 'resolveNativeSession'>;
    const host = {
      carryOver: {
        async load() {
          return { revision: 'carry-over', messages: [] };
        },
      },
    } satisfies Pick<AgentHost, 'carryOver'>;
    const sourceMessages = await loadMessages(sourcePath);
    const sourceRevision = computeAgentTranscriptRevision(sourceMessages);
    const settings = { ownerId: 'test', schemaVersion: 1, values: {} } as const;
    const sourceNativeSession = nativeSessions.encode({
      path: sourcePath,
      agentSessionId: sourceAgentSessionId,
      modelEndpointId: null,
    });
    const request = {
      chatId: 'target-chat',
      projectPath: root,
      model: 'test-model',
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
        agentId: 'test',
        agentSessionId: sourceAgentSessionId,
        projectPath: root,
        model: 'test-model',
        nativeSession: sourceNativeSession,
        carryOverRevision: 'carry-over',
        settings,
      },
      point: {
        messageSequence: 2,
        sourceRevision: { native: sourceRevision, carryOver: 'carry-over' },
      },
    } satisfies AgentForkRequest;

    const forking = createJsonlForking({
      host,
      supportsWhileRunning: true,
      transcript,
      nativeSessions,
      rewriteEntry(entry, context) {
        const record = entry as Record<string, unknown>;
        if (record.type === 'session') {
          return { ...record, sessionId: context.targetAgentSessionId };
        }
        if (record.type === 'fallback' && context.retainedMessageCount === 0) {
          return { type: 'filtered' };
        }
        return entry;
      },
    });
    const forked = await forking.fork(request);
    const forkedNative = nativeSessions.decode(forked.nativeSession);
    const forkedMessages = await loadMessages(forkedNative.path!);

    expect(forkedMessages).toEqual(sourceMessages);
    expect(getNativeMessageRevisionSource(forkedMessages[0])?.byteOffset)
      .not.toBe(getNativeMessageRevisionSource(sourceMessages[0])?.byteOffset);
  });
});
