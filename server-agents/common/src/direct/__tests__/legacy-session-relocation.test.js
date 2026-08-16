import { describe, expect, it, mock } from 'bun:test';
import { relocateLegacySessionDirectory } from '../legacy-session-relocation.ts';

describe('Direct legacy session relocation', () => {
  it('[TLV5-ADOPT.11-DIRECT-RELOCATION-UNIT-01] fails closed on skipped entries and retries the recoverable source', async () => {
    let migrationVersion = 0;
    let destinationCollides = true;
    const sourceEntries = new Set(['released-session.jsonl']);
    const commits = [];
    const claimLegacyWorkspaceDirectory = mock(async () => {
      if (destinationCollides) {
        return { moved: 0, skipped: sourceEntries.size };
      }
      const moved = sourceEntries.size;
      sourceEntries.clear();
      return { moved, skipped: 0 };
    });
    const host = {
      logger: { debug() {}, info() {}, warn() {}, error() {} },
      storage: { claimLegacyWorkspaceDirectory },
    };
    const store = {
      getVersion: async () => migrationVersion,
      async commit(request) {
        expect(request.expectedVersion).toBe(migrationVersion);
        commits.push(request);
        migrationVersion = request.nextVersion;
      },
    };

    await expect(relocateLegacySessionDirectory(host, store, 'direct-sessions')).rejects.toThrow();
    expect(migrationVersion).toBe(0);
    expect(commits).toEqual([]);
    expect([...sourceEntries]).toEqual(['released-session.jsonl']);

    destinationCollides = false;
    await expect(relocateLegacySessionDirectory(host, store, 'direct-sessions')).resolves.toBeUndefined();
    expect(migrationVersion).toBe(1);
    expect(sourceEntries.size).toBe(0);
    expect(commits).toHaveLength(1);

    await relocateLegacySessionDirectory(host, store, 'direct-sessions');
    expect(claimLegacyWorkspaceDirectory).toHaveBeenCalledTimes(2);
    expect(commits).toHaveLength(1);
  });
});
