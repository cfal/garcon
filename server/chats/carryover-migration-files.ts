// Marker format, artifact paths, and small io shared by the forward carryover
// migration and its rollback. Extracted so chat-carryover-migration.ts stays
// under its architecture-budget ceiling.
import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import { isRecord } from '../../common/json.js';
import { syncDirectory, writeJsonFileAtomic } from '../lib/json-file-store.js';

export const MIGRATION_MARKER_VERSION = 2 as const;
export const MIGRATION_MARKER_FILE = 'carryover-transcripts/migration-v2.json';
export const MIGRATION_BACKUP_DIR = 'migration-backups';
export const LEGACY_CARRYOVER_FILE = 'chat-carryover.json';
export const OWNERSHIP_JOURNAL_FILE = 'agent-ownership-journal.json';

export interface CarryOverMigrationMarkerBase {
  readonly version: typeof MIGRATION_MARKER_VERSION;
  readonly sourceCarryOverSha256: string;
  readonly sourceRegistrySha256: string;
  readonly sourceJournalSha256: string;
  readonly legacyJournalBackupFile: string;
  readonly sourceRegistryVersion: 3 | 4;
  readonly sourceWorkspaceVersion: number | null;
  readonly startedAt: string;
}

export interface CarryOverMigrationCommittedFields {
  readonly targetRegistrySha256: string;
  readonly segmentSummarySha256: string;
  readonly segmentCount: number;
  readonly completedAt: string;
  readonly rollbackSafe: boolean;
}

export type CarryOverMigrationMarker =
  | (CarryOverMigrationMarkerBase & { readonly phase: 'in-progress' })
  | (CarryOverMigrationMarkerBase & {
      readonly phase: 'ready-to-commit';
      readonly targetRegistrySha256: string;
      readonly segmentSummarySha256: string;
      readonly segmentCount: number;
    })
  | (CarryOverMigrationMarkerBase & CarryOverMigrationCommittedFields & {
      readonly phase: 'complete';
    })
  | (CarryOverMigrationMarkerBase & CarryOverMigrationCommittedFields & {
      // Durable resume point for a rollback, written before the first restore
      // so a crash mid-rollback is recognised and finished instead of leaving a
      // mixed state that startup rejects.
      readonly phase: 'rolling-back';
    });

export async function readMarker(workspaceDir: string): Promise<CarryOverMigrationMarker | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(workspaceDir, MIGRATION_MARKER_FILE), 'utf8'));
    return parseMigrationMarker(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

export function writeMarker(workspaceDir: string, marker: CarryOverMigrationMarker): Promise<void> {
  return writeJsonFileAtomic(path.join(workspaceDir, MIGRATION_MARKER_FILE), marker, { mode: 0o600 });
}

export function assertMarkerSources(
  marker: CarryOverMigrationMarker,
  digests: Pick<CarryOverMigrationMarkerBase, 'sourceCarryOverSha256' | 'sourceRegistrySha256' | 'sourceJournalSha256'>,
): void {
  if (
    marker.sourceCarryOverSha256 !== digests.sourceCarryOverSha256
    || marker.sourceRegistrySha256 !== digests.sourceRegistrySha256
    || marker.sourceJournalSha256 !== digests.sourceJournalSha256
  ) {
    throw new Error('Carryover migration source changed after migration began');
  }
}

function parseMigrationMarker(value: unknown): CarryOverMigrationMarker {
  if (!isRecord(value) || value.version !== MIGRATION_MARKER_VERSION) {
    throw new Error('Invalid carryover migration marker');
  }
  const base: CarryOverMigrationMarkerBase = {
    version: MIGRATION_MARKER_VERSION,
    sourceCarryOverSha256: sha256Value(value.sourceCarryOverSha256, 'carryover source'),
    sourceRegistrySha256: sha256Value(value.sourceRegistrySha256, 'registry source'),
    sourceJournalSha256: sha256Value(value.sourceJournalSha256, 'journal source'),
    legacyJournalBackupFile: safeMigrationRelativePath(
      requiredString(value.legacyJournalBackupFile, 'legacy journal backup'),
    ),
    sourceRegistryVersion: value.sourceRegistryVersion === 3 || value.sourceRegistryVersion === 4
      ? value.sourceRegistryVersion
      : (() => { throw new Error('Invalid carryover migration source registry version'); })(),
    sourceWorkspaceVersion: value.sourceWorkspaceVersion === null
      ? null
      : nonNegativeInteger(value.sourceWorkspaceVersion, 'source workspace version'),
    startedAt: timestampValue(value.startedAt, 'migration start'),
  };
  if (value.phase === 'in-progress') return { ...base, phase: 'in-progress' };
  if (
    value.phase !== 'ready-to-commit'
    && value.phase !== 'complete'
    && value.phase !== 'rolling-back'
  ) {
    throw new Error('Invalid carryover migration marker phase');
  }
  const committed = {
    ...base,
    targetRegistrySha256: sha256Value(value.targetRegistrySha256, 'target registry'),
    segmentSummarySha256: sha256Value(value.segmentSummarySha256, 'segment summary'),
    segmentCount: nonNegativeInteger(value.segmentCount, 'migration segment count'),
  };
  if (value.phase === 'ready-to-commit') return { ...committed, phase: 'ready-to-commit' };
  if (value.rollbackSafe !== true && value.rollbackSafe !== false) {
    throw new Error('Invalid carryover migration rollback state');
  }
  const completedAt = timestampValue(value.completedAt, 'migration completion');
  const rollbackSafe = value.rollbackSafe;
  return value.phase === 'rolling-back'
    ? { ...committed, phase: 'rolling-back', completedAt, rollbackSafe }
    : { ...committed, phase: 'complete', completedAt, rollbackSafe };
}

export function safeMigrationRelativePath(value: string): string {
  if (path.isAbsolute(value) || value.includes('\\')) {
    throw new Error('Invalid migration artifact path');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Invalid migration artifact path');
  }
  return normalized;
}

export function safeMigrationBackupPath(workspaceDir: string, value: string): string {
  const relativePath = safeMigrationRelativePath(value);
  if (!relativePath.startsWith(`${MIGRATION_BACKUP_DIR}${path.sep}`)) {
    throw new Error(`Migration backup path must be within ${MIGRATION_BACKUP_DIR}`);
  }
  return path.join(workspaceDir, relativePath);
}

export function registryBackupFile(marker: CarryOverMigrationMarkerBase): string {
  return `${MIGRATION_BACKUP_DIR}/chats.v${marker.sourceRegistryVersion}.${marker.sourceRegistrySha256.slice(0, 16)}.json`;
}

export function carryOverSegmentSummary(
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
  const selected = Object.entries(sessions)
    .map(([chatId, entry]) => [chatId, entry.carryOverSegments ?? []] as const)
    .sort(([left], [right]) => left.localeCompare(right));
  return digest(Buffer.from(JSON.stringify(selected)));
}

export function migratedCarryOverPath(workspaceDir: string, startedAt: string): string {
  const suffix = startedAt.replaceAll(':', '').replaceAll('.', '');
  return path.join(workspaceDir, `chat-carryover.v5.migrated.${suffix}.json`);
}

export async function readOptionalFile(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

export async function writeBytesAtomic(filePath: string, bytes: Buffer, mode: number): Promise<void> {
  const directory = path.dirname(filePath);
  const temporaryPath = path.join(
    directory,
    `.${path.basename(filePath)}.${process.pid}.${crypto.randomUUID()}.tmp`,
  );
  let file: Awaited<ReturnType<typeof fs.open>> | null = null;
  await fs.mkdir(directory, { recursive: true, mode: 0o700 });
  try {
    file = await fs.open(temporaryPath, 'w', mode);
    await file.writeFile(bytes);
    await file.sync();
    await file.close();
    file = null;
    await fs.rename(temporaryPath, filePath);
    await syncDirectory(directory);
  } catch (error) {
    if (file) await file.close().catch(() => undefined);
    await fs.rm(temporaryPath, { force: true }).catch(() => undefined);
    throw error;
  }
}

export function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256Value(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[a-f0-9]{64}$/.test(value)) {
    throw new Error(`Invalid ${field} digest`);
  }
  return value;
}

function timestampValue(value: unknown, field: string): string {
  const timestamp = requiredString(value, field);
  if (!Number.isFinite(Date.parse(timestamp))) throw new Error(`Invalid ${field} timestamp`);
  return timestamp;
}

function nonNegativeInteger(value: unknown, field: string): number {
  if (!Number.isSafeInteger(value) || Number(value) < 0) throw new Error(`Invalid ${field}`);
  return Number(value);
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}`);
  return value;
}
