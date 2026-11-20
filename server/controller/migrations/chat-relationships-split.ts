import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatId } from '../../../common/chat-id.js';
import { isRecord } from '../../../common/json.js';
import { writeJsonFileAtomic } from '../../common/json-file-store.js';
import { parseStoredJson } from '../../common/stored-json.js';
import { normalizeChatRegistryEntry } from '../chats/registry-entry-codec.js';
import { createLogger } from '../../common/log.js';

const logger = createLogger('migrations:chat-relationships-split');

function splitLegacyParent(entry: Record<string, unknown>, chatId: string): Record<string, unknown> {
  if ('parentChatId' in entry || 'lineage' in entry) throw new Error(`Mixed relationship schemas for ${chatId}`);
  const { parentChat, ...rest } = entry;
  if (parentChat === undefined || parentChat === null) return { ...rest, parentChatId: null, lineage: null };
  if (!isRecord(parentChat)) throw new Error(`Invalid legacy parentChat for ${chatId}`);
  const parentId = parseChatId(parentChat.chatId);
  if (parentId === chatId) throw new Error(`Self-referencing legacy parentChat for ${chatId}`);
  if (parentChat.relation === 'delegation') {
    if (Object.keys(parentChat).some((key) => !['chatId', 'relation'].includes(key))) {
      throw new Error(`Invalid legacy delegation for ${chatId}`);
    }
    return { ...rest, parentChatId: parentId, lineage: null };
  }
  if ((parentChat.relation !== 'fork' && parentChat.relation !== 'handoff')
    || typeof parentChat.transcriptViewId !== 'string' || !parentChat.transcriptViewId
    || !Number.isSafeInteger(parentChat.ordinal) || Number(parentChat.ordinal) < 0
    || Object.keys(parentChat).some((key) => !['chatId', 'relation', 'transcriptViewId', 'ordinal'].includes(key))) {
    throw new Error(`Invalid legacy lineage for ${chatId}`);
  }
  return {
    ...rest,
    parentChatId: null,
    lineage: {
      sourceChatId: parentId,
      kind: parentChat.relation,
      transcriptViewId: parentChat.transcriptViewId,
      ordinal: parentChat.ordinal,
    },
  };
}

export async function splitChatRelationships(workspaceDir: string): Promise<void> {
  const registryPath = path.join(workspaceDir, 'chats.json');
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const registry: unknown = parseStoredJson(raw, 'chats.json');
  if (!isRecord(registry) || !isRecord(registry.sessions) || (registry.version !== 5 && registry.version !== 6)) {
    throw new Error('Invalid chat registry for relationship split');
  }
  const sessions: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(registry.sessions)) {
    try {
      const chatId = parseChatId(id);
      if (!isRecord(entry)) throw new Error('Invalid chat registry entry');
      const converted = registry.version === 5 ? splitLegacyParent(entry, chatId) : entry;
      normalizeChatRegistryEntry(converted, chatId);
      sessions[chatId] = converted;
    } catch (cause) {
      throw new Error(`Chat relationship migration failed for entry ${id}`, { cause });
    }
  }
  if (registry.version === 6) return;
  await writeJsonFileAtomic(registryPath, { ...registry, version: 6, sessions }, { mode: 0o600 });
  logger.info(`Migrated relationships for ${Object.keys(sessions).length} chats to registry schema 6`);
}
