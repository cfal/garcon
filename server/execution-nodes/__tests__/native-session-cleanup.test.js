import { expect, mock, test } from 'bun:test';
import { createLocatedInstanceFixture } from '../../agents/__tests__/located-instance-fixture.js';
import { DomainError } from '../../lib/domain-error.js';
import { resolveNativeSessionCleanup } from '../native-session-cleanup.js';

/** @satisfies {import('../../chats/agent-ownership-journal.js').LocatedNativeRelease} */
const reference = {
  executionLocation: { nodeId: 'local-node', instanceId: 'secondary', workspaceId: 'project' },
  chat: {
    chatId: '1000000000000001', agentId: 'test', agentSessionId: 'synthetic-session',
    projectPath: '/synthetic-project', model: 'synthetic-model', nativeSession: null,
    carryOverRevision: 'synthetic-revision', nativeSeedReceipt: null, settings: null,
  },
};

/** @returns {import('../store.js').ResolvedExecutionLocation} */
function location() {
  return {
    node: { id: 'local-node', kind: 'local', label: 'Synthetic', removedAt: null },
    instance: { id: 'secondary', nodeId: 'local-node', agentId: 'test', label: 'Synthetic',
      storageNamespace: 'instances/secondary', default: false, removedAt: null },
    workspace: { id: 'project', nodeId: 'local-node', projectPath: '/synthetic-project', removedAt: null },
  };
}

test('native cleanup resolves the recorded instance only after placement validation', async () => {
  const f = await createLocatedInstanceFixture();
  /** @satisfies {Pick<import('../store.js').ExecutionNodesStore, 'requireLocation'>} */
  const nodes = { requireLocation: mock(() => location()) };
  try {
    const sessions = resolveNativeSessionCleanup(reference, nodes, f.instances);
    expect(nodes.requireLocation).toHaveBeenCalledWith(reference.executionLocation, reference.chat.agentId);
    const signal = new AbortController().signal;
    await sessions.release({ chat: reference.chat, reason: 'deleted' }, signal);
    expect(f.primary.integration.nativeSessions.release).not.toHaveBeenCalled();
    expect(f.secondary.integration.nativeSessions.release).toHaveBeenCalledTimes(1);
    expect(f.secondary.integration.nativeSessions.release).toHaveBeenCalledWith({
      chat: { ...reference.chat, settings: { ownerId: 'test', schemaVersion: 1, values: { parsedBy: 'secondary' } } },
      reason: 'deleted', signal,
    });
  } finally {
    await f.dispose();
  }
});

test.each([
  ['placement', 'NODE_UNAVAILABLE'], ['instance', 'NODE_UNAVAILABLE'],
  ['placement', 'NODE_REMOVED'], ['instance', 'NODE_REMOVED'],
])('unavailable %s (%s) leaves native cleanup pending', (unavailable, code) => {
  const failure = new DomainError(code, 'Synthetic unavailable owner', 409);
  /** @satisfies {Pick<import('../store.js').ExecutionNodesStore, 'requireLocation'>} */
  const nodes = { requireLocation: mock(() => { if (unavailable === 'placement') throw failure; return location(); }) };
  /** @satisfies {Pick<import('../../agents/instance-directory.js').AgentInstanceDirectory, 'nativeSessionsFor'>} */
  const instances = { nativeSessionsFor: mock(() => { throw failure; }) };
  expect(resolveNativeSessionCleanup(reference, nodes, instances)).toBeNull();
  expect(instances.nativeSessionsFor).toHaveBeenCalledTimes(unavailable === 'placement' ? 0 : 1);
});

test.each([
  new Error('Synthetic unexpected failure'),
  new DomainError('NODE_SESSION_EXPIRED', 'Synthetic expired session', 409),
  Object.assign(new Error('Synthetic untyped failure'), { code: 'NODE_UNAVAILABLE' }),
  Object.assign(new Error('Synthetic untyped tombstone'), { code: 'NODE_REMOVED' }),
])('unexpected resolution failures remain visible: %s', (failure) => {
  /** @satisfies {Pick<import('../store.js').ExecutionNodesStore, 'requireLocation'>} */
  const nodes = { requireLocation: location };
  /** @satisfies {Pick<import('../../agents/instance-directory.js').AgentInstanceDirectory, 'nativeSessionsFor'>} */
  const instances = { nativeSessionsFor() { throw failure; } };
  expect(() => resolveNativeSessionCleanup(reference, nodes, instances)).toThrow(failure);
});

test('a changed registered project cannot redirect retained cleanup', () => {
  /** @satisfies {Pick<import('../store.js').ExecutionNodesStore, 'requireLocation'>} */
  const nodes = { requireLocation: location };
  /** @satisfies {Pick<import('../../agents/instance-directory.js').AgentInstanceDirectory, 'nativeSessionsFor'>} */
  const instances = { nativeSessionsFor: mock(() => { throw new Error('Unexpected provider lookup'); }) };
  expect(resolveNativeSessionCleanup({ ...reference, chat: { ...reference.chat, projectPath: '/different' } }, nodes, instances)).toBeNull();
  expect(instances.nativeSessionsFor).not.toHaveBeenCalled();
});
