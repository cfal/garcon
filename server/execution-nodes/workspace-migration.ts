import { readFile } from 'node:fs/promises';
import { join } from 'node:path';
import { parseChatId } from '../../common/chat-id.js';
import { isRecord } from '../../common/json.js';
import type { ExecutionLocation } from '../../common/execution-location.js';
import { isEmptyEarlierJournal, isJournalV5, isOwnershipJournal } from '../chats/agent-ownership-journal-format.js';
import type { AgentOwnershipJournalFile } from '../chats/agent-ownership-journal.js';
import { normalizeChatRegistryEntry } from '../chats/registry-entry-codec.js';
import { CHAT_REGISTRY_VERSION, type ChatRegistrySnapshot } from '../chats/store.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { migrateLocalChatLocations } from './location-migration.js';
import { ExecutionNodesStore } from './store.js';

/** Allocates identities first; each atomic owner-file replacement is independently restartable. */
export async function migrateWorkspaceExecutionLocations(
  workspaceDirectory: string,
  nodes: ExecutionNodesStore,
  write: typeof writeJsonFileAtomic = writeJsonFileAtomic,
): Promise<void> {
  const registryPath = join(workspaceDirectory, 'chats.json');
  const journalPath = join(workspaceDirectory, 'agent-ownership-journal.json');
  const rawRegistry = await readOptionalJson(registryPath);
  const rawJournal = await readOptionalJson(journalPath);
  const registry = rawRegistry === undefined
    ? { version: CHAT_REGISTRY_VERSION, sessions: {} }
    : isRecord(rawRegistry) && rawRegistry.version === 5
      ? await migrateLocalChatLocations(rawRegistry, nodes)
      : parseLocatedRegistry(rawRegistry);
  const journal = await migrateOwnershipJournal(rawJournal, registry, nodes);
  for (const entry of Object.values(registry.sessions)) {
    requireKnownProject(nodes, entry.executionLocation, entry.agentId, entry.projectPath);
  }
  for (const intent of journal.ownershipIntents) {
    if (intent.kind === 'handoff') {
      nodes.requireKnownLocation(intent.source.executionLocation, intent.source.agentId);
      const target = intent.target.execution;
      requireKnownProject(nodes, target.executionLocation, target.agentId, target.projectPath);
    } else {
      for (const reference of intent.releaseReferences) {
        requireKnownProject(nodes, reference.executionLocation, reference.chat.agentId, reference.chat.projectPath);
      }
    }
  }
  if (rawRegistry !== undefined && isRecord(rawRegistry) && rawRegistry.version !== CHAT_REGISTRY_VERSION) {
    await write(registryPath, registry, { mode: 0o600 });
  }
  if (rawJournal !== undefined && isRecord(rawJournal) && rawJournal.version !== journal.version) {
    await write(journalPath, journal, { mode: 0o600 });
  }
}

function parseLocatedRegistry(raw: unknown): ChatRegistrySnapshot {
  if (!isRecord(raw) || raw.version !== CHAT_REGISTRY_VERSION || !isRecord(raw.sessions)) {
    throw new Error('Invalid chat registry for execution location migration');
  }
  const sessions = Object.fromEntries(Object.entries(raw.sessions).map(([id, entry]) => {
    const chatId = parseChatId(id);
    if (!isRecord(entry)) throw new Error('Invalid chat registry entry');
    return [chatId, normalizeChatRegistryEntry(entry, chatId)];
  }));
  return { version: CHAT_REGISTRY_VERSION, sessions };
}

async function migrateOwnershipJournal(
  raw: unknown,
  registry: ChatRegistrySnapshot,
  nodes: ExecutionNodesStore,
): Promise<AgentOwnershipJournalFile> {
  if (raw === undefined || isEmptyEarlierJournal(raw)) return { version: 6, ownershipIntents: [] };
  if (isOwnershipJournal(raw)) return raw;
  if (!isJournalV5(raw)) throw new Error('Invalid ownership journal for execution location migration');
  const ownershipIntents: AgentOwnershipJournalFile['ownershipIntents'][number][] = [];
  for (const intent of raw.ownershipIntents) {
    if (intent.kind === 'handoff') {
      const chat = registry.sessions[intent.chatId];
      if (!chat || chat.executionLocation.nodeId !== nodes.localNodeId
        || 'executionLocation' in intent.source || 'executionLocation' in intent.target.execution) {
        throw new Error('Legacy handoff requires its original local chat binding');
      }
      const [sourceLocation, targetLocation] = await nodes.prepareLocalTargets([
        { chatId: intent.chatId, agentId: intent.source.agentId, projectPath: chat.projectPath },
        { chatId: intent.chatId, agentId: intent.target.execution.agentId, projectPath: chat.projectPath },
      ]);
      ownershipIntents.push({
        ...intent, version: 6,
        source: { ...intent.source, executionLocation: sourceLocation! },
        target: { ...intent.target, execution: {
          ...intent.target.execution, executionLocation: targetLocation!, projectPath: chat.projectPath,
        } },
      });
    } else {
      if (intent.releaseReferences.some((reference) => 'executionLocation' in reference)) {
        throw new Error('Legacy deletion contains an unexpected execution location');
      }
      const prepared = await nodes.prepareLocalTargets(intent.releaseReferences);
      ownershipIntents.push({
        ...intent, version: 3,
        releaseReferences: intent.releaseReferences.map((chat, index) => ({ executionLocation: prepared[index]!, chat })),
      });
    }
  }
  const migrated = { version: 6, ownershipIntents } as const;
  if (!isOwnershipJournal(migrated)) throw new Error('Invalid migrated ownership journal');
  return migrated;
}

function requireKnownProject(nodes: ExecutionNodesStore, location: ExecutionLocation, agentId: string, projectPath: string): void {
  if (nodes.requireKnownLocation(location, agentId).workspace.projectPath !== projectPath) {
    throw new Error('Execution workspace does not match its stored project path');
  }
}

async function readOptionalJson(filePath: string): Promise<unknown> {
  try {
    return JSON.parse(await readFile(filePath, 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return undefined;
    throw error;
  }
}
