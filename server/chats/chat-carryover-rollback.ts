// Rollback of the legacy carryover migration. Split from
// chat-carryover-migration.ts so both stay under the architecture-budget
// ceiling; the marker format and artifact paths live in
// carryover-migration-files.ts.
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../common/json.js';
import { syncDirectory, writeJsonFileAtomic } from '../lib/json-file-store.js';
import {
  LEGACY_CARRYOVER_FILE,
  MIGRATION_MARKER_FILE,
  OWNERSHIP_JOURNAL_FILE,
  carryOverSegmentSummary,
  digest,
  migratedCarryOverPath,
  readMarker,
  readOptionalFile,
  registryBackupFile,
  safeMigrationBackupPath,
  writeBytesAtomic,
  writeMarker,
  type CarryOverMigrationMarker,
} from './carryover-migration-files.js';
import { readChatRegistryVersion } from './legacy-chat-registry-v3.js';
import { CHAT_REGISTRY_VERSION } from './store.js';

export async function rollbackLegacyCarryOverMigration(
  workspaceDir: string,
): Promise<'restored' | 'already-restored'> {
  const marker = await readMarker(workspaceDir);
  const registryVersion = await readChatRegistryVersion(workspaceDir);
  if ((registryVersion === 3 || registryVersion === 4) && !marker) return 'already-restored';
  if (!marker || (marker.phase !== 'complete' && marker.phase !== 'rolling-back')) {
    throw new Error('No completed carryover migration is available to roll back');
  }
  if (marker.phase === 'complete' && !marker.rollbackSafe) {
    throw new Error('Carryover migration rollback is unsafe after the migration validation restart');
  }
  return restoreLegacyCarryOverState(workspaceDir, marker);
}

// Rollback recovery answers to the migration marker, not the workspace
// version: a crash mid-rollback can leave any mix of restored and migrated
// files at either workspace version, so this runs outside the version-gated
// migration ladder. A `rolling-back` marker marks an interrupted rollback; a
// `complete` marker beside a legacy registry is the same crash one step
// later, from a rollback that never wrote its resume marker. Returns true
// when a rollback was finished.
export async function resumeInterruptedCarryOverRollback(
  workspaceDir: string,
): Promise<boolean> {
  const marker = await readMarker(workspaceDir);
  if (!marker) return false;
  const registryVersion = await readChatRegistryVersion(workspaceDir);
  if (
    marker.phase !== 'rolling-back'
    && !(marker.phase === 'complete'
      && marker.rollbackSafe
      && (registryVersion === 3 || registryVersion === 4))
  ) {
    return false;
  }
  await restoreLegacyCarryOverState(workspaceDir, marker);
  return true;
}

// Restores the legacy registry, journal, carryover source, and workspace
// version from the validated backups. The `rolling-back` phase is written
// before the first restore, so a crash anywhere in the sequence leaves a
// marker startup recognises, and every step is idempotent, so re-entering
// from either this command or the next boot converges instead of rejecting a
// half-restored workspace.
async function restoreLegacyCarryOverState(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' | 'rolling-back' }>,
): Promise<'restored' | 'already-restored'> {
  const registryBackupPath = safeMigrationBackupPath(workspaceDir, registryBackupFile(marker));
  const registryBackup = await fs.readFile(registryBackupPath);
  if (digest(registryBackup) !== marker.sourceRegistrySha256) {
    throw new Error('Legacy chat-registry backup does not match its migration marker');
  }
  const journalBackup = await readOptionalFile(safeMigrationBackupPath(
    workspaceDir,
    marker.legacyJournalBackupFile,
  ));
  if (digest(journalBackup) !== marker.sourceJournalSha256) {
    throw new Error('Legacy ownership-journal backup does not match its migration marker');
  }
  const legacyCarryOver = await readRollbackCarryOverSource(workspaceDir, marker);

  const registryPath = path.join(workspaceDir, 'chats.json');
  const currentRegistry = await fs.readFile(registryPath);
  const currentRegistryDigest = digest(currentRegistry);
  if (currentRegistryDigest !== marker.sourceRegistrySha256) {
    const sessions = parseMigratedRegistrySessions(currentRegistry);
    if (
      marker.phase === 'complete'
      && currentRegistryDigest !== marker.targetRegistrySha256
      && carryOverSegmentSummary(sessions) !== marker.segmentSummarySha256
    ) {
      throw new Error('Carryover migration rollback is unsafe after the registry changed');
    }
  }

  await writeMarker(workspaceDir, { ...marker, phase: 'rolling-back' });
  await restoreOptionalFile(
    path.join(workspaceDir, LEGACY_CARRYOVER_FILE),
    legacyCarryOver,
  );
  await restoreOptionalFile(
    path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE),
    journalBackup,
  );
  await writeJsonFileAtomic(path.join(workspaceDir, 'workspace-version.json'), {
    version: marker.sourceWorkspaceVersion ?? marker.sourceRegistryVersion,
  }, {
    mode: 0o600,
  });
  await writeBytesAtomic(registryPath, registryBackup, 0o600);
  await removeMigratedCarryOverArchive(workspaceDir, marker);
  await archiveRollbackMarker(workspaceDir, marker);
  return currentRegistryDigest === marker.sourceRegistrySha256 ? 'already-restored' : 'restored';
}

function parseMigratedRegistrySessions(
  bytes: Buffer,
): Record<string, Readonly<Record<string, unknown>>> {
  let value: unknown;
  try {
    value = JSON.parse(bytes.toString('utf8'));
  } catch {
    throw new Error('Current chat registry does not match the migration or its backup');
  }
  if (!isRecord(value) || value.version !== CHAT_REGISTRY_VERSION || !isRecord(value.sessions)) {
    throw new Error('Current chat registry does not match the migration or its backup');
  }
  const sessions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [chatId, entry] of Object.entries(value.sessions)) {
    if (!isRecord(entry)) {
      throw new Error('Current chat registry does not match the migration or its backup');
    }
    sessions[chatId] = entry;
  }
  return sessions;
}

async function readRollbackCarryOverSource(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' | 'rolling-back' }>,
): Promise<Buffer> {
  const candidates = [
    path.join(workspaceDir, LEGACY_CARRYOVER_FILE),
    migratedCarryOverPath(workspaceDir, marker.startedAt),
  ];
  for (const candidate of candidates) {
    const bytes = await readOptionalFile(candidate);
    if (digest(bytes) === marker.sourceCarryOverSha256) return bytes;
  }
  throw new Error('Legacy carryover artifact does not match its migration marker');
}

async function restoreOptionalFile(filePath: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength > 0) {
    await writeBytesAtomic(filePath, bytes, 0o600);
    return;
  }
  await fs.rm(filePath, { force: true });
  await syncDirectory(path.dirname(filePath));
}

async function removeMigratedCarryOverArchive(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' | 'rolling-back' }>,
): Promise<void> {
  await fs.rm(migratedCarryOverPath(workspaceDir, marker.startedAt), { force: true });
  await syncDirectory(workspaceDir);
}

async function archiveRollbackMarker(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' | 'rolling-back' }>,
): Promise<void> {
  const markerPath = path.join(workspaceDir, MIGRATION_MARKER_FILE);
  const suffix = marker.completedAt.replaceAll(':', '').replaceAll('.', '');
  await fs.rename(
    markerPath,
    path.join(path.dirname(markerPath), `migration-v2.rolled-back.${suffix}.json`),
  );
  await syncDirectory(path.dirname(markerPath));
}
