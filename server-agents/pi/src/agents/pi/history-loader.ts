import { promises as fs } from 'fs';
import {
  buildContextEntries,
  sessionEntryToContextMessages,
  type FileEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertPiMessage } from './message-converter.js';

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== 'session';
}

function assertAcyclicActivePath(entries: SessionEntry[]): void {
  const byId = new Map(entries.flatMap((entry) => (
    typeof entry.id === 'string' && entry.id ? [[entry.id, entry] as const] : []
  )));
  let current = entries.at(-1);
  const visited = new Set<string>();
  while (current && typeof current.id === 'string' && current.id) {
    if (visited.has(current.id)) {
      throw new Error('Pi transcript parent graph contains a cycle');
    }
    visited.add(current.id);
    const parentId = typeof current.parentId === 'string' ? current.parentId : null;
    current = parentId ? byId.get(parentId) : undefined;
  }
}

async function readPiSessionFile(sessionPath: string): Promise<ChatMessage[]> {
  const raw = await fs.readFile(sessionPath, 'utf8');
  const entries = parseStrictPiSessionEntries(raw);
  const sessionEntries = entries.filter(isSessionEntry);
  assertAcyclicActivePath(sessionEntries);
  // buildContextEntries plus sessionEntryToContextMessages is exactly the
  // decomposition buildSessionContext performs, kept explicit here so each
  // rendered row retains its session entry identity through to providerMeta.
  const messages = buildContextEntries(sessionEntries).flatMap((entry) => {
    const entryId = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null;
    const converted = sessionEntryToContextMessages(entry)
      .flatMap((message) => convertPiMessage(message));
    if (entryId === null) return converted;
    return converted.map((message, withinSourceOrdinal) => attachNativeMessageSource(message, {
      entryId,
      withinSourceOrdinal,
    }));
  });
  return messages;
}

export async function loadPiChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  return readPiSessionFile(sessionPath);
}

function parseStrictPiSessionEntries(raw: string): FileEntry[] {
  return raw.split('\n').flatMap((line, index) => {
    if (!line.trim()) return [];
    let value: unknown;
    try {
      value = JSON.parse(line);
    } catch {
      throw new Error(`Pi transcript record ${index + 1} is invalid`);
    }
    if (
      !value
      || typeof value !== 'object'
      || Array.isArray(value)
      || typeof (value as Record<string, unknown>).type !== 'string'
    ) {
      throw new Error(`Pi transcript record ${index + 1} is invalid`);
    }
    return [value as FileEntry];
  });
}
