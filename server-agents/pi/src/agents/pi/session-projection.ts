import {
  sessionEntryToContextMessages,
  type ContextEditEntry,
  type ProjectedSessionEntry,
  type SessionEntry,
} from '@earendil-works/pi-coding-agent';
import type { EventLoopSteps } from '@garcon/server-agent-common/shared/event-loop';

// Mirrors the pinned SDK's buildSessionProjection entry semantics in bounded passes.
// SDK parity tests cover compaction and context edits when the dependency changes.
export async function projectPiHistory(
  entries: readonly SessionEntry[],
  steps: EventLoopSteps,
): Promise<ProjectedSessionEntry[]> {
  const byId = new Map<string, SessionEntry>();
  await steps.forEach(entries, (entry) => { byId.set(entry.id, entry); });

  const reversePath: SessionEntry[] = [];
  const visited = new Set<SessionEntry>();
  let current = entries.at(-1);
  while (current) {
    if (visited.has(current)) throw new Error('Pi transcript parent graph contains a cycle');
    visited.add(current);
    reversePath.push(current);
    current = current.parentId ? byId.get(current.parentId) : undefined;
    if (steps.due) await steps.next();
  }

  const path: SessionEntry[] = [];
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
  const context: SessionEntry[] = [];
  if (compaction?.type === 'compaction') {
    context.push(compaction);
    let keeping = false;
    for (let index = 0; index < path.length; index += 1) {
      const entry = path[index]!;
      if (index < compactionIndex) {
        if (entry.id === compaction.firstKeptEntryId) keeping = true;
        if (keeping && !(entry.type === 'message' && entry.message.role === 'system')) context.push(entry);
      } else if (index > compactionIndex) {
        context.push(entry);
      }
      if (steps.due) await steps.next();
    }
  } else {
    await steps.forEach(path, (entry) => { context.push(entry); });
  }

  const edits = new Map<string, ContextEditEntry>();
  await steps.forEach(context, (entry) => {
    if (entry.type === 'context_edit') edits.set(entry.targetId, entry);
  });
  const projected: ProjectedSessionEntry[] = [];
  await steps.forEach(context, (sourceEntry) => {
    const messages = sourceEntry.type === 'compaction' && projected.length > 0
      ? []
      : projectEntry(sourceEntry, edits.get(sourceEntry.id));
    projected.push({ sourceEntry, messages });
  });
  return projected;
}

function projectEntry(
  entry: SessionEntry,
  edit: ContextEditEntry | undefined,
): ProjectedSessionEntry['messages'] {
  const messages = sessionEntryToContextMessages(entry);
  if (!edit) return messages;
  const replacement = edit.replacement;
  if (replacement === null) return [];
  return messages.map((message) => {
    if (message.role !== 'user' && message.role !== 'assistant'
      && message.role !== 'toolResult' && message.role !== 'custom') return message;
    const content = (message.role === 'assistant' || message.role === 'toolResult')
      && typeof replacement.content === 'string'
      ? [{ type: 'text' as const, text: replacement.content }]
      : replacement.content;
    return { ...message, content } as typeof message;
  });
}
