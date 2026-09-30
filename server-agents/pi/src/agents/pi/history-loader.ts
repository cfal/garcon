import {
  buildSessionProjection,
  type FileEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import {
  type ChatMessage,
} from '@garcon/common/chat-types';
import { convertPiMessage } from './message-converter.js';

function isSessionEntry(entry: FileEntry): entry is SessionEntry {
  return entry.type !== 'session';
}

// The SDK walks the active path with no cycle guard, so the walk is checked first.
async function assertAcyclicActivePath(
  entries: readonly SessionEntry[],
  byId: ReadonlyMap<string, SessionEntry>,
  steps: EventLoopSteps,
): Promise<void> {
  let current = entries.at(-1);
  const visited = new Set<string>();
  while (current && typeof current.id === 'string' && current.id) {
    if (visited.has(current.id)) {
      throw new Error('Pi transcript parent graph contains a cycle');
    }
    visited.add(current.id);
    const parentId = typeof current.parentId === 'string' ? current.parentId : null;
    current = parentId ? byId.get(parentId) : undefined;
    if (steps.due) await steps.next();
  }
}

// Every resumed turn, reload, and fork reads the whole session, so the file is
// read in chunks and the passes over its entries share time-bounded steps.
async function readPiSessionFile(sessionPath: string): Promise<ChatMessage[]> {
  const steps = new EventLoopSteps('pi-history-load');
  const sessionEntries: SessionEntry[] = [];
  for await (const { line, lineNumber } of readJsonlLineEntries(sessionPath)) {
    const entry = parseStrictPiSessionEntry(line, lineNumber!);
    if (isSessionEntry(entry)) sessionEntries.push(entry);
    if (steps.due) await steps.next();
  }
  // Reuses the bounded index while the SDK projects the active path.
  const byId = new Map<string, SessionEntry>();
  await steps.forEach(sessionEntries, (entry) => {
    byId.set(entry.id, entry);
  });
  await assertAcyclicActivePath(sessionEntries, byId, steps);
  const projection = buildSessionProjection(sessionEntries, undefined, byId);
  await steps.next();
  // Keeps context edits and compaction checkpoints aligned with Pi while
  // retaining the original entry identity, not the editing entry's identity.
  const messages: ChatMessage[] = [];
  await steps.forEach(projection.entries, ({ sourceEntry: entry, messages: projected }) => {
    const entryId = typeof entry.id === 'string' && entry.id.length > 0 ? entry.id : null;
    const converted = projected.flatMap((message) => convertPiMessage(message));
    if (entryId === null) {
      messages.push(...converted);
      return;
    }
    converted.forEach((message, withinSourceOrdinal) => {
      messages.push(attachNativeMessageSource(message, { entryId, withinSourceOrdinal }));
    });
  });
  return messages;
}

export async function loadPiChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  return readPiSessionFile(sessionPath);
}

function parseStrictPiSessionEntry(line: string, lineNumber: number): FileEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Pi transcript record ${lineNumber} is invalid`);
  }
  if (
    !value
    || typeof value !== 'object'
    || Array.isArray(value)
    || typeof (value as Record<string, unknown>).type !== 'string'
  ) {
    throw new Error(`Pi transcript record ${lineNumber} is invalid`);
  }
  return value as FileEntry;
}
