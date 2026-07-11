import { promises as fs } from 'fs';
import path from 'path';

import { legacyChatIdToCanonical } from '../../common/chat-id.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { commandLedgerKey, commandPayloadHash } from '../commands/command-ledger.js';

interface MigrationResult<T> {
  value: T;
  changed: boolean;
}

export interface WorkspaceChatIdMigrationResult {
  migratedChatIds: Record<string, string>;
  changedFiles: string[];
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

async function discoverLegacyRegistryIds(
  workspaceDir: string,
  migrated: Map<string, string>,
): Promise<void> {
  const filePath = path.join(workspaceDir, 'chats.json');
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  if (!isRecord(parsed) || !isRecord(parsed.sessions)) return;

  const destinations = new Set<string>();
  for (const rawChatId of Object.keys(parsed.sessions)) {
    const canonical = legacyChatIdToCanonical(rawChatId);
    const destination = canonical ?? rawChatId;
    if (destinations.has(destination)) {
      throw new Error(`Chat ID migration collision in chats.json: ${rawChatId} -> ${destination}`);
    }
    destinations.add(destination);
    if (canonical) migrated.set(rawChatId, canonical);
  }
}

function migratedChatId(value: unknown, migrated: Map<string, string>): unknown {
  return typeof value === 'string' ? migrated.get(value) ?? value : value;
}

function migrateRecordKeys(
  value: Record<string, unknown>,
  migrated: Map<string, string>,
  label: string,
  migrateValue?: (entry: unknown, chatId: string) => MigrationResult<unknown>,
): MigrationResult<Record<string, unknown>> {
  const next: Record<string, unknown> = {};
  let changed = false;

  for (const [rawChatId, entry] of Object.entries(value)) {
    const chatId = migratedChatId(rawChatId, migrated) as string;
    if (Object.hasOwn(next, chatId)) {
      throw new Error(`Chat ID migration collision in ${label}: ${rawChatId} -> ${chatId}`);
    }
    const migratedEntry = migrateValue?.(entry, chatId) ?? { value: entry, changed: false };
    next[chatId] = migratedEntry.value;
    changed = changed || chatId !== rawChatId || migratedEntry.changed;
  }
  return { value: next, changed };
}

async function migrateJsonFile(
  workspaceDir: string,
  fileName: string,
  transform: (value: unknown) => MigrationResult<unknown>,
  changedFiles: Set<string>,
  mode?: number,
): Promise<void> {
  const filePath = path.join(workspaceDir, fileName);
  let parsed: unknown;
  try {
    parsed = JSON.parse(await fs.readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const result = transform(parsed);
  if (!result.changed) return;
  await writeJsonFileAtomic(filePath, result.value, { mode });
  changedFiles.add(fileName);
}

function migrateSettings(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value)) return { value, changed: false };
  const next = { ...value };
  let changed = false;

  for (const field of ['pinnedChatIds', 'normalChatIds', 'archivedChatIds']) {
    const current = value[field];
    if (!Array.isArray(current)) continue;
    const seen = new Set<string>();
    const migratedIds = current.map((chatId) => migratedChatId(chatId, migrated));
    const deduplicated = migratedIds.filter((chatId) => {
      if (typeof chatId !== 'string' || seen.has(chatId)) return false;
      seen.add(chatId);
      return true;
    });
    next[field] = deduplicated;
    changed = changed || deduplicated.length !== current.length
      || deduplicated.some((chatId, index) => chatId !== current[index]);
  }

  if (isRecord(value.chatNames)) {
    const names = migrateRecordKeys(value.chatNames, migrated, 'project-settings.json chatNames');
    next.chatNames = names.value;
    changed = changed || names.changed;
  }
  return { value: next, changed };
}

function migrateMetadata(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value) || !isRecord(value.chats)) return { value, changed: false };
  const chats = migrateRecordKeys(
    value.chats,
    migrated,
    'chat-metadata.json',
    (entry, chatId) => {
      if (!isRecord(entry) || entry.chatId === chatId) return { value: entry, changed: false };
      return { value: { ...entry, chatId }, changed: true };
    },
  );
  return chats.changed
    ? { value: { ...value, chats: chats.value }, changed: true }
    : { value, changed: false };
}

function migrateKeyedChats(
  value: unknown,
  migrated: Map<string, string>,
  label: string,
): MigrationResult<unknown> {
  if (!isRecord(value) || !isRecord(value.chats)) return { value, changed: false };
  const chats = migrateRecordKeys(value.chats, migrated, label);
  return chats.changed
    ? { value: { ...value, chats: chats.value }, changed: true }
    : { value, changed: false };
}

function migrateLedger(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value) || !Array.isArray(value.records)) return { value, changed: false };
  let changed = false;
  const keys = new Set<string>();
  const records = value.records.map((rawRecord) => {
    if (!isRecord(rawRecord)) return rawRecord;
    const next = { ...rawRecord };
    const chatId = migratedChatId(rawRecord.chatId, migrated);
    if (chatId !== rawRecord.chatId) {
      next.chatId = chatId;
      changed = true;
    }

    if (isRecord(rawRecord.payload)) {
      const payload = { ...rawRecord.payload };
      let payloadChanged = false;
      for (const field of ['chatId', 'sourceChatId']) {
        const replacement = migratedChatId(payload[field], migrated);
        if (replacement !== payload[field]) {
          payload[field] = replacement;
          payloadChanged = true;
        }
      }
      if (payloadChanged) {
        next.payload = payload;
        next.payloadHash = commandPayloadHash(payload);
        changed = true;
      }
    }

    if (
      typeof next.commandType === 'string'
      && typeof next.chatId === 'string'
      && typeof next.clientRequestId === 'string'
    ) {
      const key = commandLedgerKey(next.commandType, next.chatId, next.clientRequestId);
      if (keys.has(key)) throw new Error(`Chat ID migration collision in command-ledger.json: ${key}`);
      keys.add(key);
      if (next.key !== key) {
        next.key = key;
        changed = true;
      }
    }
    return next;
  });
  return changed ? { value: { ...value, records }, changed: true } : { value, changed: false };
}

function migrateScheduledPrompts(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value)) return { value, changed: false };
  const collectionKey = Array.isArray(value.prompts)
    ? 'prompts'
    : Array.isArray(value.tasks)
      ? 'tasks'
      : null;
  if (!collectionKey) return { value, changed: false };
  let changed = false;
  const prompts = (value[collectionKey] as unknown[]).map((rawPrompt) => {
    if (!isRecord(rawPrompt) || !isRecord(rawPrompt.target) || rawPrompt.target.type !== 'existing-chat') {
      return rawPrompt;
    }
    const chatId = migratedChatId(rawPrompt.target.chatId, migrated);
    if (chatId === rawPrompt.target.chatId) return rawPrompt;
    changed = true;
    return { ...rawPrompt, target: { ...rawPrompt.target, chatId } };
  });
  return changed ? { value: { ...value, [collectionKey]: prompts }, changed: true } : { value, changed: false };
}

function migrateShareIndex(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value) || !isRecord(value.shares)) return { value, changed: false };
  let changed = false;
  const shares = Object.fromEntries(Object.entries(value.shares).map(([token, rawShare]) => {
    if (!isRecord(rawShare)) return [token, rawShare];
    const chatId = migratedChatId(rawShare.chatId, migrated);
    if (chatId === rawShare.chatId) return [token, rawShare];
    changed = true;
    return [token, { ...rawShare, chatId }];
  }));
  return changed ? { value: { ...value, shares }, changed: true } : { value, changed: false };
}

async function migrateShareSnapshots(
  workspaceDir: string,
  migrated: Map<string, string>,
  changedFiles: Set<string>,
): Promise<void> {
  const sharesDir = path.join(workspaceDir, 'shares');
  let entries: string[];
  try {
    entries = await fs.readdir(sharesDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  for (const entry of entries) {
    if (!entry.endsWith('.json')) continue;
    const snapshotChanges = new Set<string>();
    await migrateJsonFile(
      sharesDir,
      entry,
      (value) => {
        if (!isRecord(value)) return { value, changed: false };
        const chatId = migratedChatId(value.chatId, migrated);
        return chatId === value.chatId
          ? { value, changed: false }
          : { value: { ...value, chatId }, changed: true };
      },
      snapshotChanges,
    );
    if (snapshotChanges.has(entry)) changedFiles.add(path.join('shares', entry));
  }
}

async function migrateChatIdFileNames(
  workspaceDir: string,
  directory: string,
  suffix: string,
  migrated: Map<string, string>,
  changedFiles: Set<string>,
): Promise<void> {
  const directoryPath = path.join(workspaceDir, directory);
  let entries: string[];
  try {
    entries = await fs.readdir(directoryPath);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  for (const entry of entries) {
    if (!entry.endsWith(suffix)) continue;
    const rawChatId = entry.slice(0, -suffix.length);
    const chatId = migratedChatId(rawChatId, migrated);
    if (chatId === rawChatId || typeof chatId !== 'string') continue;
    const source = path.join(directoryPath, entry);
    const destination = path.join(directoryPath, `${chatId}${suffix}`);
    try {
      await fs.access(destination);
      throw new Error(`Chat ID migration collision at ${destination}`);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== 'ENOENT') throw error;
    }
    await fs.rename(source, destination);
    changedFiles.add(path.join(directory, `${chatId}${suffix}`));
  }
}

function migrateRegistry(value: unknown, migrated: Map<string, string>): MigrationResult<unknown> {
  if (!isRecord(value) || !isRecord(value.sessions)) return { value, changed: false };
  const sessions = migrateRecordKeys(value.sessions, migrated, 'chats.json');
  return sessions.changed
    ? { value: { ...value, sessions: sessions.value }, changed: true }
    : { value, changed: false };
}

export async function migrateWorkspaceChatIds(
  workspaceDir: string,
): Promise<WorkspaceChatIdMigrationResult> {
  const migrated = new Map<string, string>();
  const changedFiles = new Set<string>();

  await discoverLegacyRegistryIds(workspaceDir, migrated);
  if (migrated.size === 0) return { migratedChatIds: {}, changedFiles: [] };

  await migrateJsonFile(workspaceDir, 'project-settings.json', (value) => migrateSettings(value, migrated), changedFiles);
  await migrateJsonFile(workspaceDir, 'chat-metadata.json', (value) => migrateMetadata(value, migrated), changedFiles);
  await migrateJsonFile(workspaceDir, 'chat-carryover.json', (value) => migrateKeyedChats(value, migrated, 'chat-carryover.json'), changedFiles);
  await migrateJsonFile(workspaceDir, 'command-ledger.json', (value) => migrateLedger(value, migrated), changedFiles);
  await migrateJsonFile(workspaceDir, 'scheduled-tasks.json', (value) => migrateScheduledPrompts(value, migrated), changedFiles, 0o600);
  await migrateJsonFile(workspaceDir, 'scheduled-prompts.json', (value) => migrateScheduledPrompts(value, migrated), changedFiles, 0o600);
  await migrateJsonFile(workspaceDir, 'shared-chats.json', (value) => migrateShareIndex(value, migrated), changedFiles);
  await migrateShareSnapshots(workspaceDir, migrated, changedFiles);
  await migrateChatIdFileNames(workspaceDir, 'queues', '.queue.json', migrated, changedFiles);
  await migrateChatIdFileNames(workspaceDir, 'chat-events', '.events.jsonl', migrated, changedFiles);

  // The registry is committed last so an interrupted migration can recover all
  // dependent references from the remaining legacy keys on the next startup.
  await migrateJsonFile(workspaceDir, 'chats.json', (value) => migrateRegistry(value, migrated), changedFiles);

  return {
    migratedChatIds: Object.fromEntries([...migrated.entries()].sort(([left], [right]) => left.localeCompare(right))),
    changedFiles: [...changedFiles].sort(),
  };
}
