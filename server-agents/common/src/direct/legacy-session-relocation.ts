import type { AgentHost, AgentMigrationStore } from '@garcon/server-agent-interface';

const RELOCATION_VERSION = 1;

export async function relocateLegacySessionDirectory(
  host: AgentHost,
  store: AgentMigrationStore,
  label: string,
): Promise<void> {
  const version = await store.getVersion();
  if (version >= RELOCATION_VERSION) return;

  const claim = await host.storage.claimLegacyWorkspaceDirectory(label);
  if (claim.moved > 0 || claim.skipped > 0) {
    host.logger.info('Relocated Direct legacy transcript directory.', {
      storageNamespace: label,
      moved: claim.moved,
      skipped: claim.skipped,
    });
  }
  if (claim.skipped > 0) {
    throw new Error('Direct legacy transcript relocation was incomplete');
  }
  await store.commit({
    expectedVersion: version,
    nextVersion: RELOCATION_VERSION,
    set: {},
    delete: [],
  });
}
