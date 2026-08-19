import { isRecord } from '@garcon/common/json';

export interface SSEEvent {
  id?: string;
  type: string;
  properties?: Record<string, any>;
}

export type OpenCodeAssistantTerminal =
  | { readonly outcome: 'finished'; readonly messageId: string }
  | { readonly outcome: 'failed'; readonly messageId: string; readonly error: string }
  | { readonly outcome: 'aborted'; readonly messageId: string };

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

export function openCodeAssistantTerminal(event: SSEEvent): OpenCodeAssistantTerminal | null {
  if (event.type !== 'message.updated') return null;
  const info = isRecord(event.properties?.info) ? event.properties.info : null;
  if (
    info?.role !== 'assistant'
    || typeof info.id !== 'string'
    || !info.id
    || !isRecord(info.time)
    || typeof info.time.completed !== 'number'
  ) return null;

  const error = isRecord(info.error) ? info.error : null;
  if (error?.name === 'MessageAbortedError') {
    return { outcome: 'aborted', messageId: info.id };
  }
  if (error) {
    return {
      outcome: 'failed',
      messageId: info.id,
      error: openCodeErrorMessage(error),
    };
  }

  if (info.finish === 'error') {
    return { outcome: 'failed', messageId: info.id, error: 'OpenCode session failed' };
  }
  if (
    typeof info.finish !== 'string'
    || !info.finish
    || info.finish === 'tool-calls'
    || info.finish === 'unknown'
  ) return null;
  return { outcome: 'finished', messageId: info.id };
}

export function isOpenCodeCompactionAssistant(info: unknown): boolean {
  if (!isRecord(info) || info.role !== 'assistant') return false;
  return info.summary === true || info.mode === 'compaction' || info.agent === 'compaction';
}

// OpenCode marks every provider-created automatic compaction control part with auto=true.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/compaction.ts#L513-L536
export function isOpenCodeCompactionControlPart(event: SSEEvent): boolean {
  if (event.type !== 'message.part.updated') return false;
  const part = event.properties?.part;
  return isRecord(part) && part.type === 'compaction' && part.auto === true;
}

// The metadata key distinguishes compaction continuation from other synthetic text parts.
// https://github.com/anomalyco/opencode/blob/49c69c5ed3ccf706b61b3febb43c8aaff7f8325e/packages/opencode/src/session/compaction.ts#L486-L501
export function isOpenCodeCompactionContinuationPart(event: SSEEvent): boolean {
  if (event.type !== 'message.part.updated') return false;
  const part = event.properties?.part;
  if (!isRecord(part) || part.type !== 'text' || part.synthetic !== true) return false;
  const metadata = isRecord(part.metadata) ? part.metadata : null;
  return metadata?.compaction_continue === true;
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

function openCodeErrorMessage(error: Record<string, unknown>): string {
  const data = isRecord(error.data) ? error.data : null;
  if (typeof data?.message === 'string' && data.message.trim()) return data.message.trim();
  if (typeof error.name === 'string' && error.name.trim()) return error.name.trim();
  return 'OpenCode session failed';
}
