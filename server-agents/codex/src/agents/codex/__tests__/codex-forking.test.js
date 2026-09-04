import { describe, expect, it, mock } from 'bun:test';
import { CodexAppServerRpcError } from '../app-server/client.ts';
import { createCodexForking, isCodexThreadNotFound } from '../codex-forking.ts';

const legacyProfile = {
  mode: 'legacy', nativePath: '/tmp/legacy.jsonl', threadId: 'source',
  createdAt: '2026-07-20T00:00:00.000Z',
};
const paginatedProfile = {
  mode: 'paginated', nativePath: '/tmp/paginated.jsonl', threadId: 'source',
  createdAt: '2026-07-20T00:00:00.000Z', historyBase: null,
};
const startedSession = { agentSessionId: 'target', nativeSession: null };
const materialized = { kind: 'materialized', session: startedSession };

function request(providerMeta = null) {
  return {
    chatId: 'target-chat',
    projectPath: '/repo',
    model: 'gpt',
    permissionMode: 'default',
    thinkingMode: 'none',
    settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    endpoint: null,
    admission: { signal: new AbortController().signal, markStarted() {} },
    source: {
      chatId: 'source-chat', agentId: 'codex', agentSessionId: 'source',
      projectPath: '/repo', model: 'gpt', nativeSession: null,
      carryOverRevision: '', nativeSeedReceipt: null,
      settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    },
    providerMeta,
  };
}

function setup(profile, nativeImplementation = async () => startedSession) {
  const legacyFork = mock(async () => materialized);
  const forkPaginatedWhole = mock(nativeImplementation);
  const forkPaginatedPoint = mock(nativeImplementation);
  const resolveProfile = mock(async () => profile);
  return {
    forking: createCodexForking({
      journal: {
        fork: legacyFork,
        discard: mock(async () => undefined),
      },
      resolveProfile,
      forkPaginatedWhole,
      forkPaginatedPoint,
    }),
    legacyFork,
    forkPaginatedWhole,
    forkPaginatedPoint,
    resolveProfile,
  };
}

describe('createCodexForking', () => {
  it('routes every legacy fork through the existing verified JSONL strategy', async () => {
    const full = setup(legacyProfile);
    await expect(full.forking.fork(request())).resolves.toBe(materialized);
    expect(full.legacyFork).toHaveBeenCalledTimes(1);
    expect(full.forkPaginatedWhole).not.toHaveBeenCalled();

    const point = setup(legacyProfile);
    await expect(point.forking.fork(request({ entryId: 'item-2' }))).resolves.toBe(materialized);
    expect(point.legacyFork).toHaveBeenCalledTimes(1);
    expect(point.forkPaginatedWhole).not.toHaveBeenCalled();
  });

  it('forks a paginated point natively through the turn named by its source identity', async () => {
    const values = setup(paginatedProfile);
    await expect(values.forking.fork(request({ entryId: 'turn:turn-1:item:item-2' })))
      .resolves.toEqual(materialized);
    expect(values.forkPaginatedPoint.mock.calls[0][1]).toBe('turn-1');
    expect(values.forkPaginatedPoint.mock.calls[0][0].providerMeta)
      .toEqual({ entryId: 'turn:turn-1:item:item-2' });
    expect(values.forkPaginatedWhole).not.toHaveBeenCalled();
    expect(values.legacyFork).not.toHaveBeenCalled();

    const toolIdentity = setup(paginatedProfile);
    await expect(toolIdentity.forking.fork(request({ entryId: 'turn:turn-2:tool:call-9' })))
      .resolves.toEqual(materialized);
    expect(toolIdentity.forkPaginatedPoint.mock.calls[0][1]).toBe('turn-2');
  });

  it('refuses a paginated point whose identity names no turn', async () => {
    const values = setup(paginatedProfile);
    await expect(values.forking.fork(request({ entryId: 'item-2' }))).rejects.toMatchObject({
      code: 'TRANSCRIPT_UNAVAILABLE',
      retryable: true,
      details: { nativeForkReason: 'not-settled' },
    });
    expect(values.forkPaginatedPoint).not.toHaveBeenCalled();
    expect(values.forkPaginatedWhole).not.toHaveBeenCalled();
    expect(values.legacyFork).not.toHaveBeenCalled();
  });

  it('maps in-progress and unknown lastTurnId rejections to the typed unsettled refusal', async () => {
    const inProgress = setup(paginatedProfile, async () => {
      throw new CodexAppServerRpcError(
        "lastTurnId 'turn-1' identifies an in-progress turn",
        -32600,
      );
    });
    await expect(inProgress.forking.fork(request({ entryId: 'turn:turn-1:item:item-2' })))
      .rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
        details: { nativeForkReason: 'not-settled' },
      });

    const unknown = setup(paginatedProfile, async () => {
      throw new CodexAppServerRpcError('turn not found: turn-9', -32600);
    });
    await expect(unknown.forking.fork(request({ entryId: 'turn:turn-9:item:item-2' })))
      .rejects.toMatchObject({
        code: 'TRANSCRIPT_UNAVAILABLE',
        retryable: true,
        details: { nativeForkReason: 'not-settled' },
      });
  });

  it('maps the upstream paginated rejection of a point fork to typed unsupported', async () => {
    const values = setup(paginatedProfile, async () => {
      throw new CodexAppServerRpcError('paginated_threads is not supported yet', -32601);
    });
    await expect(values.forking.fork(request({ entryId: 'turn:turn-1:item:item-2' })))
      .rejects.toMatchObject({
        code: 'OPERATION_UNSUPPORTED',
        retryable: false,
        details: { operation: 'fork', historyMode: 'paginated', provider: 'codex' },
      });
    expect(values.legacyFork).not.toHaveBeenCalled();
  });

  it('uses only provider-native thread/fork for a paginated full fork', async () => {
    const values = setup(paginatedProfile);
    await expect(values.forking.fork(request())).resolves.toEqual(materialized);
    expect(values.forkPaginatedWhole).toHaveBeenCalledTimes(1);
    expect(values.legacyFork).not.toHaveBeenCalled();
  });

  it('maps the current upstream paginated rejection to typed unsupported', async () => {
    const values = setup(paginatedProfile, async () => {
      throw new CodexAppServerRpcError('paginated_threads is not supported yet', -32601);
    });
    await expect(values.forking.fork(request())).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
      retryable: false,
      details: { operation: 'fork', historyMode: 'paginated', provider: 'codex' },
    });
    expect(values.legacyFork).not.toHaveBeenCalled();
  });
});

describe('isCodexThreadNotFound', () => {
  it('matches only the pinned app-server missing-rollout error', () => {
    const threadId = '00000000-0000-4000-8000-000000000001';
    expect(isCodexThreadNotFound(new CodexAppServerRpcError(
      `no rollout found for thread id ${threadId}`,
      -32600,
    ))).toBe(true);
    expect(isCodexThreadNotFound(new CodexAppServerRpcError(
      `no rollout found for thread id ${threadId}`,
      -32602,
    ))).toBe(false);
    expect(isCodexThreadNotFound(new CodexAppServerRpcError(
      `thread not found: ${threadId}`,
      -32600,
    ))).toBe(false);
    expect(isCodexThreadNotFound(new CodexAppServerRpcError(
      'failed to resolve rollout path `/tmp/missing.jsonl`: file does not exist',
      -32600,
    ))).toBe(true);
  });
});
