import type { ForkTranscriptEntryContext } from '@garcon/server-agent-common/legacy/types';
import { convertClaudeEntries } from './history-loader.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value);
}

export function rewriteClaudeForkTranscriptEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  if (!isRecord(entry)) return entry;

  const rewritten = { ...entry };
  let changed = false;
  for (const key of ['sessionId', 'session_id']) {
    if (rewritten[key] === context.sourceAgentSessionId) {
      rewritten[key] = context.targetAgentSessionId;
      changed = true;
    }
  }
  const sessionRewritten = changed ? rewritten : entry;
  const retainedMessageCount = context.retainedMessageCount;
  if (retainedMessageCount === undefined) return sessionRewritten;

  const emittedCount = convertClaudeEntries([entry]).length;
  if (emittedCount <= retainedMessageCount) return sessionRewritten;
  if (retainedMessageCount === 0) return filteredEntry(context.targetAgentSessionId);

  const message = isRecord(sessionRewritten.message) ? sessionRewritten.message : null;
  const content = message?.content;
  if (!message || !Array.isArray(content)) {
    throw new Error('Claude fork cutoff cannot split the selected provider entry');
  }

  if (message.role === 'user') {
    const toolResults = content.filter((part) => isRecord(part) && part.type === 'tool_result');
    if (retainedMessageCount <= toolResults.length) {
      return {
        ...sessionRewritten,
        message: { ...message, content: toolResults.slice(0, retainedMessageCount) },
      };
    }
  }

  if (message.role === 'assistant') {
    for (let index = 0; index < content.length; index += 1) {
      const candidate = {
        ...sessionRewritten,
        message: { ...message, content: content.slice(0, index + 1) },
      };
      if (convertClaudeEntries([candidate]).length === retainedMessageCount) return candidate;
    }
  }

  throw new Error('Claude fork cutoff cannot preserve the selected provider entry prefix');
}

function filteredEntry(targetAgentSessionId: string): Record<string, unknown> {
  return { sessionId: targetAgentSessionId, type: 'garcon-fork-filtered' };
}
