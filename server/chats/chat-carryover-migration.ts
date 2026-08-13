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
import type { AgentOwnershipJournalFileV5 } from './agent-ownership-journal.js';
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
import {
  LEGACY_CARRYOVER_FILE,
  MIGRATION_MARKER_VERSION,
  OWNERSHIP_JOURNAL_FILE,
  assertMarkerSources,
  digest,
  migratedCarryOverPath,
  readMarker,
  readOptionalFile,
  registryBackupFile,
  safeMigrationRelativePath,
  writeMarker,
  type CarryOverMigrationMarker,
  type CarryOverMigrationMarkerBase,
} from './carryover-migration-files.js';
import { resumeInterruptedCarryOverRollback } from './chat-carryover-rollback.js';

const EMPTY_FILE_SHA256 = crypto.createHash('sha256').digest('hex');

export async function migrateLegacyCarryOverWorkspace(workspaceDir: string): Promise<boolean> {
  // Direct callers still get rollback recovery here; the server also invokes
  // it before opening the version ladder, in which case this is a no-op.
  const rollbackResumed = await resumeInterruptedCarryOverRollback(workspaceDir);
  const registryVersion = await readChatRegistryVersion(workspaceDir);
  if (registryVersion === null) return rollbackResumed;
  const marker = await readMarker(workspaceDir);
  const workspaceVersion = await readWorkspaceVersion(workspaceDir);
  if (registryVersion === 5) {
    if (workspaceVersion !== null && workspaceVersion >= 5) return rollbackResumed;
    if (!marker || (marker.phase !== 'ready-to-commit' && marker.phase !== 'complete')) {
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

function parseTargetJournal(bytes: Buffer): AgentOwnershipJournalFileV5 {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(value)
    || value.version !== 5
    || !Array.isArray(value.ownershipIntents)
  ) {
    throw new Error('Invalid migrated ownership journal');
  }
  return value as unknown as AgentOwnershipJournalFileV5;
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

function migrationErrorCode(error: unknown): string {
  if (error && typeof error === 'object' && 'code' in error && typeof error.code === 'string') {
    return error.code;
  }
  return error instanceof SyntaxError ? 'INVALID_JSON' : 'INVALID_CARRYOVER_ENTRY';
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
