import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatId } from '../../../common/chat-id.js';
import { isRecord } from '../../../common/json.js';
import { writeJsonFileAtomic } from '../../common/json-file-store.js';
import { parseStoredJson } from '../../common/stored-json.js';
import { normalizeChatRegistryEntry } from '../chats/registry-entry-codec.js';

export async function migrateNativeChildObservers(workspaceDir: string): Promise<void> {
  const target = path.join(workspaceDir, 'chats.json');
  let raw: string;
  try { raw = await fs.readFile(target, 'utf8'); }
  catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }
  const registry: unknown = parseStoredJson(raw, 'chats.json');
  if (!isRecord(registry) || !isRecord(registry.sessions) || (registry.version !== 6 && registry.version !== 7)) {
    throw new Error('Invalid chat registry for native child observers');
  }
  const sessions: Record<string, Record<string, unknown>> = {};
  for (const [id, entry] of Object.entries(registry.sessions)) {
    const chatId = parseChatId(id);
    if (!isRecord(entry)) throw new Error(`Invalid chat registry entry ${chatId}`);
    if (registry.version === 6 && entry.nativeObservation != null) {
      throw new Error(`Unexpected observation in legacy registry entry ${chatId}`);
    }
    if (registry.version === 7 && !Object.hasOwn(entry, 'nativeObservation')) {
      throw new Error(`Missing nativeObservation for ${chatId}`);
    }
    const converted = registry.version === 6 ? { ...entry, nativeObservation: null } : entry;
    normalizeChatRegistryEntry(converted, chatId);
    sessions[chatId] = converted;
  }
  if (registry.version === 7) return;
  await writeJsonFileAtomic(target, { ...registry, version: 7, sessions }, { mode: 0o600 });
}
