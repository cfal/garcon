import { describe, expect, it, mock } from 'bun:test';
import { receiptForCarriedContext } from '@garcon/common/transcript-seed';
import { createPathNativeSessionCodec } from '@garcon/server-agent-common/native-session/path-native-session';
import { createOpenCodeNativeForking } from '../forking.js';
import { OpenCodeRuntime } from '../opencode.js';

async function* neverEndingStream() {
  yield { payload: { id: 'evt_connected', type: 'server.connected', properties: {} } };
  await new Promise(() => {});
}

function createForking(session) {
  const runtime = new OpenCodeRuntime({
    createInstance: mock(() => Promise.resolve({
      client: {
        permission: { reply: mock(() => Promise.resolve({})) },
        global: { event: mock(() => Promise.resolve({ stream: neverEndingStream() })) },
        session,
      },
      server: { close: mock(() => {}) },
    })),
  });
  const nativeSessions = createPathNativeSessionCodec('opencode');
  return {
    runtime,
    nativeSessions,
    forking: createOpenCodeNativeForking({
      runtime,
      nativeSessions,
      sessionId: (chat) => chat.agentSessionId ?? null,
    }),
  };
}

function forkRequest(overrides = {}) {
  return {
    chatId: 'target-chat',
    projectPath: '/repo',
    model: 'deepseek/deepseek-v4-flash',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: { ownerId: 'opencode', schemaVersion: 1, values: {} },
    endpoint: null,
    admission: {
      signal: new AbortController().signal,
      markStarted: () => Promise.resolve(),
    },
    source: {
      chatId: 'source-chat',
      agentId: 'opencode',
      agentSessionId: 'source-session',
      nativeSession: null,
      nativeSeedReceipt: null,
    },
    providerMeta: null,
    ...overrides,
  };
}

function storedMessage(id, role, parts = []) {
  return {
    info: { id, role, time: { created: '2026-08-20T00:00:00.000Z' } },
    parts,
  };
}

const STORED_SOURCE_MESSAGES = [
  storedMessage('msg_a', 'user', [{ type: 'text', text: 'first prompt' }]),
  storedMessage('msg_b', 'assistant', [
    { id: 'prt_b1', type: 'text', text: 'first reply' },
  ]),
  storedMessage('msg_c', 'user', [{ type: 'text', text: 'second prompt' }]),
  storedMessage('msg_d', 'assistant', [
    { id: 'prt_d1', type: 'text', text: 'second reply' },
  ]),
];

describe('[TLV5-FORK.01-OPENCODE-UNIT-01] OpenCode native forking facet', () => {
  it('forks the whole session without a boundary and encodes the forked session', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { forking, nativeSessions } = createForking({ fork });

    const outcome = await forking.fork(forkRequest());

    expect(outcome.kind).toBe('materialized');
    expect(outcome.session.agentSessionId).toBe('forked-session');
    expect(nativeSessions.decode(outcome.session.nativeSession).agentSessionId)
      .toBe('forked-session');
    expect(outcome.session.nativeSeedReceipt).toBeNull();
    expect(fork.mock.calls[0][0]).toEqual({
      sessionID: 'source-session',
      directory: '/repo',
    });
  });

  it('bounds a part anchor just past its owning message', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const messages = mock(() => Promise.resolve({ data: STORED_SOURCE_MESSAGES }));
    const { forking } = createForking({ fork, messages });

    const outcome = await forking.fork(forkRequest({
      providerMeta: { entryId: 'prt_b1', withinSourceOrdinal: 0 },
    }));

    expect(outcome.kind).toBe('materialized');
    expect(fork.mock.calls[0][0]).toEqual({
      sessionID: 'source-session',
      messageID: 'msg_b0',
      directory: '/repo',
    });
  });

  it('bounds message anchors, including a last-message anchor, past their own message', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const messages = mock(() => Promise.resolve({ data: STORED_SOURCE_MESSAGES }));
    const { forking } = createForking({ fork, messages });

    const atUserRow = await forking.fork(forkRequest({
      providerMeta: { entryId: 'msg_c' },
    }));
    expect(atUserRow.kind).toBe('materialized');
    expect(fork.mock.calls[0][0]).toMatchObject({ messageID: 'msg_c0' });

    // A last-message anchor still carries a boundary, so provider messages
    // appended between resolution and the fork call stay excluded.
    const atTip = await forking.fork(forkRequest({
      providerMeta: { entryId: 'prt_d1' },
    }));
    expect(atTip.kind).toBe('materialized');
    expect(fork.mock.calls[1][0]).toEqual({
      sessionID: 'source-session',
      messageID: 'msg_d0',
      directory: '/repo',
    });
  });

  it('deletes the forked session when receipt retargeting fails after the fork', async () => {
    const receipt = receiptForCarriedContext({ prefix: 'SEED::' }, 'source-session');
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const sessionDelete = mock(() => Promise.resolve({}));
    const get = mock(() => Promise.resolve({ error: { name: 'InternalError' } }));
    const messages = mock(() => Promise.resolve({ data: [] }));
    const { forking } = createForking({ fork, delete: sessionDelete, get, messages });

    const failure = await forking.fork(forkRequest({
      source: {
        chatId: 'source-chat',
        agentId: 'opencode',
        agentSessionId: 'source-session',
        nativeSession: null,
        nativeSeedReceipt: receipt,
      },
    })).then(() => null, (error) => error);

    expect(failure).not.toBeNull();
    expect(sessionDelete).toHaveBeenCalledTimes(1);
    expect(sessionDelete.mock.calls[0][0]).toEqual({ sessionID: 'forked-session' });
  });

  it('refuses an anchor the provider has not persisted as not settled', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const messages = mock(() => Promise.resolve({ data: STORED_SOURCE_MESSAGES }));
    const { forking } = createForking({ fork, messages });

    const failure = await forking.fork(forkRequest({
      providerMeta: { entryId: 'prt_unpersisted' },
    })).then(() => null, (error) => error);

    expect(failure?.details).toEqual({ nativeForkReason: 'not-settled' });
    expect(failure?.retryable).toBe(true);
    expect(fork).not.toHaveBeenCalled();
  });

  it('stays unmaterialized for a sessionless whole-chat fork and refuses a point fork', async () => {
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const { forking } = createForking({ fork });
    const sessionless = forkRequest();
    sessionless.source = { ...sessionless.source, agentSessionId: null };

    await expect(forking.fork(sessionless)).resolves.toEqual({ kind: 'unmaterialized' });

    const point = forkRequest({ providerMeta: { entryId: 'prt_b1' } });
    point.source = { ...point.source, agentSessionId: null };
    const failure = await forking.fork(point).then(() => null, (error) => error);
    expect(failure?.details).toEqual({ nativeForkReason: 'not-settled' });
    expect(fork).not.toHaveBeenCalled();
  });

  it('retargets a preserved seed receipt onto the forked session', async () => {
    const receipt = receiptForCarriedContext({ prefix: 'SEED::' }, 'source-session');
    const fork = mock(() => Promise.resolve({ data: { id: 'forked-session' } }));
    const get = mock(() => Promise.resolve({ data: { directory: '/repo' } }));
    const messages = mock(() => Promise.resolve({
      data: [
        storedMessage('msg_f1', 'user', [{ type: 'text', text: 'SEED::first prompt' }]),
        storedMessage('msg_f2', 'assistant', [
          { id: 'prt_f2', type: 'text', text: 'first reply' },
        ]),
      ],
    }));
    const { forking } = createForking({ fork, get, messages });

    const outcome = await forking.fork(forkRequest({
      source: {
        chatId: 'source-chat',
        agentId: 'opencode',
        agentSessionId: 'source-session',
        nativeSession: null,
        nativeSeedReceipt: receipt,
      },
    }));

    expect(outcome.kind).toBe('materialized');
    expect(outcome.session.nativeSeedReceipt).toEqual({
      ...receipt,
      agentSessionId: 'forked-session',
    });
  });

  it('deletes the forked session on discard', async () => {
    const sessionDelete = mock(() => Promise.resolve({}));
    const { forking } = createForking({ delete: sessionDelete });

    await forking.discard(
      { agentSessionId: 'forked-session', nativeSession: null, nativeSeedReceipt: null },
      new AbortController().signal,
    );

    expect(sessionDelete).toHaveBeenCalledTimes(1);
    expect(sessionDelete.mock.calls[0][0]).toEqual({ sessionID: 'forked-session' });
  });
});
