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

function request(point = null) {
  return {
    chatId: 'target-chat',
    projectPath: '/repo',
    model: 'gpt',
    settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    endpoint: null,
    admission: { signal: new AbortController().signal, markStarted() {} },
    source: {
      chatId: 'source-chat', agentId: 'codex', agentSessionId: 'source',
      projectPath: '/repo', model: 'gpt', nativeSession: null,
      carryOverRevision: '', settings: { ownerId: 'codex', schemaVersion: 1, values: {} },
    },
    point,
  };
}

function setup(profile, nativeImplementation = async () => startedSession) {
  const legacyFork = mock(async () => materialized);
  const forkPaginatedWhole = mock(nativeImplementation);
  const resolveProfile = mock(async () => profile);
  return {
    forking: createCodexForking({
      journal: {
        supportsAtMessage: true,
        supportsWhileRunning: true,
        fork: legacyFork,
        resolvePoint: mock(async () => ({ kind: 'unavailable', reason: 'no-native-source' })),
        discard: mock(async () => undefined),
      },
      resolveProfile,
      forkPaginatedWhole,
    }),
    legacyFork,
    forkPaginatedWhole,
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
    await expect(point.forking.fork(request({
      messageSequence: 2,
      archivedMessageCount: 0,
      sourceRevision: { nativePrefix: 'prefix', carryOver: 'carry-over' },
    }))).resolves.toBe(materialized);
    expect(point.legacyFork).toHaveBeenCalledTimes(1);
    expect(point.forkPaginatedWhole).not.toHaveBeenCalled();
  });

  it('rejects paginated point forks before either mutation strategy runs', async () => {
    const values = setup(paginatedProfile);
    await expect(values.forking.fork(request({
      messageSequence: 2,
      archivedMessageCount: 0,
      sourceRevision: { nativePrefix: 'prefix', carryOver: 'carry-over' },
    }))).rejects.toMatchObject({
      code: 'OPERATION_UNSUPPORTED',
      retryable: false,
      details: { operation: 'fork-at-message', historyMode: 'paginated', provider: 'codex' },
    });
    expect(values.legacyFork).not.toHaveBeenCalled();
    expect(values.forkPaginatedWhole).not.toHaveBeenCalled();
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
