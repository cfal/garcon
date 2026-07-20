import { AgentIntegrationError } from '@garcon/server-agent-interface';
import { parseFirstJsonlValue } from '@garcon/server-agent-common/lib/jsonl';
import { readJsonlLineEntries } from '@garcon/server-agent-common/shared/history-loader-utils';

const MAX_SESSION_META_BYTES = 1024 * 1024;

export interface CodexHistoryBase {
  readonly threadId: string;
  readonly endOrdinalExclusive: number;
  readonly endByteOffset: number;
}

interface CodexHistoryProfileBase {
  readonly nativePath: string;
  readonly threadId: string;
  readonly createdAt: string;
}

export type CodexHistoryProfile =
  | (CodexHistoryProfileBase & { readonly mode: 'legacy' })
  | (CodexHistoryProfileBase & {
      readonly mode: 'paginated';
      readonly historyBase: CodexHistoryBase | null;
    });

export async function inspectCodexHistoryProfile(input: {
  readonly nativePath: string;
  readonly expectedThreadId?: string | null;
  readonly signal: AbortSignal;
}): Promise<CodexHistoryProfile> {
  input.signal.throwIfAborted();
  let firstLine: string | null = null;
  try {
    for await (const entry of readJsonlLineEntries(input.nativePath, {
      completeLinesOnly: true,
      maxLineBytes: MAX_SESSION_META_BYTES,
      signal: input.signal,
    })) {
      if (!entry.line.trim()) continue;
      firstLine = entry.line;
      break;
    }
  } catch (error) {
    input.signal.throwIfAborted();
    throw transcriptUnavailable('Codex session metadata is unavailable', error);
  }
  if (!firstLine) {
    throw transcriptUnavailable('Codex session metadata is unavailable');
  }

  const parsed = parseFirstJsonlValue<unknown>(firstLine);
  if (parsed.kind !== 'value') {
    throw transcriptUnavailable('Codex session metadata is invalid');
  }
  const entry = record(parsed.value);
  const payload = record(entry?.payload);
  if (entry?.type !== 'session_meta' || !payload) {
    throw transcriptUnavailable('Codex transcript does not start with session metadata');
  }

  const threadId = nonEmptyString(payload.id);
  if (!threadId) throw transcriptUnavailable('Codex session metadata has no thread id');
  if (input.expectedThreadId && input.expectedThreadId !== threadId) {
    throw transcriptUnavailable('Codex transcript belongs to a different thread');
  }

  const createdAt = rfc3339(payload.timestamp) ?? rfc3339(entry.timestamp);
  if (!createdAt) throw transcriptUnavailable('Codex session metadata has an invalid timestamp');

  const rawMode = payload.history_mode;
  if (rawMode !== undefined && typeof rawMode !== 'string') {
    throw transcriptUnavailable('Codex session metadata has an invalid history mode');
  }
  const mode = rawMode ?? 'legacy';
  if (mode === 'legacy') {
    return { mode, nativePath: input.nativePath, threadId, createdAt };
  }
  if (mode === 'paginated') {
    return {
      mode,
      nativePath: input.nativePath,
      threadId,
      createdAt,
      historyBase: parseHistoryBase(payload.history_base),
    };
  }
  throw new AgentIntegrationError(
    'OPERATION_UNSUPPORTED',
    `Codex history mode ${mode} is not supported`,
    false,
    { operation: 'load-history', historyMode: mode, provider: 'codex' },
  );
}

function parseHistoryBase(value: unknown): CodexHistoryBase | null {
  if (value === undefined || value === null) return null;
  const raw = record(value);
  const threadId = nonEmptyString(raw?.thread_id);
  const endOrdinalExclusive = nonNegativeSafeInteger(raw?.end_ordinal_exclusive);
  const endByteOffset = nonNegativeSafeInteger(raw?.end_byte_offset);
  if (!threadId || endOrdinalExclusive === null || endByteOffset === null) {
    throw transcriptUnavailable('Codex session metadata has an invalid history base');
  }
  return { threadId, endOrdinalExclusive, endByteOffset };
}

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function nonEmptyString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value : null;
}

function nonNegativeSafeInteger(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function rfc3339(value: unknown): string | null {
  if (typeof value !== 'string' || !value.trim()) return null;
  if (!/^\d{4}-\d{2}-\d{2}[Tt]\d{2}:\d{2}:\d{2}(?:\.\d+)?(?:[Zz]|[+-]\d{2}:\d{2})$/.test(value)) {
    return null;
  }
  return Number.isNaN(Date.parse(value)) ? null : value;
}

function transcriptUnavailable(message: string, cause?: unknown): AgentIntegrationError {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', `${message}${suffix}`, false);
}
