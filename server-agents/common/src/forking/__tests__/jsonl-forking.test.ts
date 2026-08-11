import { afterEach, describe, expect, it, mock } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import { createNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  attachNativeMessageSource,
  computeAgentTranscriptRevision,
  computeAgentTranscriptRevisions,
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  agentOwnershipEpoch,
  type AgentForkOutcome,
  type AgentForkRequest,
  type AgentForkRequestV4,
  type AgentTranscriptContentEpoch,
  type AgentTranscriptEntryId,
  type AgentTranscript,
} from '@garcon/server-agent-interface';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import {
  createJsonlForking,
  createProjectionJsonlForking,
  type JsonlForkingOptions,
} from '../jsonl-forking.js';

const roots: string[] = [];
const sourceAgentSessionId = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-07-20T00:00:00.000Z';

function materializedSession(outcome: AgentForkOutcome) {
  expect(outcome.kind).toBe('materialized');
  if (outcome.kind !== 'materialized') throw new Error('Expected a materialized fork');
  return outcome.session;
}

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
  } = {};
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
      nativeSeedReceipt: null,
      settings,
    },
    point: {
      messageSequence: 2,
      archivedMessageCount: 0,
      sourceRevision: {
        nativePrefix: computeAgentTranscriptRevisions(sourceMessages, 2).prefix,
        carryOver: 'carry-over',
      },
    },
  } satisfies AgentForkRequest;
  const options = {
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
  it('persists the provider-supplied target path immediately', async () => {
    const fixture = await createFixture();
    const forking = createJsonlForking({
      ...fixture.options,
      createTargetPath(input) {
        return path.join(fixture.root, `provider-${input.targetAgentSessionId}.jsonl`);
      },
    });

    const forked = materializedSession(await forking.fork(fixture.request));
    const native = fixture.nativeSessions.decode(forked.nativeSession);

    expect(native.path).toBe(path.join(fixture.root, `provider-${forked.agentSessionId}.jsonl`));
    await expect(readFile(native.path!, 'utf8')).resolves.toContain('"content":"first"');
  });

  it('allows appends after the selected provider-native prefix', async () => {
    const fixture = await createFixture();
    await writeFile(
      fixture.sourcePath,
      `${await readFile(fixture.sourcePath, 'utf8')}${JSON.stringify({
        type: 'message',
        content: 'appended while running',
      })}\n`,
    );

    const forked = materializedSession(await fixture.forking.fork(fixture.request));
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

  it('retargets a receipt only when the fork preserves its recorded prefix', async () => {
    const fixture = await createFixture();
    const prefix = 'first';
    const receipt = createNativeSeedReceipt({
      agentSessionId: sourceAgentSessionId,
      placement: 'user-prefix',
      prefix,
    });
    const source = { ...fixture.request.source, nativeSeedReceipt: receipt };

    const preserved = materializedSession(await fixture.forking.fork({
      ...fixture.request,
      source,
    }));
    const rewritingFork = createJsonlForking({
      ...fixture.options,
      rewriteEntry(entry, context) {
        const rewritten = fixture.options.rewriteEntry?.(entry, context) ?? entry;
        const record = rewritten as Record<string, unknown>;
        return record.type === 'message' && record.content === 'first'
          ? { ...record, content: 'rewritten' }
          : rewritten;
      },
    });
    const removed = materializedSession(await rewritingFork.fork({
      ...fixture.request,
      source,
      point: null,
    }));

    expect(preserved.nativeSeedReceipt).toEqual({
      ...receipt,
      agentSessionId: preserved.agentSessionId,
    });
    expect(removed.nativeSeedReceipt).toBeNull();
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

  it('rejects an archived count outside the selected sequence', async () => {
    const fixture = await createFixture();
    await expect(
      fixture.forking.fork({
        ...fixture.request,
        point: {
          ...fixture.request.point!,
          archivedMessageCount: fixture.request.point!.messageSequence + 1,
        },
      }),
    ).rejects.toMatchObject({ code: 'TRANSCRIPT_UNAVAILABLE' });
  });
});

describe('createJsonlForking empty native prefixes', () => {
  it('leaves a whole-session fork without a source session unmaterialized', async () => {
    const fixture = await createFixture();
    const forking = createJsonlForking({
      ...fixture.options,
      allowUnmaterializedWholeSession: true,
    });

    const result = await forking.fork({
      ...fixture.request,
      point: null,
      source: {
        ...fixture.request.source,
        agentSessionId: null,
        nativeSession: null,
      },
    });

    expect(result).toEqual({ kind: 'unmaterialized' });
    expect(await readdir(fixture.root)).toEqual(['source.jsonl']);
  });

  it('rejects a whole-session fork whose recorded session has no transcript path', async () => {
    const fixture = await createFixture();
    const forking = createJsonlForking({
      ...fixture.options,
      allowUnmaterializedWholeSession: true,
    });
    const nativeSession = fixture.nativeSessions.encode({
      path: null,
      agentSessionId: sourceAgentSessionId,
      modelEndpointId: null,
    });

    await expect(forking.fork({
      ...fixture.request,
      point: null,
      source: {
        ...fixture.request.source,
        nativeSession,
      },
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
  });

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
    const request = {
      ...fixture.request,
      point: {
        messageSequence: 1,
        archivedMessageCount: 1,
        sourceRevision: {
          nativePrefix: computeAgentTranscriptRevisions([], 0).prefix,
          carryOver: 'carry-over',
        },
      },
    } satisfies AgentForkRequest;

    const forked = materializedSession(await fixture.forking.fork(request));
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

describe('createProjectionJsonlForking', () => {
  it('forks from an exact projection entry and its serialized native alias', async () => {
    const fixture = await createFixture();
    const ownershipEpoch = agentOwnershipEpoch('ownership-1');
    const owner = {
      agentOwnershipEpoch: ownershipEpoch,
      commandType: 'fork-run' as const,
      clientRequestId: 'request-1',
      turnId: 'turn-1',
    };
    const projectionPoint = {
      kind: 'projection-entry' as const,
      agentOwnershipEpoch: ownershipEpoch,
      contentEpoch: 'content-1' as AgentTranscriptContentEpoch,
      entryId: 'entry-2' as AgentTranscriptEntryId,
      durableRevision: computeAgentTranscriptRevision(fixture.sourceMessages),
    };
    const native = {
      ownerId: 'test',
      schemaVersion: 1,
      value: {
        ordinal: 2,
        entryId: 'entry-2',
        source: { namespace: 'test:native', itemId: 'line:4', subrowId: 'row:0' },
        alias: { lineNumber: 4 },
        prefix: {
          semanticDigest: orderedTranscriptDigest(fixture.sourceMessages.map((message, index) => ({
            seq: index + 1,
            message,
          }))),
          firstLine: 3,
          lineCounts: { 3: 1, 4: 1 },
        },
      },
    } as const;
    const resolveNativeForkPoint = mock(async () => ({ kind: 'ready' as const, reference: native }));
    const forking = createProjectionJsonlForking({
      ...fixture.options,
      ownerId: 'test',
      projection: { resolveNativeForkPoint },
    });
    const request = {
      ...fixture.request,
      operation: {
        agentOwnershipEpoch: ownershipEpoch,
        commandType: 'fork-run' as const,
        clientRequestId: 'request-1',
        clientMessageId: null,
        turnId: 'turn-1',
        turnOwner: owner,
      },
      source: {
        ...fixture.request.source,
        agentOwnershipEpoch: ownershipEpoch,
      },
      point: { projection: projectionPoint, native },
    } satisfies AgentForkRequestV4;

    await expect(forking.resolvePoint({
      source: request.source,
      point: projectionPoint,
      signal: request.admission.signal,
    })).resolves.toEqual({ kind: 'ready', reference: native });
    const session = materializedSession(await forking.fork(request));
    const messages = await fixture.loadMessages(
      fixture.nativeSessions.decode(session.nativeSession).path!,
    );
    expect(messages.map((message) => (message as UserMessage).content)).toEqual([
      'first',
      'second',
    ]);
  });
});
