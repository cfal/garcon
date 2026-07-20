import { describe, expect, mock, test } from 'bun:test';
import type {
  AgentHost,
  AgentMigrationStore,
} from '@garcon/server-agent-interface';
import { relocateLegacySessionDirectory } from '../legacy-session-relocation.js';

function createStore(initialVersion = 0) {
  let version = initialVersion;
  const commit = mock(async (request: Parameters<AgentMigrationStore['commit']>[0]) => {
    if (request.expectedVersion !== version) throw new Error('Unexpected migration version');
    version = request.nextVersion;
  });
  const store = {
    getVersion: async () => version,
    read: async () => undefined,
    commit,
  } satisfies AgentMigrationStore;
  return { commit, store };
}

function createHost(
  claimLegacyWorkspaceDirectory: AgentHost['storage']['claimLegacyWorkspaceDirectory'],
) {
  const info = mock(() => undefined);
  const host = {
    agentId: 'direct-test',
    logger: { debug() {}, info, warn() {}, error() {} },
    storage: {
      rootDirectory: '/tmp/direct-test',
      directory: async () => '/tmp/direct-test/sessions',
      claimLegacyWorkspaceDirectory,
    },
    environment: { get: () => undefined },
    apiProviders: { resolveCredential: async () => null },
    carryOver: {
      load: async ({ expectedRevision }) => ({ revision: expectedRevision, messages: [] }),
    },
  } satisfies AgentHost;
  return { host, info };
}

describe('relocateLegacySessionDirectory', () => {
  test('claims legacy storage and commits the relocation version', async () => {
    const claim = mock(async () => ({ moved: 2, skipped: 1 }));
    const { host, info } = createHost(claim);
    const { commit, store } = createStore();

    await relocateLegacySessionDirectory(host, store, 'legacy-sessions');

    expect(claim).toHaveBeenCalledWith('legacy-sessions');
    expect(info).toHaveBeenCalledWith('Relocated legacy legacy-sessions: moved 2, skipped 1');
    expect(commit).toHaveBeenCalledWith({
      expectedVersion: 0,
      nextVersion: 1,
      set: {},
      delete: [],
    });
  });

  test('does not touch storage after the relocation version is committed', async () => {
    const claim = mock(async () => ({ moved: 0, skipped: 0 }));
    const { host } = createHost(claim);
    const { commit, store } = createStore(1);

    await relocateLegacySessionDirectory(host, store, 'legacy-sessions');

    expect(claim).not.toHaveBeenCalled();
    expect(commit).not.toHaveBeenCalled();
  });

  test('does not commit when claiming legacy storage fails', async () => {
    const claim = mock(async () => {
      throw new Error('claim failed');
    });
    const { host } = createHost(claim);
    const { commit, store } = createStore();

    await expect(
      relocateLegacySessionDirectory(host, store, 'legacy-sessions'),
    ).rejects.toThrow('claim failed');
    expect(commit).not.toHaveBeenCalled();
  });
});
