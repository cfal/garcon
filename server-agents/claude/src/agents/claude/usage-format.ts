import { isRecord } from '@garcon/common/json';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import {
  parseTimestampMs,
  tokenCount,
  type MalformedUsage,
  type TranscriptUsageFormat,
  type UsageRecord,
} from '@garcon/server-agent-common/usage/usage-record';

// Claude Code writes this model on local placeholders that never reached the API.
const CLAUDE_SYNTHETIC_MODEL = '<synthetic>';

/**
 * Claude Code writes one transcript line per assistant content block, and each
 * repeats the parent message's usage, so every line of a message shares one
 * dedupe key. Forks and resumed sessions copy lines into other transcripts with
 * the same key.
 */
export function parseClaudeUsageLine(line: string): UsageRecord | MalformedUsage | null {
  // Tolerates a line that lost its newline the way the history loader does.
  const parsed = parseFirstJsonlValue(line);
  // Only lines carrying a usage key are parsed, so a corrupt one may have held a request.
  if (parsed.kind === 'invalid' || parsed.kind === 'incomplete') return { malformed: true, timestampMs: null };
  if (parsed.kind === 'empty') return null;
  const entry = parsed.value;
  if (!isRecord(entry) || entry.type !== 'assistant' || !isRecord(entry.message)) return null;
  // Garcon's fork copies source entries with this marker, restamping the last one. The
  // request was billed in the source session.
  if (isRecord(entry.forkedFrom)) return null;
  const message = entry.message;
  const usage = message.usage;
  if (!isRecord(usage)) return null;
  const timestampMs = parseTimestampMs(entry.timestamp);
  const model = typeof message.model === 'string' ? message.model : '';
  if (timestampMs === null || model.length === 0 || model === CLAUDE_SYNTHETIC_MODEL) return null;

  const messageId = typeof message.id === 'string' ? message.id : null;
  const requestId = typeof entry.requestId === 'string' ? entry.requestId : null;
  const cacheCreation = isRecord(usage.cache_creation) ? usage.cache_creation : null;
  return {
    timestampMs,
    model,
    sessionId: typeof entry.sessionId === 'string' ? entry.sessionId : '',
    totals: {
      uncachedInputTokens: tokenCount(usage.input_tokens),
      cachedInputTokens: tokenCount(usage.cache_read_input_tokens),
      cacheWriteTokens: tokenCount(usage.cache_creation_input_tokens),
      outputTokens: tokenCount(usage.output_tokens),
      // Anthropic folds thinking into output tokens without a separate count.
      reasoningTokens: 0,
    },
    cacheWrite1hTokens: tokenCount(cacheCreation?.ephemeral_1h_input_tokens),
    speed: usage.speed === 'fast' ? 'fast' : 'standard',
    dedupeKey: messageId === null && requestId === null ? null : `${messageId ?? ''}:${requestId ?? ''}`,
  };
}

export const claudeUsageFormat: TranscriptUsageFormat<null> = {
  lineMarkers: ['"usage"'],
  createState: () => null,
  cloneState: () => null,
  parseLine: (line) => parseClaudeUsageLine(line),
};
