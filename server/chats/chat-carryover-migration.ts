import crypto from 'node:crypto';
import { promises as fs } from 'node:fs';
import path from 'node:path';
import v8 from 'node:v8';
import type { ChatMessage } from '../../common/chat-types.js';
import { AgentSwitchMessage, UserMessage, parseChatMessages } from '../../common/chat-types.js';
import {
  createNativeSeedReceipt,
  renderTranscriptSeed,
} from '../../common/transcript-seed.js';
import { isRecord } from '../../common/json.js';
import { syncDirectory, writeJsonFileAtomic } from '../lib/json-file-store.js';
import {
  emptyOwnershipJournalV2,
  type AgentOwnershipJournalFileV2,
  type DeleteIntentV2,
  type SourceReleaseCleanup,
} from './agent-ownership-journal.js';
import { CarryOverTranscriptStore } from './carryover-transcript-store.js';
import { readChatRegistryVersion, readLegacyChatRegistryV3 } from './legacy-chat-registry-v3.js';

const MIGRATION_MARKER_VERSION = 1 as const;
const MIGRATION_MARKER_FILE = 'carryover-transcripts/migration-v1.json';
const LEGACY_CARRYOVER_FILE = 'chat-carryover.json';
const OWNERSHIP_JOURNAL_FILE = 'agent-ownership-journal.json';

interface CarryOverMigrationMarkerBase {
  readonly version: typeof MIGRATION_MARKER_VERSION;
  readonly sourceCarryOverSha256: string;
  readonly sourceRegistrySha256: string;
  readonly sourceJournalSha256: string;
  readonly legacyJournalBackupFile: string;
  readonly startedAt: string;
}

type CarryOverMigrationMarker =
  | (CarryOverMigrationMarkerBase & { readonly phase: 'in-progress' })
  | (CarryOverMigrationMarkerBase & {
      readonly phase: 'ready-to-commit';
      readonly targetRegistrySha256: string;
      readonly nodeSummarySha256: string;
      readonly nodeCount: number;
    })
  | (CarryOverMigrationMarkerBase & {
      readonly phase: 'complete';
      readonly targetRegistrySha256: string;
      readonly nodeSummarySha256: string;
      readonly nodeCount: number;
      readonly completedAt: string;
      readonly rollbackSafe: boolean;
    });

interface LegacyCarryOverSegment {
  readonly agentId: string;
  readonly model: string;
  readonly messages: readonly ChatMessage[];
  readonly at: string;
  readonly boundary: boolean;
  readonly boundaryTarget: { readonly agentId: string; readonly model: string } | null;
}

class LegacyCarryOverDataError extends Error {
  constructor(message: string, options?: ErrorOptions) {
    super(message, options);
    this.name = 'LegacyCarryOverDataError';
  }
}

export async function migrateLegacyCarryOverWorkspace(workspaceDir: string): Promise<void> {
  const registryVersion = await readChatRegistryVersion(workspaceDir);
  if (registryVersion === null) return;
  const marker = await readMarker(workspaceDir);
  const workspaceVersion = await readWorkspaceVersion(workspaceDir);
  if (registryVersion === 4) {
    if (workspaceVersion !== null && workspaceVersion >= 4) return;
    if (!marker || marker.phase === 'in-progress') {
      throw new Error('Schema-v4 chat registry has no committed carryover migration marker');
    }
    await resumeCommittedMigration(workspaceDir, marker);
    return;
  }
  if (registryVersion !== 3) throw new Error(`Unsupported chat registry version: ${registryVersion}`);
  if (marker?.phase === 'complete') {
    throw new Error('Completed carryover migration marker cannot accompany a schema-v3 registry');
  }
  await assertWorkspaceVersionAllowsMigration(workspaceDir);
  await ensureMigrationDirectories(workspaceDir);

  const registryPath = path.join(workspaceDir, 'chats.json');
  const carryOverPath = path.join(workspaceDir, LEGACY_CARRYOVER_FILE);
  const journalPath = path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE);
  await assertMigrationCapacity(workspaceDir, await optionalFileSize(carryOverPath));
  const [registryBytes, carryOverBytes, journalBytes] = await Promise.all([
    fs.readFile(registryPath),
    readOptionalFile(carryOverPath),
    readOptionalFile(journalPath),
  ]);
  const sourceDigests = {
    sourceCarryOverSha256: digest(carryOverBytes),
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
    startedAt,
  };
  await writeMarker(workspaceDir, { ...markerBase, phase: 'in-progress' });
  await writeMigrationBackup(workspaceDir, legacyJournalBackupFile, journalBytes);
  await writeMigrationBackup(
    workspaceDir,
    `migration-backups/chats.v3.${sourceDigests.sourceRegistrySha256.slice(0, 16)}.json`,
    registryBytes,
  );

  const legacyRegistry = await readLegacyChatRegistryV3(workspaceDir);
  if (!legacyRegistry) return;
  const rawCarryOver = parseLegacyCarryOverFile(carryOverBytes);
  const nodes = new CarryOverTranscriptStore({ workspaceDir });
  await nodes.initialize();
  const sessions: Record<string, Record<string, unknown>> = {};
  const roots: Array<readonly [string, string | null]> = [];
  const migratedNodeIds = new Set<string>();

  for (const [chatId, entry] of Object.entries(legacyRegistry.sessions)) {
    const rawCarryOverEntry = rawCarryOver.get(chatId);
    try {
      const segments = activeLegacySegments(rawCarryOverEntry, entry);
      const converted = await convertLegacySegments({
        chatId,
        entry,
        segments,
        sourceDigest: sourceDigests.sourceCarryOverSha256,
        startedAt,
        nodes,
      });
      for (const nodeId of converted.nodeIds) migratedNodeIds.add(nodeId);
      roots.push([chatId, converted.headId]);
      sessions[chatId] = {
        ...entry,
        carryOverHeadId: converted.headId,
        nativeSeedReceipt: converted.nativeSeedReceipt,
        carryOverMigrationQuarantine: null,
      };
    } catch (error) {
      if (!isQuarantinableMigrationError(error)) throw error;
      const artifactId = deterministicUuid(`quarantine:${sourceDigests.sourceCarryOverSha256}:${chatId}`);
      await writeJsonFileAtomic(
        path.join(workspaceDir, 'carryover-transcripts', 'quarantine', `${artifactId}.json`),
        { version: 1, chatId, entry: rawCarryOverEntry ?? null },
        { mode: 0o600 },
      );
      roots.push([chatId, null]);
      sessions[chatId] = {
        ...entry,
        carryOverHeadId: null,
        nativeSeedReceipt: null,
        carryOverMigrationQuarantine: {
          artifactId,
          errorCode: migrationErrorCode(error),
        },
      };
    }
  }

  const targetRegistry = { version: 4, sessions };
  const nodeCount = migratedNodeIds.size;
  const targetRegistryBytes = serializeJson(targetRegistry);
  const targetRegistrySha256 = digest(targetRegistryBytes);
  const nodeSummarySha256 = digest(Buffer.from(JSON.stringify(roots.sort(([left], [right]) => (
    left.localeCompare(right)
  )))));
  const ready: CarryOverMigrationMarker = {
    ...markerBase,
    phase: 'ready-to-commit',
    targetRegistrySha256,
    nodeSummarySha256,
    nodeCount,
  };
  await writeMarker(workspaceDir, ready);

  const targetJournal = migrateLegacyOwnershipJournal(journalBytes, sessions);
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
}

export async function markCarryOverMigrationRollbackUnsafe(workspaceDir: string): Promise<void> {
  const marker = await readMarker(workspaceDir);
  if (!marker) return;
  if (marker.phase !== 'complete') {
    throw new Error('Cannot accept new carryover nodes while migration is incomplete');
  }
  if (!marker.rollbackSafe) return;
  await writeMarker(workspaceDir, { ...marker, rollbackSafe: false });
}

export async function finalizeCarryOverMigrationValidation(workspaceDir: string): Promise<void> {
  const marker = await readMarker(workspaceDir);
  if (!marker || marker.phase !== 'complete') return;
  if (marker.rollbackSafe) await writeMarker(workspaceDir, { ...marker, rollbackSafe: false });
  await Promise.all([
    fs.rm(migratedCarryOverPath(workspaceDir, marker.startedAt), { force: true }),
    fs.rm(path.join(workspaceDir, registryBackupFile(marker)), { force: true }),
    fs.rm(path.join(
      workspaceDir,
      safeMigrationRelativePath(marker.legacyJournalBackupFile),
    ), { force: true }),
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
  if (registryVersion === 3 && !marker) return 'already-restored';
  if (!marker || marker.phase !== 'complete') {
    throw new Error('No completed carryover migration is available to roll back');
  }
  if (!marker.rollbackSafe) {
    throw new Error('Carryover migration rollback is unsafe after new-format history was created');
  }

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

  await restoreOptionalFile(
    path.join(workspaceDir, LEGACY_CARRYOVER_FILE),
    legacyCarryOver,
  );
  await restoreOptionalFile(
    path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE),
    journalBackup,
  );
  await writeJsonFileAtomic(path.join(workspaceDir, 'workspace-version.json'), { version: 3 }, {
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

  const legacyCarryOver = await readOptionalFile(path.join(workspaceDir, LEGACY_CARRYOVER_FILE));
  if (legacyCarryOver.byteLength > 0 && digest(legacyCarryOver) !== marker.sourceCarryOverSha256) {
    throw new Error('Legacy carryover source changed after registry commit');
  }

  const journalPath = path.join(workspaceDir, OWNERSHIP_JOURNAL_FILE);
  if (marker.phase === 'ready-to-commit') {
    const relativeBackup = safeMigrationRelativePath(marker.legacyJournalBackupFile);
    const journalBackup = await readOptionalFile(path.join(workspaceDir, relativeBackup));
    if (digest(journalBackup) !== marker.sourceJournalSha256) {
      throw new Error('Legacy ownership-journal backup does not match its migration marker');
    }
    const targetJournal = migrateLegacyOwnershipJournal(journalBackup, targetRegistry.sessions);
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
  readonly nodes: CarryOverTranscriptStore;
}): Promise<{ headId: string | null; nativeSeedReceipt: unknown; nodeIds: readonly string[] }> {
  const current = {
    agentId: legacyRequiredString(input.entry.agentId, 'chat agent'),
    model: legacyStringValue(input.entry.model, 'chat model'),
  };
  let headId: string | null = null;
  const nodeIds: string[] = [];
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
      const nodeId = deterministicUuid([
        input.sourceDigest,
        String(index),
        headId ?? '',
        JSON.stringify(messages),
        segment.agentId,
        segment.model,
        segment.at,
        seedSanitation,
        String(segment.boundary),
        target.agentId,
        target.model,
      ].join(':'));
      const prepared = await input.nodes.prepareMaterialized({
        operationId: `migration:${input.sourceDigest}:${input.chatId}:${index}`,
        id: nodeId,
        parentId: headId,
        source: {
          agentId: segment.agentId,
          model: segment.model,
          nativeSessionId: null,
          nativeRevision: `migration:${input.sourceDigest}:${nodeId}`,
        },
        boundary: segment.boundary
          ? { kind: 'handoff', targetAtCapture: { agentId: target.agentId, model: target.model } }
          : null,
        seedSanitation,
        messages,
        createdAt: segment.at || input.startedAt,
      });
      await prepared.commit();
      prepared.releaseRoot();
      headId = nodeId;
      nodeIds.push(nodeId);
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

  await input.nodes.assertReachableForHandoff(headId);
  const migrated = await input.nodes.loadAll(headId, current);
  if (canonicalMessages(migrated) !== canonicalMessages(rendered)) {
    throw new Error(`Migrated carryover transcript differs for chat ${input.chatId}`);
  }
  if (rendered.length > 0 && headId === null) {
    throw new Error(`Migrated carryover transcript has no history head for chat ${input.chatId}`);
  }
  const agentSessionId = nullableString(input.entry.agentSessionId);
  const nativeSeedReceipt = headId && agentSessionId
    ? createNativeSeedReceipt({
        headId,
        agentSessionId,
        placement: 'user-prefix',
        format: 'legacy-v0',
        prefix: `${renderTranscriptSeed(legacyRendered)}\n\n`,
      })
    : null;
  return { headId, nativeSeedReceipt, nodeIds };
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

function parseLegacyCarryOverFile(bytes: Buffer): Map<string, unknown> {
  if (bytes.byteLength === 0) return new Map();
  const parsed: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(parsed) || !isRecord(parsed.chats)) throw new Error('Invalid legacy carryover file');
  return new Map(Object.entries(parsed.chats));
}

function activeLegacySegments(
  value: unknown,
  registryEntry: Readonly<Record<string, unknown>>,
): LegacyCarryOverSegment[] {
  if (value === undefined) return [];
  let rawSegments: unknown;
  if (Array.isArray(value)) rawSegments = value;
  else if (isRecord(value)) {
    const staged = isRecord(value.staged) ? value.staged : null;
    const stagedCommitted = staged
      && staged.ownerId === registryEntry.agentId
      && staged.targetEpoch === registryEntry.agentOwnershipEpoch;
    rawSegments = stagedCommitted ? staged.segments : value.segments;
  } else {
    throw new LegacyCarryOverDataError('Invalid legacy carryover chat entry');
  }
  if (!Array.isArray(rawSegments)) {
    throw new LegacyCarryOverDataError('Invalid legacy carryover segment list');
  }
  return rawSegments.map((raw, index) => parseLegacySegment(raw, index));
}

function parseLegacySegment(value: unknown, index: number): LegacyCarryOverSegment {
  if (!isRecord(value) || !Array.isArray(value.messages)) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover segment ${index}`);
  }
  let messages: ChatMessage[];
  try {
    messages = parseChatMessages(value.messages);
  } catch (error) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover message in segment ${index}`, {
      cause: error,
    });
  }
  if (messages.length !== value.messages.length) {
    throw new LegacyCarryOverDataError(`Invalid legacy carryover message in segment ${index}`);
  }
  const boundaryTarget = isRecord(value.boundaryTarget)
    ? {
        agentId: legacyRequiredString(value.boundaryTarget.agentId, 'boundary agent'),
        model: legacyStringValue(value.boundaryTarget.model, 'boundary model'),
      }
    : null;
  const at = typeof value.at === 'string' && Number.isFinite(Date.parse(value.at))
    ? value.at
    : new Date(0).toISOString();
  return {
    agentId: legacyRequiredString(value.agentId, 'segment agent'),
    model: legacyStringValue(value.model, 'segment model'),
    messages,
    at,
    boundary: value.boundary !== false,
    boundaryTarget,
  };
}

function migrateLegacyOwnershipJournal(
  bytes: Buffer,
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
): AgentOwnershipJournalFileV2 {
  if (bytes.byteLength === 0) return emptyOwnershipJournalV2();
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value)) throw new Error('Invalid legacy ownership journal');
  if (value.version === 2) return value as unknown as AgentOwnershipJournalFileV2;
  if (value.version !== 1 || !Array.isArray(value.intents)) {
    throw new Error('Unsupported legacy ownership journal');
  }
  const transferCleanup: SourceReleaseCleanup[] = [];
  const ownershipIntents: DeleteIntentV2[] = [];
  for (const raw of value.intents) {
    if (!isRecord(raw) || !isRecord(raw.oldReference) || typeof raw.chatId !== 'string') {
      throw new Error('Invalid legacy ownership intent');
    }
    const current = sessions[raw.chatId];
    const source = { ...raw.oldReference, nativeSeedReceipt: null } as unknown as SourceReleaseCleanup['source'];
    if (raw.kind === 'transfer') {
      if (current?.agentId === raw.targetAgentId && current.agentOwnershipEpoch === raw.targetEpoch) {
        transferCleanup.push({
          version: 1,
          operationId: requiredString(raw.id, 'legacy transfer ID'),
          chatId: raw.chatId,
          source,
          reason: 'transferred',
          status: 'pending',
          attempts: 0,
          lastErrorCode: null,
          createdAt: requiredString(raw.createdAt, 'legacy transfer timestamp'),
        });
      } else if (!matchesLegacySource(current, raw)) {
        throw new Error(`Legacy transfer ownership mismatch for ${raw.chatId}`);
      }
    } else if (raw.kind === 'delete') {
      if (!current) {
        ownershipIntents.push({
          version: 2,
          operationId: requiredString(raw.id, 'legacy delete ID'),
          kind: 'delete',
          chatId: raw.chatId,
          phase: 'registry-removed',
          sourceEpoch: typeof raw.oldEpoch === 'string' ? raw.oldEpoch : null,
          releaseReferences: [source],
          createdAt: requiredString(raw.createdAt, 'legacy delete timestamp'),
        });
      } else if (!matchesLegacySource(current, raw)) {
        throw new Error(`Legacy delete ownership mismatch for ${raw.chatId}`);
      }
    } else {
      throw new Error('Invalid legacy ownership intent kind');
    }
  }
  return { version: 2, ownershipIntents, transferCleanup };
}

function matchesLegacySource(
  current: Readonly<Record<string, unknown>> | undefined,
  intent: Readonly<Record<string, unknown>>,
): boolean {
  if (!current) return false;
  const reference = intent.oldReference as Record<string, unknown>;
  return current.agentId === reference.agentId
    && current.agentOwnershipEpoch === intent.oldEpoch
    && current.agentSessionId === reference.agentSessionId
    && JSON.stringify(current.nativeSession) === JSON.stringify(reference.nativeSession);
}

async function assertMigrationCapacity(workspaceDir: string, sourceBytes: number): Promise<void> {
  if (sourceBytes === 0) return;
  const requiredDisk = Math.ceil(sourceBytes * 2.5) + 64 * 1024 * 1024;
  const disk = await fs.statfs(workspaceDir);
  const availableDisk = Number(disk.bavail) * Number(disk.bsize);
  if (availableDisk < requiredDisk) {
    throw new Error(`Carryover migration requires at least ${requiredDisk} free bytes`);
  }
  const heap = v8.getHeapStatistics();
  const availableHeap = heap.heap_size_limit - heap.used_heap_size;
  const requiredHeap = sourceBytes * 3;
  if (availableHeap < requiredHeap) {
    throw new Error(`Carryover migration requires at least ${requiredHeap} bytes of available heap`);
  }
}

async function assertWorkspaceVersionAllowsMigration(workspaceDir: string): Promise<void> {
  const version = await readWorkspaceVersion(workspaceDir);
  if (version !== null && version >= 4) {
    throw new Error('Workspace version 4 cannot contain a schema-v3 chat registry');
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
  return path.join(workspaceDir, `chat-carryover.v4.migrated.${suffix}.json`);
}

function registryBackupFile(marker: CarryOverMigrationMarkerBase): string {
  return `migration-backups/chats.v3.${marker.sourceRegistrySha256.slice(0, 16)}.json`;
}

async function readRollbackCarryOverSource(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' }>,
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
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' }>,
): Promise<void> {
  await fs.rm(migratedCarryOverPath(workspaceDir, marker.startedAt), { force: true });
  await syncDirectory(workspaceDir);
}

async function archiveRollbackMarker(
  workspaceDir: string,
  marker: Extract<CarryOverMigrationMarker, { phase: 'complete' }>,
): Promise<void> {
  const markerPath = path.join(workspaceDir, MIGRATION_MARKER_FILE);
  const suffix = marker.completedAt.replaceAll(':', '').replaceAll('.', '');
  await fs.rename(
    markerPath,
    path.join(path.dirname(markerPath), `migration-v1.rolled-back.${suffix}.json`),
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
    startedAt: timestampValue(value.startedAt, 'migration start'),
  };
  if (value.phase === 'in-progress') return { ...base, phase: 'in-progress' };
  if (value.phase !== 'ready-to-commit' && value.phase !== 'complete') {
    throw new Error('Invalid carryover migration marker phase');
  }
  const committed = {
    ...base,
    targetRegistrySha256: sha256Value(value.targetRegistrySha256, 'target registry'),
    nodeSummarySha256: sha256Value(value.nodeSummarySha256, 'node summary'),
    nodeCount: nonNegativeInteger(value.nodeCount, 'migration node count'),
  };
  if (value.phase === 'ready-to-commit') return { ...committed, phase: 'ready-to-commit' };
  if (value.rollbackSafe !== true && value.rollbackSafe !== false) {
    throw new Error('Invalid carryover migration rollback state');
  }
  return {
    ...committed,
    phase: 'complete',
    completedAt: timestampValue(value.completedAt, 'migration completion'),
    rollbackSafe: value.rollbackSafe,
  };
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

function parseTargetRegistry(bytes: Buffer): {
  readonly version: 4;
  readonly sessions: Record<string, Readonly<Record<string, unknown>>>;
} {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (!isRecord(value) || value.version !== 4 || !isRecord(value.sessions)) {
    throw new Error('Invalid migrated chat registry');
  }
  const sessions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [chatId, entry] of Object.entries(value.sessions)) {
    if (!isRecord(entry)) throw new Error(`Invalid migrated chat registry entry for ${chatId}`);
    sessions[chatId] = entry;
  }
  return { version: 4, sessions };
}

function parseTargetJournal(bytes: Buffer): AgentOwnershipJournalFileV2 {
  const value: unknown = JSON.parse(bytes.toString('utf8'));
  if (
    !isRecord(value)
    || value.version !== 2
    || !Array.isArray(value.ownershipIntents)
    || !Array.isArray(value.transferCleanup)
  ) {
    throw new Error('Invalid migrated ownership journal');
  }
  return value as unknown as AgentOwnershipJournalFileV2;
}

async function validateMigratedRoots(
  workspaceDir: string,
  sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>,
  marker: { readonly nodeCount: number; readonly nodeSummarySha256: string },
): Promise<void> {
  const nodes = new CarryOverTranscriptStore({ workspaceDir });
  await nodes.initialize();
  const roots: Array<readonly [string, string | null]> = [];
  const nodeIds = new Set<string>();
  for (const [chatId, entry] of Object.entries(sessions)) {
    const headId = entry.carryOverHeadId === null
      ? null
      : requiredString(entry.carryOverHeadId, `carryover head for ${chatId}`);
    roots.push([chatId, headId]);
    if (!headId) continue;
    await nodes.assertReachableForHandoff(headId);
    await nodes.loadAll(headId, {
      agentId: requiredString(entry.agentId, `agent for ${chatId}`),
      model: stringValue(entry.model, `model for ${chatId}`),
    });
    let cursor: string | null = headId;
    while (cursor) {
      if (nodeIds.has(cursor)) break;
      const node = await nodes.readManifest(cursor);
      nodeIds.add(node.id);
      if (node.kind === 'prefix') nodeIds.add(node.sourceNodeId);
      cursor = node.parentId;
    }
  }
  const summary = digest(Buffer.from(JSON.stringify(roots.sort(([left], [right]) => (
    left.localeCompare(right)
  )))));
  if (summary !== marker.nodeSummarySha256 || nodeIds.size !== marker.nodeCount) {
    throw new Error('Migrated carryover node summary does not match its marker');
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

function canonicalMessages(messages: readonly ChatMessage[]): string {
  return JSON.stringify(messages);
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

function stringValue(value: unknown, field: string): string {
  if (typeof value !== 'string') throw new Error(`Invalid ${field}`);
  return value;
}

function nullableString(value: unknown): string | null {
  return typeof value === 'string' && value ? value : null;
}
