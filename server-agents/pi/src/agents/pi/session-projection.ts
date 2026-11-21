import { isRecord } from '@garcon/common/json';
import type { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';

export interface PiSessionEntry extends Record<string, unknown> {
  type: string;
}

export function isPiSessionEntry(value: unknown): value is PiSessionEntry {
  return isRecord(value) && typeof value.type === 'string';
}

interface ProjectedSessionEntry {
  sourceEntry: PiSessionEntry;
  messages: unknown[];
}

// Mirrors the pinned SDK's buildSessionProjection entry semantics in bounded passes.
// https://github.com/earendil-works/pi/blob/b4afdddf44e059c67ccf5097e5317d913521b470/packages/coding-agent/src/core/session-manager.ts#L468-L584
export async function projectPiHistory(
  entries: readonly PiSessionEntry[],
  steps: EventLoopSteps,
): Promise<ProjectedSessionEntry[]> {
  const byId = new Map<string, PiSessionEntry>();
  await steps.forEach(entries, (entry) => { if (typeof entry.id === 'string') byId.set(entry.id, entry); });

  const reversePath: PiSessionEntry[] = [];
  const visited = new Set<PiSessionEntry>();
  let current = entries.at(-1);
  while (current) {
    if (visited.has(current)) throw new Error('Pi transcript parent graph contains a cycle');
    visited.add(current);
    reversePath.push(current);
    current = typeof current.parentId === 'string' && current.parentId ? byId.get(current.parentId) : undefined;
    if (steps.due) await steps.next();
  }

  const path: PiSessionEntry[] = [];
  let compactionIndex = -1;
  for (let index = reversePath.length - 1; index >= 0; index -= 1) {
    const entry = reversePath[index]!;
    // The SDK inspects message containers before compaction discards entries.
    if (entry.type === 'message' && entry.message == null) {
      throw new Error('Pi transcript message entry has no message');
    }
    if (entry.type === 'compaction') compactionIndex = path.length;
    path.push(entry);
    if (steps.due) await steps.next();
  }

  const compaction = path[compactionIndex];
  const context: PiSessionEntry[] = [];
  if (compaction?.type === 'compaction') {
    context.push(compaction);
    let keeping = false;
    for (let index = 0; index < path.length; index += 1) {
      const entry = path[index]!;
      if (index < compactionIndex) {
        if (entry.id === compaction.firstKeptEntryId) keeping = true;
        if (keeping && !(entry.type === 'message' && isRecord(entry.message) && entry.message.role === 'system')) context.push(entry);
      } else if (index > compactionIndex) {
        context.push(entry);
      }
      if (steps.due) await steps.next();
    }
  } else {
    await steps.forEach(path, (entry) => { context.push(entry); });
  }

  const edits = new Map<string, PiSessionEntry>();
  await steps.forEach(context, (entry) => {
    if (entry.type === 'context_edit' && typeof entry.targetId === 'string') edits.set(entry.targetId, entry);
  });
  const projected: ProjectedSessionEntry[] = [];
  await steps.forEach(context, (sourceEntry) => {
    const messages = sourceEntry.type === 'compaction' && projected.length > 0
      ? []
      : projectEntry(sourceEntry, typeof sourceEntry.id === 'string' ? edits.get(sourceEntry.id) : undefined);
    projected.push({ sourceEntry, messages });
  });
  return projected;
}

function projectEntry(
  entry: PiSessionEntry,
  edit: PiSessionEntry | undefined,
): ProjectedSessionEntry['messages'] {
  const messages = entryMessages(entry);
  if (!edit) return messages;
  const replacement = edit.replacement;
  if (replacement === null) return [];
  return messages.map((message) => {
    if (!isRecord(message) || (message.role !== 'user' && message.role !== 'assistant'
      && message.role !== 'toolResult' && message.role !== 'custom')) return message;
    if (replacement === undefined) throw new Error('Missing Pi context edit replacement');
    const editedContent = isRecord(replacement) ? replacement.content : undefined;
    const content = (message.role === 'assistant' || message.role === 'toolResult')
      && typeof editedContent === 'string'
      ? [{ type: 'text', text: editedContent }]
      : editedContent;
    return { ...message, content };
  });
}

function entryMessages(entry: PiSessionEntry): unknown[] {
  if (entry.type === 'message') {
    const message = entry.message;
    if (isRecord(message) && message.content == null) {
      if (message.role === 'system') return [{ ...message, content: '' }];
      if (message.role === 'user' || message.role === 'assistant' || message.role === 'toolResult') {
        return [{ ...message, content: [] }];
      }
    }
    return [message];
  }
  const timestamp = new Date(typeof entry.timestamp === 'string' ? entry.timestamp : Number(entry.timestamp)).getTime();
  switch (entry.type) {
    case 'custom_message':
      return [{ role: 'custom', customType: entry.customType, content: entry.content ?? [],
        display: entry.display, details: entry.details, timestamp }];
    case 'branch_summary':
      return entry.summary ? [{ role: 'branchSummary', summary: entry.summary, fromId: entry.fromId, timestamp }] : [];
    case 'compaction': {
      const summary = { role: 'compactionSummary', summary: entry.summary, tokensBefore: entry.tokensBefore, timestamp };
      return entry.systemMessage ? [entry.systemMessage, summary] : [summary];
    }
    default: return [];
  }
}
