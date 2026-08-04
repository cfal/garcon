import { isRecord } from '@garcon/common/json';

export interface SSEEvent {
  id?: string;
  type: string;
  properties?: Record<string, any>;
}

interface OpenCodeGlobalEventClient {
  global: {
    event(options: {
      signal: AbortSignal;
      sseMaxRetryAttempts: number;
      onSseError: (error: unknown) => void;
    }): Promise<{ stream: AsyncIterable<unknown> }>;
  };
}

// The server-wide /global/event stream wraps each per-instance event in an envelope.
// The normalizer drops durable sync copies before they reach turn processing.
export function unwrapGlobalEvent(envelope: unknown): SSEEvent | null {
  const payload = isRecord(envelope) && isRecord(envelope.payload) ? envelope.payload : null;
  if (!payload || typeof payload.type !== 'string' || payload.type === 'sync') return null;
  return {
    id: typeof payload.id === 'string' ? payload.id : undefined,
    type: payload.type,
    properties: isRecord(payload.properties) ? payload.properties : undefined,
  };
}

export async function* streamGlobalEvents(
  client: OpenCodeGlobalEventClient,
  signal: AbortSignal,
  onConnected: () => void,
): AsyncGenerator<SSEEvent> {
  let streamError: unknown;
  // The instance stream filters one directory, while this runtime owns sessions across directories.
  // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/event.ts#L25-L41
  const result = await client.global.event({
    signal,
    // The global endpoint does not replay missed events, so SDK retries cannot preserve active turns.
    // https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/server/routes/instance/httpapi/handlers/global.ts#L33-L65
    sseMaxRetryAttempts: 0,
    onSseError: (error: unknown) => {
      streamError = error;
    },
  });

  let connected = false;
  for await (const envelope of result.stream) {
    const event = unwrapGlobalEvent(envelope);
    if (!event) continue;
    if (event.type === 'server.connected') {
      connected = true;
      onConnected();
      continue;
    }
    if (!connected) {
      throw new Error(`OpenCode event stream emitted ${event.type} before server.connected`);
    }
    yield event;
  }

  const cause = signal.aborted ? signal.reason : streamError;
  if (cause instanceof Error) throw cause;
  if (cause !== undefined) throw new Error(String(cause));
  throw new Error(connected
    ? 'OpenCode event stream ended'
    : 'OpenCode event stream ended before server.connected');
}

// Non-retryable provider failures are published as session.error with a structured error
// union; the data message is the most specific human-readable detail.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/sdk/js/src/v2/gen/types.gen.ts#L6672-L6680
export function openCodeSessionError(event: SSEEvent): string | null {
  if (event.type !== 'session.error') return null;
  const error = isRecord(event.properties?.error) ? event.properties.error : null;
  const data = error && isRecord(error.data) ? error.data : null;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof error?.name === 'string' && error.name.trim()) return error.name.trim();
  return 'OpenCode session failed';
}

// Context overflow is provisional when OpenCode auto-compaction is enabled. OpenCode emits
// session.compacted and continues the turn after recovery; without that event, the next idle
// makes the saved error terminal.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/processor.ts#L607-L617
export function isOpenCodeContextOverflowError(event: SSEEvent): boolean {
  if (event.type !== 'session.error') return false;
  const error = isRecord(event.properties?.error) ? event.properties.error : null;
  return error?.name === 'ContextOverflowError';
}

// Garcon owns aborts: its abort path retires the turn before OpenCode's abort unwind
// publishes MessageAbortedError, so a late unwind must never fail a successor turn.
export function isOpenCodeAbortError(event: SSEEvent): boolean {
  if (event.type !== 'session.error') return false;
  const error = isRecord(event.properties?.error) ? event.properties.error : null;
  return error?.name === 'MessageAbortedError';
}

export function extractSessionId(event: SSEEvent): string | undefined {
  const props = event.properties || {};
  return props.sessionID
    || props.part?.sessionID
    || props.info?.sessionID
    || (event.type?.startsWith('session.') ? props.info?.id : undefined);
}

export function extractTextParts(parts: unknown): string {
  if (!Array.isArray(parts)) return '';
  return parts
    .filter((part: any) => part?.type === 'text' && typeof part.text === 'string')
    .map((part: any) => part.text.trim())
    .filter(Boolean)
    .join('\n')
    .trim();
}
