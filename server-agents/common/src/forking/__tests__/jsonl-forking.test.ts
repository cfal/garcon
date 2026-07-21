import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import {
  AgentIntegrationError,
  attachNativeMessageSource,
  computeAgentTranscriptRevision,
  computeAgentTranscriptRevisions,
  getNativeMessageRevisionSource,
  type AgentForkRequest,
  type AgentHost,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import { createJsonlForking, type JsonlForkingOptions } from '../jsonl-forking.js';

const roots: string[] = [];
const sourceAgentSessionId = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-07-20T00:00:00.000Z';

afterEach(async () => {
  await Promise.all(roots.splice(0).map((root) => rm(root, { recursive: true, force: true })));
});

function sourceContent(fallback = 'suppressed duplicate'): string {
  return [
    JSON.stringify({ type: 'session', sessionId: sourceAgentSessionId }),
    JSON.stringify({ type: 'fallback', content: fallback }),
    JSON.stringify({ type: 'message', content: 'first' }),
    JSON.stringify({ type: 'message', content: 'second' }),
    '',
  ].join('\n');
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-jsonl-forking-'));
  roots.push(root);
  const sourcePath = path.join(root, 'source.jsonl');
  await writeFile(sourcePath, sourceContent());
  const nativeSessions = createPathNativeSessionCodec('test');
  const controls: {
    afterSourceLoad?: () => void;
    transcriptFailure?: unknown;
    carryOverFailure?: unknown;
    carryOverMessages: ChatMessage[];
  } = { carryOverMessages: [] };
  const loadMessages = async (nativePath: string): Promise<ChatMessage[]> => {
    const content = await readFile(nativePath, 'utf8');
    const messages: ChatMessage[] = [];
    let byteOffset = 0;
    for (const [index, line] of content.split('\n').entries()) {
      if (line) {
        const entry = JSON.parse(line) as { type?: string; content?: string };
        if (entry.type === 'message' && entry.content) {
          messages.push(
            attachNativeMessageSource(new UserMessage(timestamp, entry.content), {
              lineNumber: index + 1,
              byteOffset,
              withinSourceOrdinal: 0,
            }),
          );
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
      if (native.path === sourcePath && controls.transcriptFailure) {
        throw controls.transcriptFailure;
      }
      const messages = await loadMessages(native.path!);
      if (native.path === sourcePath) {
        const mutate = controls.afterSourceLoad;
        controls.afterSourceLoad = undefined;
        mutate?.();
      }
      return { messages, revision: computeAgentTranscriptRevision(messages) };
    },
  } satisfies Pick<AgentTranscript, 'load' | 'resolveNativeSession'>;
  const host = {
    carryOver: {
      async load({ signal }) {
        if (controls.carryOverFailure) throw controls.carryOverFailure;
        signal.throwIfAborted();
        return { revision: 'carry-over', messages: controls.carryOverMessages };
      },
    },
  } satisfies Pick<AgentHost, 'carryOver'>;
  const sourceMessages = await loadMessages(sourcePath);
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
      sourceRevision: {
        nativePrefix: computeAgentTranscriptRevisions(sourceMessages, 2).prefix,
        carryOver: 'carry-over',
      },
    },
  } satisfies AgentForkRequest;
  const options = {
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
  } satisfies JsonlForkingOptions;
  return {
    root,
    sourcePath,
    sourceMessages,
    loadMessages,
    nativeSessions,
    controls,
    request,
    options,
    forking: createJsonlForking(options),
  };
}

describe('createJsonlForking message validation', () => {
  it('allows appends after the selected provider-native prefix', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sourcePath,
      `${await readFile(fixture.sourcePath, 'utf8')}${JSON.stringify({
        type: 'message',
        content: 'appended while running',
      })}\n`,
    );

    const forked = await fixture.forking.fork(fixture.request);
    const forkedPath = fixture.nativeSessions.decode(forked.nativeSession).path!;
    const forkedMessages = await fixture.loadMessages(forkedPath);

    expect(forkedMessages).toEqual(fixture.sourceMessages);
    expect(getNativeMessageRevisionSource(forkedMessages[0])?.byteOffset).not.toBe(
      getNativeMessageRevisionSource(fixture.sourceMessages[0])?.byteOffset,
    );
    expect(forkedMessages).not.toContainEqual(
      expect.objectContaining({ content: 'appended while running' }),
    );
  });

  it('rejects a rendered message mutation before the snapshot', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sourcePath,
      (await readFile(fixture.sourcePath, 'utf8')).replace('first', 'changed'),
    );

    await expect(fixture.forking.fork(fixture.request)).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CHANGED',
    });
  });

  it('rejects a non-rendered entry mutation while copying', async () => {
    const fixture = await createFixture();
    let mutated = false;
    const forking = createJsonlForking({
      ...fixture.options,
      rewriteEntry(entry) {
        const record = entry as Record<string, unknown>;
        if (record.type === 'fallback' && !mutated) {
          writeFileSync(fixture.sourcePath, sourceContent('changed native context'));
          mutated = true;
        }
        return entry;
      },
    });

    await expect(forking.fork(fixture.request)).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CHANGED',
      retryable: true,
    });
  });

  it('rejects a non-rendered entry mutation in the transcript-to-snapshot gap', async () => {
    const fixture = await createFixture();
    const filesBeforeFork = await readdir(fixture.root);
    fixture.controls.afterSourceLoad = () =>
      writeFileSync(fixture.sourcePath, sourceContent('changed in snapshot gap'));

    await expect(fixture.forking.fork(fixture.request)).rejects.toMatchObject({
      code: 'SOURCE_REVISION_CHANGED',
      retryable: true,
    });
    expect(await readdir(fixture.root)).toEqual(filesBeforeFork);
  });
});

describe('createJsonlForking error propagation', () => {
  it('preserves provider transcript failures', async () => {
    const fixture = await createFixture();
    const failure = new AgentIntegrationError(
      'PROVIDER_FAILURE',
      'Provider transcript read failed',
      true,
    );
    fixture.controls.transcriptFailure = failure;

    await expect(fixture.forking.fork(fixture.request)).rejects.toBe(failure);
  });

  it.each([
    new Error('Carry-over storage is unavailable'),
    new AgentIntegrationError('SOURCE_REVISION_CHANGED', 'Carry-over revision changed', true),
  ])('preserves carry-over failures', async (failure) => {
    const fixture = await createFixture();
    fixture.controls.carryOverFailure = failure;

    await expect(fixture.forking.fork(fixture.request)).rejects.toBe(failure);
  });

  it('preserves cancellation from carry-over loading', async () => {
    const fixture = await createFixture();
    const abortController = new AbortController();
    const abortReason = new DOMException('Fork cancelled', 'AbortError');
    const forking = createJsonlForking({
      ...fixture.options,
      host: {
        carryOver: {
          async load({ signal }) {
            abortController.abort(abortReason);
            signal.throwIfAborted();
            throw new Error('unreachable');
          },
        },
      },
    });

    await expect(
      forking.fork({
        ...fixture.request,
        admission: { ...fixture.request.admission, signal: abortController.signal },
      }),
    ).rejects.toBe(abortReason);
  });
});

describe('createJsonlForking empty native prefixes', () => {
  it('preserves provider metadata without adding rendered messages', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sourcePath,
      [
        JSON.stringify({ type: 'session', sessionId: sourceAgentSessionId }),
        JSON.stringify({ type: 'provider_context', cwd: fixture.root }),
        '',
      ].join('\n'),
    );
    fixture.controls.carryOverMessages = [new UserMessage(timestamp, 'carried prompt')];
    const request = {
      ...fixture.request,
      point: {
        messageSequence: 1,
        sourceRevision: {
          nativePrefix: computeAgentTranscriptRevisions([], 0).prefix,
          carryOver: 'carry-over',
        },
      },
    } satisfies AgentForkRequest;

    const forked = await fixture.forking.fork(request);
    const forkedPath = fixture.nativeSessions.decode(forked.nativeSession).path!;
    const entries = (await readFile(forkedPath, 'utf8'))
      .trimEnd()
      .split('\n')
      .map((line) => JSON.parse(line));

    expect(entries).toEqual([
      { type: 'session', sessionId: forked.agentSessionId },
      { type: 'provider_context', cwd: fixture.root },
    ]);
    await expect(fixture.loadMessages(forkedPath)).resolves.toEqual([]);
  });
});
