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

export interface CodexSessionIdentity {
  readonly threadId: string;
  readonly createdAt: string;
}

export type CodexHistoryProfile =
  | (CodexHistoryProfileBase & { readonly mode: 'legacy' })
  | (CodexHistoryProfileBase & {
      readonly mode: 'paginated';
      readonly historyBase: CodexHistoryBase | null;
    });

interface CodexSessionMetadata extends CodexSessionIdentity {
  readonly payload: Record<string, unknown>;
}

interface CodexSessionIdentityInput {
  readonly nativePath: string;
  readonly expectedThreadId?: string | null;
  readonly signal: AbortSignal;
}

export async function inspectCodexSessionIdentity(
  input: CodexSessionIdentityInput,
): Promise<CodexSessionIdentity> {
  const { threadId, createdAt } = await inspectCodexSessionMetadata(input);
  return { threadId, createdAt };
}

export async function inspectCodexHistoryProfile(
  input: CodexSessionIdentityInput,
): Promise<CodexHistoryProfile> {
  const { threadId, createdAt, payload } = await inspectCodexSessionMetadata(input);
  const rawMode = payload.history_mode;
  if (rawMode !== undefined && typeof rawMode !== 'string') {
    throw transcriptUnavailable(
      'Codex session metadata has an invalid history mode',
      undefined,
      'invalid-metadata',
    );
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

async function inspectCodexSessionMetadata(
  input: CodexSessionIdentityInput,
): Promise<CodexSessionMetadata> {
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
    throw transcriptUnavailable('Codex session metadata is unavailable', error, 'read-failed');
  }
  if (!firstLine) {
    throw transcriptUnavailable(
      'Codex session metadata is unavailable',
      undefined,
      'invalid-metadata',
    );
  }

  const parsed = parseFirstJsonlValue<unknown>(firstLine);
  if (parsed.kind !== 'value') {
    throw transcriptUnavailable('Codex session metadata is invalid', undefined, 'invalid-metadata');
  }
  const entry = record(parsed.value);
  const payload = record(entry?.payload);
  if (entry?.type !== 'session_meta' || !payload) {
    throw transcriptUnavailable(
      'Codex transcript does not start with session metadata',
      undefined,
      'invalid-metadata',
    );
  }

  const threadId = nonEmptyString(payload.id);
  if (!threadId) {
    throw transcriptUnavailable(
      'Codex session metadata has no thread id',
      undefined,
      'invalid-metadata',
    );
  }
  if (input.expectedThreadId && input.expectedThreadId !== threadId) {
    throw transcriptUnavailable(
      'Codex transcript belongs to a different thread',
      undefined,
      'thread-mismatch',
    );
  }

  const createdAt = rfc3339(payload.timestamp) ?? rfc3339(entry.timestamp);
  if (!createdAt) {
    throw transcriptUnavailable(
      'Codex session metadata has an invalid timestamp',
      undefined,
      'invalid-metadata',
    );
  }
  return { threadId, createdAt, payload };
}

function parseHistoryBase(value: unknown): CodexHistoryBase | null {
  if (value === undefined || value === null) return null;
  const raw = record(value);
  const threadId = nonEmptyString(raw?.thread_id);
  const endOrdinalExclusive = nonNegativeSafeInteger(raw?.end_ordinal_exclusive);
  const endByteOffset = nonNegativeSafeInteger(raw?.end_byte_offset);
  if (!threadId || endOrdinalExclusive === null || endByteOffset === null) {
    throw transcriptUnavailable(
      'Codex session metadata has an invalid history base',
      undefined,
      'invalid-metadata',
    );
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

function transcriptUnavailable(
  message: string,
  cause: unknown,
  reason: 'read-failed' | 'invalid-metadata' | 'thread-mismatch',
): AgentIntegrationError {
  const suffix = cause instanceof Error && cause.message ? `: ${cause.message}` : '';
  const causeCode = errorCode(cause);
  return new AgentIntegrationError('TRANSCRIPT_UNAVAILABLE', `${message}${suffix}`, false, {
    operation: 'inspect-history',
    provider: 'codex',
    reason,
    ...(causeCode ? { causeCode } : {}),
  });
}

function errorCode(error: unknown): string | null {
  if (!error || typeof error !== 'object' || !('code' in error)) return null;
  return typeof error.code === 'string' ? error.code : null;
}
