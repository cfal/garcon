import { expect, mock, test } from 'bun:test';
import { createLocatedInstanceFixture } from '../../agents/__tests__/located-instance-fixture.js';
import { DomainError } from '../../lib/domain-error.js';
import { resolveLocalNativeSessions } from '../local-native-sessions.js';

/** @satisfies {import('../../chats/agent-ownership-journal.js').LocatedNativeRelease} */
const reference = {
  executionLocation: { nodeId: 'local-node', instanceId: 'secondary', workspaceId: 'project' },
  chat: {
    chatId: '1000000000000001', agentId: 'test', agentSessionId: 'synthetic-session',
    projectPath: '/synthetic-project', model: 'synthetic-model', nativeSession: null,
    carryOverRevision: 'synthetic-revision', nativeSeedReceipt: null, settings: null,
  },
};

test('native cleanup resolves the recorded instance only after placement validation', async () => {
  const f = await createLocatedInstanceFixture();
  /** @satisfies {Pick<import('../local-placement.js').LocalExecutionPlacement, 'assertAvailable'>} */
  const placements = { assertAvailable: mock(() => {}) };
  try {
    const sessions = resolveLocalNativeSessions(reference, placements, f.instances);
    expect(placements.assertAvailable).toHaveBeenCalledWith({
      ...reference.chat, executionLocation: reference.executionLocation,
    });
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
  /** @satisfies {Pick<import('../local-placement.js').LocalExecutionPlacement, 'assertAvailable'>} */
  const placements = { assertAvailable: mock(() => { if (unavailable === 'placement') throw failure; }) };
  /** @satisfies {Pick<import('../../agents/instance-directory.js').AgentInstanceDirectory, 'nativeSessionsFor'>} */
  const instances = { nativeSessionsFor: mock(() => { throw failure; }) };
  expect(resolveLocalNativeSessions(reference, placements, instances)).toBeNull();
  expect(instances.nativeSessionsFor).toHaveBeenCalledTimes(unavailable === 'placement' ? 0 : 1);
});

test.each([
  new Error('Synthetic unexpected failure'),
  new DomainError('NODE_SESSION_EXPIRED', 'Synthetic expired session', 409),
  Object.assign(new Error('Synthetic untyped failure'), { code: 'NODE_UNAVAILABLE' }),
  Object.assign(new Error('Synthetic untyped tombstone'), { code: 'NODE_REMOVED' }),
])('unexpected resolution failures remain visible: %s', (failure) => {
  /** @satisfies {Pick<import('../local-placement.js').LocalExecutionPlacement, 'assertAvailable'>} */
  const placements = { assertAvailable() {} };
  /** @satisfies {Pick<import('../../agents/instance-directory.js').AgentInstanceDirectory, 'nativeSessionsFor'>} */
  const instances = { nativeSessionsFor() { throw failure; } };
  expect(() => resolveLocalNativeSessions(reference, placements, instances)).toThrow(failure);
});
