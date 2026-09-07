import { afterEach, describe, expect, it } from 'bun:test';
import { writeFileSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { UserMessage, type ChatMessage } from '@garcon/common/chat-types';
import { createNativeSeedReceipt } from '@garcon/common/transcript-seed';
import {
  AgentIntegrationError,
  attachNativeMessageSource,
  getNativeMessageRevisionSource,
  type AgentNativeForkOutcome,
  type AgentNativeForkRequest,
} from '@garcon/server-agent-interface';
import type { AgentNativeEvidenceSource } from '../../native-session/evidence-source.js';
import { createPathNativeSessionCodec } from '../../native-session/path-native-session.js';
import type { ForkTranscriptEntryContext } from '../fork-jsonl.js';
import { createJsonlNativeForking } from '../jsonl-forking.js';

const roots: string[] = [];
const sourceAgentSessionId = '11111111-1111-1111-1111-111111111111';
const timestamp = '2026-07-20T00:00:00.000Z';

function materializedSession(outcome: AgentNativeForkOutcome) {
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
  const selectedSource = getNativeMessageRevisionSource(sourceMessages[1]);
  if (!selectedSource) throw new Error('Fixture message is missing native metadata');
  const providerMeta = { ...selectedSource };
  const request = {
    chatId: 'target-chat',
    projectPath: root,
    model: 'test-model',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings,
    endpoint: null,
    admission: {
      signal: new AbortController().signal,
      async markStarted() {},
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
    providerMeta,
  } satisfies AgentNativeForkRequest;
  const options = {
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
    providerMeta,
    options,
    forking: createJsonlNativeForking(options),
  };
}

describe('createJsonlNativeForking provider positions', () => {
  it('forks through the ledger row selected by provider metadata', async () => {
    const fixture = await createFixture();

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
    const forking = createJsonlNativeForking({
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
    const rewritingFork = createJsonlNativeForking({
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
      providerMeta: null,
    }));

    expect(preserved.nativeSeedReceipt).toEqual({
      ...receipt,
      agentSessionId: preserved.agentSessionId,
    });
    expect(removed.nativeSeedReceipt).toBeNull();
  });
});

describe('createJsonlNativeForking prefix protection', () => {
  it('rejects a retained-prefix mutation observed while copying', async () => {
    const fixture = await createFixture();
    let mutated = false;
    const forking = createJsonlNativeForking({
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

  it('refuses a point in a source the provider has not written yet as source-missing', async () => {
    const fixture = await createFixture();
    await rm(fixture.sourcePath, { force: true });

    await expect(fixture.forking.fork(fixture.request)).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
      details: { nativeForkReason: 'source-missing' },
    });
  });

  it('rejects a selected row that cannot be found in native history', async () => {
    const fixture = await createFixture();
    const filesBeforeFork = await readdir(fixture.root);

    await expect(fixture.forking.fork({
      ...fixture.request,
      providerMeta: { entryId: 'missing' },
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      details: { nativeForkReason: 'not-settled' },
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

    const receipt = createNativeSeedReceipt({
      agentSessionId: sourceAgentSessionId,
      placement: 'user-prefix',
      prefix: 'first',
    });
    await expect(fixture.forking.fork({
      ...fixture.request,
      source: { ...fixture.request.source, nativeSeedReceipt: receipt },
    })).rejects.toBe(failure);
    expect(await readdir(fixture.root)).toEqual(filesBeforeFork);
  });

  it('removes an untransformed whole-session fork cancelled during receipt verification', async () => {
    const fixture = await createFixture();
    const filesBeforeFork = await readdir(fixture.root);
    const controller = new AbortController();
    const reason = new Error('fork admission cancelled');
    const nativeEvidence = {
      ...fixture.options.nativeEvidence,
      async load(input: Parameters<AgentNativeEvidenceSource['load']>[0]) {
        const native = fixture.nativeSessions.decode(input.chat.nativeSession);
        if (native.path !== fixture.sourcePath) {
          controller.abort(reason);
          input.signal.throwIfAborted();
        }
        return fixture.options.nativeEvidence.load(input);
      },
    } satisfies Pick<AgentNativeEvidenceSource, 'load' | 'resolveNativeSession'>;
    const forking = createJsonlNativeForking({
      ...fixture.options,
      nativeEvidence,
    });
    const receipt = createNativeSeedReceipt({
      agentSessionId: sourceAgentSessionId,
      placement: 'user-prefix',
      prefix: 'first',
    });

    await expect(forking.fork({
      ...fixture.request,
      providerMeta: null,
      admission: {
        ...fixture.request.admission,
        signal: controller.signal,
      },
      source: {
        ...fixture.request.source,
        nativeSeedReceipt: receipt,
      },
    })).rejects.toBe(reason);
    expect(await readdir(fixture.root)).toEqual(filesBeforeFork);
  });
});

describe('createJsonlNativeForking empty native prefixes', () => {
  it('leaves a whole-session fork without a source session unmaterialized', async () => {
    const fixture = await createFixture();
    const forking = createJsonlNativeForking({
      ...fixture.options,
      allowUnmaterializedWholeSession: true,
    });

    const result = await forking.fork({
      ...fixture.request,
      providerMeta: null,
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
    const forking = createJsonlNativeForking({
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
      providerMeta: null,
      source: {
        ...fixture.request.source,
        nativeSession,
      },
    })).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
    });
  });
});
