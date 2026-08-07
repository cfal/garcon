import { promises as fs } from 'node:fs';
import path from 'node:path';
import { parseChatId } from '../../common/chat-id.js';
import { isRecord } from '../../common/json.js';

export interface LegacyChatRegistryV3Snapshot {
  readonly version: 3;
  readonly sessions: Readonly<Record<string, Readonly<Record<string, unknown>>>>;
}

export async function readChatRegistryVersion(workspaceDir: string): Promise<number | null> {
  const value = await readRegistryFile(workspaceDir);
  if (value === null) return null;
  if (!isRecord(value) || !Number.isSafeInteger(value.version)) {
    throw new Error('Chat registry has no valid schema version');
  }
  return Number(value.version);
}

export async function readLegacyChatRegistryV3(
  workspaceDir: string,
): Promise<LegacyChatRegistryV3Snapshot | null> {
  const value = await readRegistryFile(workspaceDir);
  if (value === null) return null;
  if (!isRecord(value) || value.version !== 3 || !isRecord(value.sessions)) {
    throw new Error('Legacy chat registry must use schema version 3');
  }
  const sessions: Record<string, Readonly<Record<string, unknown>>> = {};
  for (const [rawChatId, rawEntry] of Object.entries(value.sessions)) {
    const chatId = parseChatId(rawChatId);
    if (!isRecord(rawEntry)) throw new Error(`Invalid legacy chat registry entry for ${chatId}`);
    sessions[chatId] = Object.freeze({ ...rawEntry });
  }
  return Object.freeze({ version: 3, sessions: Object.freeze(sessions) });
}

async function readRegistryFile(workspaceDir: string): Promise<unknown | null> {
  try {
    return JSON.parse(await fs.readFile(path.join(workspaceDir, 'chats.json'), 'utf8'));
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return null;
    throw error;
  }
}
