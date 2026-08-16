import { describe, expect, it, mock } from 'bun:test';
import { relocateLegacySessionDirectory } from '../legacy-session-relocation.ts';

describe('Direct legacy session relocation', () => {
  it('[TLV5-ADOPT.11-DIRECT-RELOCATION-UNIT-01] fails closed on skipped entries and retries the recoverable source', async () => {
    let migrationVersion = 0;
    let destinationCollides = true;
    const sourceEntries = new Set(['moved-session.jsonl', 'skipped-session.jsonl']);
    const destinationEntries = new Set();
    const commits = [];
    const claimLegacyWorkspaceDirectory = mock(async () => {
      if (destinationCollides) {
        sourceEntries.delete('moved-session.jsonl');
        destinationEntries.add('moved-session.jsonl');
        return { moved: 1, skipped: 1 };
      }
      const moved = sourceEntries.size;
      for (const entry of sourceEntries) destinationEntries.add(entry);
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
    expect([...sourceEntries]).toEqual(['skipped-session.jsonl']);
    expect([...destinationEntries]).toEqual(['moved-session.jsonl']);

    destinationCollides = false;
    await expect(relocateLegacySessionDirectory(host, store, 'direct-sessions')).resolves.toBeUndefined();
    expect(migrationVersion).toBe(1);
    expect(sourceEntries.size).toBe(0);
    expect([...destinationEntries]).toEqual(['moved-session.jsonl', 'skipped-session.jsonl']);
    expect(commits).toHaveLength(1);

    await relocateLegacySessionDirectory(host, store, 'direct-sessions');
    expect(claimLegacyWorkspaceDirectory).toHaveBeenCalledTimes(2);
    expect(commits).toHaveLength(1);
  });
});
