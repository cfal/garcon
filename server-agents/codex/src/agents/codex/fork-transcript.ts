import type { ForkTranscriptEntryContext } from '@garcon/server-agent-common/forking/fork-jsonl';
import { isRecord } from '@garcon/common/json';
import { LegacyCodexProjection } from './legacy-history-projection.js';
import {
  projectCodexCodeModeCommands,
  rewriteCodexCodeModeCommandPrefix,
} from './code-mode-command-projection.js';

export function rewriteCodexForkTranscriptEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
): unknown {
  return rewriteCodexForkEntry(entry, context, new LegacyCodexProjection());
}

export function createCodexForkTranscriptRewriter(): (
  entry: unknown,
  context: ForkTranscriptEntryContext,
) => unknown {
  const projection = new LegacyCodexProjection();
  return (entry, context) => rewriteCodexForkEntry(entry, context, projection);
}

function rewriteCodexForkEntry(
  entry: unknown,
  context: ForkTranscriptEntryContext,
  projection: LegacyCodexProjection,
): unknown {
  if (!isRecord(entry)) {
    return entry;
  }

  const retainedMessageCount = context.retainedMessageCount;
  if (retainedMessageCount !== undefined) {
    const normalized = projection.project(entry, {});
    const emittedCount = normalized
      ? normalized.canonical.length
        + normalized.fallbackUser.length
        + normalized.fallbackAssistant.length
        + normalized.fallbackThinking.length
      : 0;
    if (emittedCount > retainedMessageCount) {
      if (retainedMessageCount === 0) return { type: 'garcon_fork_filtered' };
      const codeModePrefix = rewriteCodeModePrefix(entry, retainedMessageCount);
      if (codeModePrefix) return codeModePrefix;
      if (
        retainedMessageCount === 1
        && entry.type === 'response_item'
        && isRecord(entry.payload)
        && entry.payload.type === 'web_search_call'
      ) {
        return {
          ...entry,
          payload: { ...entry.payload, status: 'in_progress' },
        };
      }
      throw new Error('Codex fork cutoff cannot preserve the selected provider entry prefix');
    }
  }

  if (entry.type !== 'session_meta' || !isRecord(entry.payload)) return entry;

  const payload = { ...entry.payload };
  let changed = false;
  for (const key of ['id', 'session_id']) {
    if (payload[key] === context.sourceAgentSessionId) {
      payload[key] = context.targetAgentSessionId;
      changed = true;
    }
  }
  if (!changed) return entry;

  return {
    ...entry,
    payload,
  };
}

function rewriteCodeModePrefix(
  entry: Record<string, unknown>,
  retainedMessageCount: number,
): Record<string, unknown> | null {
  if (entry.type !== 'response_item' || !isRecord(entry.payload)) return null;
  const payload = entry.payload;
  if (
    payload.type !== 'custom_tool_call'
    || payload.name !== 'exec'
    || typeof payload.input !== 'string'
  ) return null;
  const projection = projectCodexCodeModeCommands(payload.input);
  if (!projection || retainedMessageCount >= projection.commands.length) return null;
  return {
    ...entry,
    payload: {
      ...payload,
      input: rewriteCodexCodeModeCommandPrefix(
        projection.commands.slice(0, retainedMessageCount),
      ),
    },
  };
}
