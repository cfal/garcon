import { promises as fs } from 'fs';
import type { ChatMessage } from '../../../common/chat-types.js';
import { parseChatMessages } from '../../../common/chat-types.js';
import {
  renderCarriedTranscript,
  type CarryOverSegment,
} from '../chat-carryover-store.js';
import type { CarryOverSearchDescriptor } from './source-types.js';

interface PersistedCarryOverEntry {
  revision: number;
  segments: CarryOverSegment[];
}

interface CachedCarryOverFile {
  mtimeMs: number;
  entries: Map<string, PersistedCarryOverEntry>;
}

const cache = new Map<string, CachedCarryOverFile>();

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

function normalizeSegments(value: unknown): CarryOverSegment[] {
  if (!Array.isArray(value)) return [];
  return value.flatMap((raw) => {
    if (!isRecord(raw) || typeof raw.agentId !== 'string') return [];
    return [{
      agentId: raw.agentId,
      model: typeof raw.model === 'string' ? raw.model : '',
      at: typeof raw.at === 'string' ? raw.at : new Date(0).toISOString(),
      messages: parseChatMessages(raw.messages),
    }];
  });
}

async function loadFile(filePath: string): Promise<CachedCarryOverFile> {
  const stat = await fs.stat(filePath);
  const existing = cache.get(filePath);
  if (existing?.mtimeMs === stat.mtimeMs) return existing;
  const parsed = JSON.parse(await fs.readFile(filePath, 'utf8')) as unknown;
  const chats = isRecord(parsed) && isRecord(parsed.chats) ? parsed.chats : {};
  const version = isRecord(parsed) && parsed.version === 2 ? 2 : 1;
  const entries = new Map<string, PersistedCarryOverEntry>();
  for (const [chatId, raw] of Object.entries(chats)) {
    if (version === 1) {
      entries.set(chatId, { revision: 1, segments: normalizeSegments(raw) });
      continue;
    }
    if (!isRecord(raw)) continue;
    entries.set(chatId, {
      revision: typeof raw.revision === 'number' ? raw.revision : 1,
      segments: normalizeSegments(raw.segments),
    });
  }
  const loaded = { mtimeMs: stat.mtimeMs, entries };
  cache.set(filePath, loaded);
  return loaded;
}

export async function loadCarriedSearchMessages(
  chatId: string,
  descriptor: CarryOverSearchDescriptor,
  current: { agentId: string; model: string },
): Promise<ChatMessage[]> {
  const loaded = await loadFile(descriptor.filePath);
  const entry = loaded.entries.get(chatId);
  if (!entry || entry.revision !== descriptor.chatRevision) {
    throw new Error('Carry-over source changed during transcript indexing');
  }
  return renderCarriedTranscript(entry.segments, current);
}

