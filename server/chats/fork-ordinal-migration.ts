import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatId } from '../../common/chat-id.js';
import { writeJsonFileAtomic } from '../lib/json-file-store.js';
import { isObjectRecord, normalizeChatRegistryEntry } from './registry-entry-codec.js';
import { CHAT_REGISTRY_VERSION } from './store.js';

export async function removeLegacyForkOrdinals(workspaceDir: string): Promise<void> {
  const registryPath = path.join(workspaceDir, 'chats.json');
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const registry: unknown = JSON.parse(raw);
  if (!isObjectRecord(registry)
    || registry.version !== CHAT_REGISTRY_VERSION
    || !isObjectRecord(registry.sessions)) {
    throw new Error('Invalid chat registry for fork ordinal cleanup');
  }

  let changed = false;
  for (const [chatId, entry] of Object.entries(registry.sessions)) {
    if (!isObjectRecord(entry)) {
      throw new Error(`Invalid chat registry entry for ${chatId}`);
    }
    normalizeChatRegistryEntry(entry, parseChatId(chatId));
    if (Object.hasOwn(entry, 'nextForkOrdinal')) {
      delete entry.nextForkOrdinal;
      changed = true;
    }
  }
  if (changed) await writeJsonFileAtomic(registryPath, registry, { mode: 0o600 });
}
