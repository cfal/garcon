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
  getNativeMessageRevisionSource,
  orderedTranscriptDigest,
  agentOwnershipEpoch,
  type AgentForkOutcome,
  type AgentForkRequestV4,
  type AgentNativeForkRef,
  type AgentTranscriptContentEpoch,
  type AgentTranscriptEntryId,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../../transcript-projection/evidence-source.js';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import type { ForkTranscriptEntryContext } from '../fork-jsonl.js';
import { createProjectionJsonlForking } from '../jsonl-forking.js';

const roots: string[] = [];
const sourceAgentSessionId = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-07-20T00:00:00.000Z';
const ownershipEpoch = agentOwnershipEpoch('ownership-1');

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

// Serialized native fork reference exactly as the projection journal would
// produce it for the durable prefix ending at `ordinal`.
function nativePointFor(messages: readonly ChatMessage[], ordinal: number) {
  const prefix = messages.slice(0, ordinal);
  const lineCounts: Record<string, number> = {};
  let firstLine: number | null = null;
  let lineNumber = 0;
  for (const message of prefix) {
    const source = getNativeMessageRevisionSource(message);
    if (!source?.lineNumber) throw new Error('Fixture message is missing a native source');
    firstLine = firstLine === null ? source.lineNumber : Math.min(firstLine, source.lineNumber);
    lineCounts[String(source.lineNumber)] = (lineCounts[String(source.lineNumber)] ?? 0) + 1;
    lineNumber = Math.max(lineNumber, source.lineNumber);
  }
  return {
    ownerId: 'test',
    schemaVersion: 1,
    value: {
      ordinal,
      entryId: `entry-${ordinal}`,
      source: { namespace: 'test:native', itemId: `line:${lineNumber}`, subrowId: 'row:0' },
      alias: { lineNumber },
      prefix: {
        semanticDigest: orderedTranscriptDigest(prefix.map((message, index) => ({
          seq: index + 1,
          message,
        }))),
        firstLine,
        lineCounts,
      },
    },
  } as const satisfies AgentNativeForkRef;
}

async function createFixture() {
  const root = await mkdtemp(path.join(os.tmpdir(), 'garcon-jsonl-forking-'));
  roots.push(root);
  const sourcePath = path.join(root, 'source.jsonl');
  await writeFile(sourcePath, sourceContent());
  const nativeSessions = createPathNativeSessionCodec('test');
  const controls: { verificationFailure?: unknown } = {};
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
  const nativeEvidence = {
    async resolveNativeSession({ chat }) {
      return chat.nativeSession;
    },
    async load({ chat }) {
      const native = nativeSessions.decode(chat.nativeSession);
      if (native.path !== sourcePath && controls.verificationFailure) {
        throw controls.verificationFailure;
      }
      return { messages: await loadMessages(native.path!) };
    },
  } satisfies Pick<AgentNativeEvidenceSource, 'load' | 'resolveNativeSession'>;
  const sourceMessages = await loadMessages(sourcePath);
  const settings = { ownerId: 'test', schemaVersion: 1, values: {} } as const;
  const sourceNativeSession = nativeSessions.encode({
    path: sourcePath,
    agentSessionId: sourceAgentSessionId,
    modelEndpointId: null,
  });
  const native = nativePointFor(sourceMessages, 2);
  const projectionPoint = {
    kind: 'projection-entry' as const,
    agentOwnershipEpoch: ownershipEpoch,
    contentEpoch: 'content-1' as AgentTranscriptContentEpoch,
    entryId: 'entry-2' as AgentTranscriptEntryId,
    durableRevision: computeAgentTranscriptRevision(sourceMessages),
  };
  const request = {
    chatId: 'target-chat',
    projectPath: root,
    model: 'test-model',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings,
    endpoint: null,
    operation: {
      agentOwnershipEpoch: ownershipEpoch,
      commandType: 'fork-run',
      clientRequestId: 'request-1',
      clientMessageId: null,
      turnId: 'turn-1',
      turnOwner: {
        agentOwnershipEpoch: ownershipEpoch,
        commandType: 'fork-run',
        clientRequestId: 'request-1',
        turnId: 'turn-1',
      },
    },
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
      markAbortable() {},
    },
    source: {
      chatId: 'source-chat',
      agentId: 'test',
      agentOwnershipEpoch: ownershipEpoch,
      agentSessionId: sourceAgentSessionId,
      projectPath: root,
      model: 'test-model',
      nativeSession: sourceNativeSession,
      carryOverRevision: 'carry-over',
      nativeSeedReceipt: null,
      settings,
    },
    point: { projection: projectionPoint, native },
  } satisfies AgentForkRequestV4;
  const resolveNativeForkPoint = mock(async () => ({ kind: 'ready' as const, reference: native }));
  const options = {
    ownerId: 'test',
    supportsWhileRunning: true,
    projection: { resolveNativeForkPoint },
    nativeEvidence,
    nativeSessions,
    rewriteEntry(entry: unknown, context: ForkTranscriptEntryContext) {
      const record = entry as Record<string, unknown>;
      if (record.type === 'session') {
        return { ...record, sessionId: context.targetAgentSessionId };
      }
      if (record.type === 'fallback' && context.retainedMessageCount === 0) {
        return { type: 'filtered' };
      }
      return entry;
    },
  };
  return {
    root,
    sourcePath,
    sourceMessages,
    loadMessages,
    nativeSessions,
    controls,
    request,
    native,
    projectionPoint,
    resolveNativeForkPoint,
    options,
    forking: createProjectionJsonlForking(options),
  };
}

describe('createProjectionJsonlForking point resolution', () => {
  it('forks from an exact projection entry and its serialized native alias', async () => {
    const fixture = await createFixture();

    await expect(fixture.forking.resolvePoint({
      source: fixture.request.source,
      point: fixture.projectionPoint,
      signal: fixture.request.admission.signal,
    })).resolves.toEqual({ kind: 'ready', reference: fixture.native });
    const session = materializedSession(await fixture.forking.fork(fixture.request));
    const messages = await fixture.loadMessages(
      fixture.nativeSessions.decode(session.nativeSession).path!,
    );
    expect(messages.map((message) => (message as UserMessage).content)).toEqual([
      'first',
      'second',
    ]);
  });

  it('persists the provider-supplied target path immediately', async () => {
    const fixture = await createFixture();
    const forking = createProjectionJsonlForking({
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
    expect(forkedMessages).not.toContainEqual(
      expect.objectContaining({ content: 'appended while running' }),
    );
  });

  it('retargets a receipt only when the fork preserves its recorded prefix', async () => {
    const fixture = await createFixture();
    const receipt = createNativeSeedReceipt({
      agentSessionId: sourceAgentSessionId,
      placement: 'user-prefix',
      prefix: 'first',
    });
    const source = { ...fixture.request.source, nativeSeedReceipt: receipt };

    const preserved = materializedSession(await fixture.forking.fork({
      ...fixture.request,
      source,
    }));
    const rewritingFork = createProjectionJsonlForking({
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
});

describe('createProjectionJsonlForking prefix protection', () => {
  it('rejects a retained-prefix mutation observed while copying', async () => {
    const fixture = await createFixture();
    let mutated = false;
    const forking = createProjectionJsonlForking({
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

  it('rejects a fork that does not preserve the projection prefix rendering', async () => {
    const fixture = await createFixture();
    const filesBeforeFork = await readdir(fixture.root);
    await writeFile(
      fixture.sourcePath,
      (await readFile(fixture.sourcePath, 'utf8')).replace('"content":"first"', '"content":"changed"'),
    );

    await expect(fixture.forking.fork(fixture.request)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
    expect(await readdir(fixture.root)).toEqual(filesBeforeFork);
  });

  it('propagates verification read failures and removes the fork target', async () => {
    const fixture = await createFixture();
    const filesBeforeFork = await readdir(fixture.root);
    const failure = new AgentIntegrationError(
      'PROVIDER_FAILURE',
      'Provider transcript read failed',
      true,
    );
    fixture.controls.verificationFailure = failure;

    await expect(fixture.forking.fork(fixture.request)).rejects.toBe(failure);
    expect(await readdir(fixture.root)).toEqual(filesBeforeFork);
  });
});

describe('createProjectionJsonlForking empty native prefixes', () => {
  it('leaves a whole-session fork without a source session unmaterialized', async () => {
    const fixture = await createFixture();
    const forking = createProjectionJsonlForking({
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
    const forking = createProjectionJsonlForking({
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
});
