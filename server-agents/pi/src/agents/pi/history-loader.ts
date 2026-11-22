import { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';
import { attachNativeMessageSource } from '@garcon/server-agent-common/shared/native-message-source';
import type { ChatMessage } from '@garcon/common/chat-types';
import { convertPiMessage } from './message-converter.js';
import { isPiSessionEntry, projectPiHistory, type PiSessionEntry } from './session-projection.js';

// Every resumed turn, reload, and fork reads the whole session, so the file is
// read in chunks and the passes over its entries share time-bounded steps.
export async function loadPiChatMessages(sessionPath: string): Promise<ChatMessage[]> {
  const steps = new EventLoopSteps('pi-history-load');
  const sessionEntries: PiSessionEntry[] = [];
  for await (const { line, lineNumber } of readJsonlLineEntries(sessionPath)) {
    const entry = parseStrictPiSessionEntry(line, lineNumber!);
    if (entry.type !== 'session') sessionEntries.push(entry);
    if (steps.due) await steps.next();
  }
  const projection = await projectPiHistory(sessionEntries, steps);
  // Keeps context edits and compaction checkpoints aligned with Pi while
  // retaining the original entry identity, not the editing entry's identity.
  const messages: ChatMessage[] = [];
  await steps.forEach(projection, ({ sourceEntry: entry, messages: projected }) => {
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

function parseStrictPiSessionEntry(line: string, lineNumber: number): PiSessionEntry {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`Pi transcript record ${lineNumber} is invalid`);
  }
  if (!isPiSessionEntry(value)) {
    throw new Error(`Pi transcript record ${lineNumber} is invalid`);
  }
  return value;
}
