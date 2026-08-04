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
