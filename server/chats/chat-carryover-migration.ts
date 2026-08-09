import crypto from 'node:crypto';
import { createReadStream, promises as fs } from 'node:fs';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import type { ChatMessage } from '../../common/chat-types.js';
import { AgentSwitchMessage, UserMessage } from '../../common/chat-types.js';
import {
  createNativeSeedReceipt,
  renderTranscriptSeed,
} from '../../common/transcript-seed.js';
import { isRecord } from '../../common/json.js';
import { syncDirectory, writeJsonFileAtomic } from '../lib/json-file-store.js';
import type { AgentOwnershipJournalFileV3 } from './agent-ownership-journal.js';
import { assertMigrationCapacity } from './carryover-migration-budget.js';
import { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import { readChatRegistryVersion, readLegacyChatRegistryV3 } from './legacy-chat-registry-v3.js';
import {
  LegacyCarryOverDataError,
  type LegacyCarryOverSegment,
  activeLegacySegments,
  convertLinkedHistory,
  migrateLegacyOwnershipJournal,
  migratedTranscriptMatches,
  migrateV4Receipt,
  parseLegacyCarryOverFile,
} from './legacy-carryover-import.js';
import { parseCarryOverSegmentRefs, type CarryOverSegmentRef } from './store.js';

const EMPTY_FILE_SHA256 = crypto.createHash('sha256').digest('hex');
const MIGRATION_MARKER_VERSION = 2 as const;
const MIGRATION_MARKER_FILE = 'carryover-transcripts/migration-v2.json';
const LEGACY_CARRYOVER_FILE = 'chat-carryover.json';
const OWNERSHIP_JOURNAL_FILE = 'agent-ownership-journal.json';

interface CarryOverMigrationMarkerBase {
  readonly version: typeof MIGRATION_MARKER_VERSION;
  readonly sourceCarryOverSha256: string;
  readonly sourceRegistrySha256: string;
  readonly sourceJournalSha256: string;
  readonly legacyJournalBackupFile: string;
  readonly sourceRegistryVersion: 3 | 4;
  readonly sourceWorkspaceVersion: number | null;
  readonly startedAt: string;
}

interface CarryOverMigrationCommittedFields {
  readonly targetRegistrySha256: string;
  readonly segmentSummarySha256: string;
  readonly segmentCount: number;
  readonly completedAt: string;
  readonly rollbackSafe: boolean;
}

type CarryOverMigrationMarker =
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

export async function migrateLegacyCarryOverWorkspace(workspaceDir: string): Promise<boolean> {
  let marker = await readMarker(workspaceDir);
  let rollbackResumed = false;
  const initialRegistryVersion = await readChatRegistryVersion(workspaceDir);
  // A `rolling-back` marker marks an interrupted rollback; a `complete` marker
  // beside a legacy registry is the same crash one step later, from a rollback
  // that never wrote its resume marker. Both are finished here, after which the
  // workspace is legacy again below and migrates forward on this same boot.
  if (
    marker
    && (marker.phase === 'rolling-back'
      || (marker.phase === 'complete'
        && marker.rollbackSafe
        && (initialRegistryVersion === 3 || initialRegistryVersion === 4)))
  ) {
    await restoreLegacyCarryOverState(workspaceDir, marker);
    rollbackResumed = true;
    marker = null;
  }
  const registryVersion = await readChatRegistryVersion(workspaceDir);
  if (registryVersion === null) return rollbackResumed;
  const workspaceVersion = await readWorkspaceVersion(workspaceDir);
  if (registryVersion === 5) {
    if (workspaceVersion !== null && workspaceVersion >= 5) return rollbackResumed;
    if (!marker || marker.phase === 'in-progress') {
      throw new Error('Schema-v5 chat registry has no committed carryover migration marker');
    }
    await resumeCommittedMigration(workspaceDir, marker);
    return rollbackResumed;
  }
  if (registryVersion !== 3 && registryVersion !== 4) {
    throw new Error(`Unsupported chat registry version: ${registryVersion}`);
  }
  if (marker?.phase === 'complete') {
    throw new Error('Completed carryover migration marker cannot accompany a legacy registry');
  }
  await assertWorkspaceVersionAllowsMigration(workspaceDir);
  await ensureMigrationDirectories(workspaceDir);

  const registryPath = path.join(workspaceDir, 'chats.json');
  const carryOverPath = path.join(workspaceDir, LEGACY_CARRYOVER_FILE);
  const journalPath = path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE);
  const sourceBytes = await optionalFileSize(carryOverPath)
    + (registryVersion === 4
      ? await directorySize(path.join(workspaceDir, 'carryover-transcripts', 'nodes'))
      : 0);
  await assertMigrationCapacity(workspaceDir, sourceBytes);
  const [registryBytes, sourceCarryOverSha256, journalBytes] = await Promise.all([
    fs.readFile(registryPath),
    digestFile(carryOverPath),
    readOptionalFile(journalPath),
  ]);
  const sourceDigests = {
    sourceCarryOverSha256,
    sourceRegistrySha256: digest(registryBytes),
    sourceJournalSha256: digest(journalBytes),
  };
  const existingMarker = marker;
  if (existingMarker) assertMarkerSources(existingMarker, sourceDigests);
  const startedAt = existingMarker?.startedAt ?? new Date().toISOString();
  const legacyJournalBackupFile = existingMarker?.legacyJournalBackupFile
    ?? `migration-backups/agent-ownership-journal.v1.${sourceDigests.sourceJournalSha256.slice(0, 16)}.json`;
  const markerBase: CarryOverMigrationMarkerBase = {
    version: MIGRATION_MARKER_VERSION,
    ...sourceDigests,
    legacyJournalBackupFile,
    sourceRegistryVersion: registryVersion,
    sourceWorkspaceVersion: workspaceVersion,
    startedAt,
  };
  await writeMarker(workspaceDir, { ...markerBase, phase: 'in-progress' });
  await writeMigrationBackup(workspaceDir, legacyJournalBackupFile, journalBytes);
  await writeMigrationBackup(
    workspaceDir,
    registryBackupFile(markerBase),
    registryBytes,
  );

  const segmentsStore = new CarryOverTranscriptStore({ workspaceDir });
  await segmentsStore.initialize();
  const sessions: Record<string, Record<string, unknown>> = {};
  const migratedSegmentIds = new Set<string>();
  if (registryVersion === 3) {
    const legacyRegistry = await readLegacyChatRegistryV3(workspaceDir);
    if (!legacyRegistry) return rollbackResumed;
    // Parses in a temporary scope so the source bytes are collectable once the
    // chat map exists, and drops each chat's raw messages as it is converted.
    const rawCarryOver = parseLegacyCarryOverFile(await readOptionalFile(carryOverPath));
    for (const [chatId, entry] of Object.entries(legacyRegistry.sessions)) {
      const rawCarryOverEntry = rawCarryOver.get(chatId);
      rawCarryOver.delete(chatId);
      try {
        const converted = await convertLegacySegments({
          chatId,
          entry,
          segments: activeLegacySegments(rawCarryOverEntry, entry),
          sourceDigest: sourceDigests.sourceCarryOverSha256,
          startedAt,
          store: segmentsStore,
        });
        for (const id of converted.segmentIds) migratedSegmentIds.add(id);
        sessions[chatId] = {
          ...entry,
          carryOverSegments: converted.refs,
          nativeSeedReceipt: converted.nativeSeedReceipt,
          carryOverMigrationQuarantine: null,
        };
      } catch (error) {
        if (!isQuarantinableMigrationError(error)) throw error;
        const quarantine = await quarantineCarryOverEntry({
          workspaceDir,
          chatId,
          sourceArtifact: rawCarryOverEntry ?? null,
          sourceDigest: sourceDigests.sourceCarryOverSha256,
          error,
        });
        sessions[chatId] = {
          ...entry,
          carryOverSegments: [],
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: quarantine,
        };
      }
    }
  } else {
    const sourceRegistry = parseSourceRegistryV4(registryBytes);
    for (const [chatId, entry] of Object.entries(sourceRegistry.sessions)) {
      try {
        const converted = await convertLinkedHistory({
          workspaceDir,
          chatId,
          entry,
          headId: nullableString(entry.carryOverHeadId),
          store: segmentsStore,
        });
        for (const id of converted.segmentIds) migratedSegmentIds.add(id);
        sessions[chatId] = {
          ...entry,
          carryOverSegments: converted.refs,
          nativeSeedReceipt: migrateV4Receipt(entry.nativeSeedReceipt, entry.carryOverHeadId),
        };
      } catch (error) {
        if (!isQuarantinableMigrationError(error)) throw error;
        const quarantine = await quarantineCarryOverEntry({
          workspaceDir,
          chatId,
          sourceArtifact: {
            registryEntry: entry,
            linkedHeadId: nullableString(entry.carryOverHeadId),
          },
          sourceDigest: sourceDigests.sourceRegistrySha256,
          error,
        });
        sessions[chatId] = {
          ...entry,
          carryOverSegments: [],
          nativeSeedReceipt: null,
          carryOverMigrationQuarantine: quarantine,
        };
      }
      delete sessions[chatId].carryOverHeadId;
    }
  }

  const targetRegistry = { version: 5, sessions };
  const segmentCount = migratedSegmentIds.size;
  const targetRegistryBytes = serializeJson(targetRegistry);
  const targetRegistrySha256 = digest(targetRegistryBytes);
  const segmentSummarySha256 = segmentSummary(sessions);
  const ready: CarryOverMigrationMarker = {
    ...markerBase,
    phase: 'ready-to-commit',
    targetRegistrySha256,
    segmentSummarySha256,
    segmentCount,
  };
  await writeMarker(workspaceDir, ready);

  const targetJournal = await migrateLegacyOwnershipJournal({
    workspaceDir,
    bytes: journalBytes,
    sessions,
    sourceRegistryVersion: registryVersion,
    store: segmentsStore,
  });
  await writeJsonFileAtomic(registryPath, targetRegistry, { mode: 0o600 });
  await writeJsonFileAtomic(journalPath, targetJournal, { mode: 0o600 });
  const committedRegistryBytes = await fs.readFile(registryPath);
  if (digest(committedRegistryBytes) !== targetRegistrySha256) {
    throw new Error('Carryover migration registry digest mismatch after commit');
  }
  await writeMarker(workspaceDir, {
    ...ready,
    phase: 'complete',
    completedAt: new Date().toISOString(),
    rollbackSafe: true,
  });
  await archiveLegacyCarryOver(carryOverPath, startedAt);
  return rollbackResumed;
}

export async function markCarryOverMigrationRollbackUnsafe(workspaceDir: string): Promise<void> {
  const marker = await readMarker(workspaceDir);
  if (!marker) return;
  if (marker.phase !== 'complete') {
    throw new Error('Cannot accept new carryover segments while migration is incomplete');
  }
  if (!marker.rollbackSafe) return;
  await writeMarker(workspaceDir, { ...marker, rollbackSafe: false });
}

export async function finalizeCarryOverMigrationValidation(workspaceDir: string): Promise<void> {
  const marker = await readMarker(workspaceDir);
  if (!marker || marker.phase !== 'complete') return;
  if (marker.rollbackSafe) await writeMarker(workspaceDir, { ...marker, rollbackSafe: false });
  const retainLinkedSources = marker.sourceRegistryVersion === 4
    && await targetRegistryHasQuarantine(workspaceDir);
  await Promise.all([
    fs.rm(migratedCarryOverPath(workspaceDir, marker.startedAt), { force: true }),
    fs.rm(path.join(workspaceDir, registryBackupFile(marker)), { force: true }),
    fs.rm(path.join(
      workspaceDir,
      safeMigrationRelativePath(marker.legacyJournalBackupFile),
    ), { force: true }),
    ...(marker.sourceRegistryVersion === 4 && !retainLinkedSources
      ? [fs.rm(path.join(workspaceDir, 'carryover-transcripts', 'nodes'), {
          recursive: true,
          force: true,
        })]
      : []),
  ]);
  await Promise.all([
    syncDirectory(workspaceDir),
    syncDirectory(path.join(workspaceDir, 'migration-backups')),
  ]);
}

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
    throw new Error('Carryover migration rollback is unsafe after new-format history was created');
  }
  return restoreLegacyCarryOverState(workspaceDir, marker);
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
  const registryBackupPath = path.join(workspaceDir, registryBackupFile(marker));
  const registryBackup = await fs.readFile(registryBackupPath);
  if (digest(registryBackup) !== marker.sourceRegistrySha256) {
    throw new Error('Legacy chat-registry backup does not match its migration marker');
  }
  const journalBackup = await readOptionalFile(path.join(
    workspaceDir,
    safeMigrationRelativePath(marker.legacyJournalBackupFile),
  ));
  if (digest(journalBackup) !== marker.sourceJournalSha256) {
    throw new Error('Legacy ownership-journal backup does not match its migration marker');
  }
  const legacyCarryOver = await readRollbackCarryOverSource(workspaceDir, marker);

  const registryPath = path.join(workspaceDir, 'chats.json');
  const currentRegistry = await fs.readFile(registryPath);
  const currentRegistryDigest = digest(currentRegistry);
  if (
    currentRegistryDigest !== marker.targetRegistrySha256
    && currentRegistryDigest !== marker.sourceRegistrySha256
  ) {
    throw new Error('Current chat registry does not match the migration or its backup');
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

async function resumeCommittedMigration(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'ready-to-commit' | 'complete' }>,
): Promise<void> {
  await ensureMigrationDirectories(workspaceDir);
  const registryPath = path.join(workspaceDir, 'chats.json');
  const registryBytes = await fs.readFile(registryPath);
  if (digest(registryBytes) !== marker.targetRegistrySha256) {
    throw new Error('Carryover migration registry digest does not match its marker');
  }
  const targetRegistry = parseTargetRegistry(registryBytes);
  await validateMigratedRoots(workspaceDir, targetRegistry.sessions, marker);

  const legacyDigest = await digestFile(path.join(workspaceDir, LEGACY_CARRYOVER_FILE));
  if (legacyDigest !== EMPTY_FILE_SHA256 && legacyDigest !== marker.sourceCarryOverSha256) {
    throw new Error('Legacy carryover source changed after registry commit');
  }

  const journalPath = path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE);
  if (marker.phase === 'ready-to-commit') {
    const relativeBackup = safeMigrationRelativePath(marker.legacyJournalBackupFile);
    const journalBackup = await readOptionalFile(path.join(workspaceDir, relativeBackup));
    if (digest(journalBackup) !== marker.sourceJournalSha256) {
      throw new Error('Legacy ownership-journal backup does not match its migration marker');
    }
    const store = new CarryOverTranscriptStore({ workspaceDir });
    await store.initialize();
    const targetJournal = await migrateLegacyOwnershipJournal({
      workspaceDir,
      bytes: journalBackup,
      sessions: targetRegistry.sessions,
      sourceRegistryVersion: marker.sourceRegistryVersion,
      store,
    });
    await writeJsonFileAtomic(journalPath, targetJournal, { mode: 0o600 });
    await writeMarker(workspaceDir, {
      ...marker,
      phase: 'complete',
      completedAt: new Date().toISOString(),
      rollbackSafe: true,
    });
  } else {
    parseTargetJournal(await readOptionalFile(journalPath));
  }
  await archiveLegacyCarryOver(
    path.join(workspaceDir, LEGACY_CARRYOVER_FILE),
    marker.startedAt,
  );
}

async function convertLegacySegments(input: {
  readonly chatId: string;
  readonly entry: Readonly<Record<string, unknown>>;
  readonly segments: readonly LegacyCarryOverSegment[];
  readonly sourceDigest: string;
  readonly startedAt: string;
  readonly store: CarryOverTranscriptStore;
}): Promise<{
  refs: readonly CarryOverSegmentRef[];
  nativeSeedReceipt: unknown;
  segmentIds: readonly string[];
}> {
  const current = {
    agentId: legacyRequiredString(input.entry.agentId, 'chat agent'),
    model: legacyStringValue(input.entry.model, 'chat model'),
  };
  const refs: CarryOverSegmentRef[] = [];
  const segmentIds: string[] = [];
  const rendered: ChatMessage[] = [];
  const legacyRendered: ChatMessage[] = [];
  for (const [index, segment] of input.segments.entries()) {
    let messages = [...segment.messages];
    let seedSanitation: 'not-applicable' | 'stripped-exact' | 'absent' = 'not-applicable';
    if (index > 0 && legacyRendered.length > 0) {
      const expectedPrefix = `${renderTranscriptSeed(legacyRendered)}\n\n`;
      const sanitized = stripExactLegacyPrefix(messages, expectedPrefix);
      messages = sanitized.messages;
      seedSanitation = sanitized.stripped ? 'stripped-exact' : 'absent';
    }
    const next = input.segments[index + 1];
    const target = segment.boundaryTarget ?? next ?? current;
    if (messages.length > 0 || segment.boundary) {
      const segmentId = deterministicUuid([
        input.sourceDigest,
        String(index),
        JSON.stringify(messages),
        segment.agentId,
        segment.model,
        segment.at,
        seedSanitation,
        String(segment.boundary),
        target.agentId,
        target.model,
      ].join(':'));
      if (messages.length > 0) {
        const prepared = await input.store.prepareSegment({
          operationId: `migration:${input.sourceDigest}:${input.chatId}:${index}`,
          id: segmentId,
          seedSanitation,
          messages,
        });
        await prepared.commit();
        prepared.releaseRoot();
        await input.store.verifySegment({
          id: segmentId,
          agentId: segment.agentId,
          model: segment.model,
          capturedAt: segment.at || input.startedAt,
          storedMessageCount: messages.length,
          visibleMessageCount: messages.length,
          trailingHandoff: null,
        });
        segmentIds.push(segmentId);
      }
      refs.push({
        id: segmentId,
        agentId: segment.agentId,
        model: segment.model,
        capturedAt: segment.at || input.startedAt,
        storedMessageCount: messages.length,
        visibleMessageCount: messages.length,
        trailingHandoff: segment.boundary
          ? { agentId: target.agentId, model: target.model }
          : null,
      });
      rendered.push(...messages);
      if (segment.boundary) {
        const boundary = new AgentSwitchMessage(
          segment.at,
          segment.agentId,
          target.agentId,
          segment.model,
          target.model,
        );
        rendered.push(boundary);
      }
    }
    legacyRendered.push(...segment.messages);
    if (segment.boundary) {
      legacyRendered.push(new AgentSwitchMessage(
        segment.at,
        segment.agentId,
        target.agentId,
        segment.model,
        target.model,
      ));
    }
  }

  await input.store.assertAvailable(refs);
  if (!await migratedTranscriptMatches(input.store, refs, rendered)) {
    throw new Error(`Migrated carryover transcript differs for chat ${input.chatId}`);
  }
  if (rendered.length > 0 && refs.length === 0) {
    throw new Error(`Migrated carryover transcript has no segment references for chat ${input.chatId}`);
  }
  const agentSessionId = nullableString(input.entry.agentSessionId);
  const nativeSeedReceipt = refs.length > 0 && agentSessionId
    ? createNativeSeedReceipt({
        agentSessionId,
        placement: 'user-prefix',
        format: 'legacy-v0',
        prefix: `${renderTranscriptSeed(legacyRendered)}\n\n`,
      })
    : null;
  return { refs, nativeSeedReceipt, segmentIds };
}

async function quarantineCarryOverEntry(input: {
  readonly workspaceDir: string;
  readonly chatId: string;
  readonly sourceArtifact: unknown;
  readonly sourceDigest: string;
  readonly error: unknown;
}): Promise<{ readonly artifactId: string; readonly errorCode: string }> {
  const artifactId = deterministicUuid(`quarantine:${input.sourceDigest}:${input.chatId}`);
  await writeJsonFileAtomic(
    path.join(input.workspaceDir, 'carryover-transcripts', 'quarantine', `${artifactId}.json`),
    { version: 1, chatId: input.chatId, entry: input.sourceArtifact },
    { mode: 0o600 },
  );
  return { artifactId, errorCode: migrationErrorCode(input.error) };
}

function stripExactLegacyPrefix(
  messages: readonly ChatMessage[],
  prefix: string,
): { messages: ChatMessage[]; stripped: boolean } {
  const index = messages.findIndex((message) => message.type === 'user-message');
  if (index === -1) return { messages: [...messages], stripped: false };
  const original = messages[index] as UserMessage;
  if (!original.content.startsWith(prefix)) return { messages: [...messages], stripped: false };
  const next = [...messages];
  next[index] = new UserMessage(
    original.timestamp,
    original.content.slice(prefix.length),
    original.images,
    original.metadata,
  );
  return { messages: next, stripped: true };
}

async function digestFile(filePath: string): Promise<string> {
  const hash = crypto.createHash('sha256');
  try {
    await pipeline(createReadStream(filePath), hash);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
  return hash.digest('hex');
}

async function directorySize(directory: string): Promise<number> {
  let entries;
  try {
    entries = await fs.readdir(directory, { withFileTypes: true });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
  let total = 0;
  for (const entry of entries) {
    const entryPath = path.join(directory, entry.name);
    if (entry.isDirectory()) total += await directorySize(entryPath);
    else if (entry.isFile()) total += (await fs.stat(entryPath)).size;
  }
  return total;
}

async function targetRegistryHasQuarantine(workspaceDir: string): Promise<boolean> {
  const registry = parseTargetRegistry(await fs.readFile(path.join(workspaceDir, 'chats.json')));
  return Object.values(registry.sessions).some((entry) => (
    entry.carryOverMigrationQuarantine !== null
    && entry.carryOverMigrationQuarantine !== undefined
  ));
}

async function assertWorkspaceVersionAllowsMigration(workspaceDir: string): Promise<void> {
  const version = await readWorkspaceVersion(workspaceDir);
  if (version !== null && version >= 5) {
    throw new Error('Workspace version 5 cannot contain a legacy chat registry');
  }
}

async function readWorkspaceVersion(workspaceDir: string): Promise<number | null> {
  try {
    const value: unknown = JSON.parse(
      await fs.readFile(path.join(workspaceDir, 'workspace-version.json'), 'utf8'),
    );
    if (!isRecord(value) || !Number.isSafeInteger(value.version) || Number(value.version) < 0) {
      throw new Error('Invalid workspace version file');
    }
    return Number(value.version);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}

async function ensureMigrationDirectories(workspaceDir: string): Promise<void> {
  const root = path.join(workspaceDir, 'carryover-transcripts');
  await fs.mkdir(root, { recursive: true, mode: 0o700 });
  await fs.chmod(root, 0o700);
  await Promise.all([
    fs.mkdir(path.join(root, 'quarantine'), { recursive: true, mode: 0o700 }),
    fs.mkdir(path.join(workspaceDir, 'migration-backups'), { recursive: true, mode: 0o700 }),
  ]);
}

async function archiveLegacyCarryOver(filePath: string, startedAt: string): Promise<void> {
  try {
    await fs.rename(filePath, migratedCarryOverPath(path.dirname(filePath), startedAt));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
  }
}

function migratedCarryOverPath(workspaceDir: string, startedAt: string): string {
  const suffix = startedAt.replaceAll(':', '').replaceAll('.', '');
  return path.join(workspaceDir, `chat-carryover.v5.migrated.${suffix}.json`);
}

function registryBackupFile(marker: CarryOverMigrationMarkerBase): string {
  return `migration-backups/chats.v${marker.sourceRegistryVersion}.${marker.sourceRegistrySha256.slice(0, 16)}.json`;
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

async function writeBytesAtomic(filePath: string, bytes: Buffer, mode: number): Promise<void> {
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

async function writeMigrationBackup(workspaceDir: string, relativePath: string, bytes: Buffer): Promise<void> {
  if (bytes.byteLength === 0) return;
  const target = path.join(workspaceDir, relativePath);
  try {
    await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== 'EEXIST') {
      await fs.mkdir(path.dirname(target), { recursive: true, mode: 0o700 });
      await fs.writeFile(target, bytes, { flag: 'wx', mode: 0o600 }).catch((retryError) => {
        if ((retryError as NodeJS.ErrnoException).code !== 'EEXIST') throw retryError;
      });
    }
  }
  const existing = await fs.readFile(target);
  if (digest(existing) !== digest(bytes)) throw new Error(`Migration backup differs: ${relativePath}`);
}

async function readMarker(workspaceDir: string): Promise<CarryOverMigrationMarker | null> {
  try {
    const value: unknown = JSON.parse(await fs.readFile(path.join(workspaceDir, MIGRATION_MARKER_FILE), 'utf8'));
    return parseMigrationMarker(value);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
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

function assertMarkerSources(
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

function writeMarker(workspaceDir: string, marker: CarryOverMigrationMarker): Promise<void> {
  return writeJsonFileAtomic(path.join(workspaceDir, MIGRATION_MARKER_FILE), marker, { mode: 0o600 });
}

async function readOptionalFile(filePath: string): Promise<Buffer> {
  try {
    return await fs.readFile(filePath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return Buffer.alloc(0);
    throw error;
  }
}

async function optionalFileSize(filePath: string): Promise<number> {
  try {
    return (await fs.stat(filePath)).size;
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return 0;
    throw error;
  }
}

function serializeJson(value: unknown): Buffer {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function parseSourceRegistryV4(bytes: Buffer): {
  readonly version: 4;
  readonly sessions: Record<string, Readonly<Record<string, unknown>>>;
} {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || value.version !== 4 || !isRecord(value.sessions)) {
    throw new Error('Invalid version-four chat registry');
  }
  const sessions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [chatId, entry] of Object.entries(value.sessions)) {
    if (!isRecord(entry)) throw new Error(`Invalid version-four chat registry entry for ${chatId}`);
    sessions[chatId] = entry;
  }
  return { version: 4, sessions };
}

function segmentSummary(
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): string {
  const selected = Object.entries(sessions).map(([chatId, entry]) => [
    chatId,
    entry.carryOverSegments ?? [],
  ] as const).sort(([left], [right]) => left.localeCompare(right));
  return digest(Buffer.from(JSON.stringify(selected)));
}

function parseTargetRegistry(bytes: Buffer): {
  readonly version: 5;
  readonly sessions: Record<string, Readonly<Record<string, unknown>>>;
} {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || value.version !== 5 || !isRecord(value.sessions)) {
    throw new Error('Invalid migrated chat registry');
  }
  const sessions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [chatId, entry] of Object.entries(value.sessions)) {
    if (!isRecord(entry)) throw new Error(`Invalid migrated chat registry entry for ${chatId}`);
    sessions[chatId] = entry;
  }
  return { version: 5, sessions };
}

function parseTargetJournal(bytes: Buffer): AgentOwnershipJournalFileV3 {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(value)
    || value.version !== 3
    || !Array.isArray(value.ownershipIntents)
    || !Array.isArray(value.transferCleanup)
  ) {
    throw new Error('Invalid migrated ownership journal');
  }
  return value as unknown as AgentOwnershipJournalFileV3;
}

async function validateMigratedRoots(
  workspaceDir: string,
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  marker: { readonly segmentCount: number; readonly segmentSummarySha256: string },
): Promise<void> {
  const store = new CarryOverTranscriptStore({ workspaceDir });
  await store.initialize();
  const ids = new Set<string>();
  for (const [chatId, entry] of Object.entries(sessions)) {
    if (!Array.isArray(entry.carryOverSegments)) {
      throw new Error(`Invalid carryover segments for ${chatId}`);
    }
    const refs = parseCarryOverSegmentRefs(entry.carryOverSegments);
    await store.assertAvailable(refs);
    // Decodes every page to prove the committed segments are readable, discarding
    // each batch so a large chat cannot dominate startup memory.
    for await (const _batch of store.stream({ refs, maxMessagesPerBatch: 256 })) void _batch;
    for (const ref of refs) if (ref.storedMessageCount > 0) ids.add(ref.id);
  }
  const summary = segmentSummary(sessions);
  if (summary !== marker.segmentSummarySha256 || ids.size !== marker.segmentCount) {
    throw new Error('Migrated carryover segment summary does not match its marker');
  }
}

function safeMigrationRelativePath(value: string): string {
  if (path.isAbsolute(value) || value.includes('\\')) {
    throw new Error('Invalid migration artifact path');
  }
  const normalized = path.normalize(value);
  if (normalized === '..' || normalized.startsWith(`..${path.sep}`)) {
    throw new Error('Invalid migration artifact path');
  }
  return normalized;
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

function isQuarantinableMigrationError(error: unknown): boolean {
  return error instanceof LegacyCarryOverDataError;
}

function legacyRequiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new LegacyCarryOverDataError(`Invalid ${field}`);
  return value;
}

function legacyStringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new LegacyCarryOverDataError(`Invalid ${field}`);
  return value;
}

function deterministicUuid(value: string): string {
  const bytes = crypto.createHash('sha256').update(value).digest().subarray(0, 16);
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

function digest(bytes: Buffer): string {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function migrationErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_CARRYOVER_ENTRY';
}

function requiredString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !value) throw new Error(`Invalid ${field}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
