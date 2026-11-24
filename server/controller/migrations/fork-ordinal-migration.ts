import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatId } from '../../../common/chat-id.js';
import { writeJsonFileAtomic } from '../../common/json-file-store.js';
import { parseStoredJson } from '../../common/stored-json.js';
import { isRecord } from '../../../common/json.js';

export async function removeLegacyForkOrdinals(workspaceDir: string): Promise<void> {
  const registryPath = path.join(workspaceDir, 'chats.json');
  let raw: string;
  try {
    raw = await fs.readFile(registryPath, 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return;
    throw error;
  }

  const registry: unknown = parseStoredJson(raw, 'chats.json');
  if (!isRecord(registry)
    || registry.version !== 5
    || !isRecord(registry.sessions)) {
    throw new Error('Invalid chat registry for fork ordinal cleanup');
  }

  let changed = false;
  for (const [chatId, entry] of Object.entries(registry.sessions)) {
    parseChatId(chatId);
    if (!isRecord(entry) || typeof entry.agentOwnershipEpoch !== 'string' || !entry.agentOwnershipEpoch) {
      throw new Error(`Invalid chat registry entry for ${chatId}`);
    }
    if (Object.hasOwn(entry, 'nextForkOrdinal')) {
      delete entry.nextForkOrdinal;
      changed = true;
    }
  }
  if (changed) await writeJsonFileAtomic(registryPath, registry, { mode: 0o600 });
}
