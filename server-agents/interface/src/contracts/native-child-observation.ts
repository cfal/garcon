import { isRecord, type JsonObject } from '@garcon/common/json';
import { parseChatMessage } from '@garcon/common/chat-types';
import { isNativeChildStatus, type NativeChildStatus } from '@garcon/common/chat-observation';
import type { AgentImportedTranscriptRow } from './native-history.js';
import type { AgentProducedRow } from './producer.js';
import type { AgentInstanceCallOptions } from './resources.js';

export const NATIVE_CHILD_DESCRIPTOR_BYTES = 16 * 1024;
export const NATIVE_CHILD_KEY_BYTES = 1024;
export const NATIVE_CHILD_EVENT_BYTES = 1024 * 1024;

export interface AgentNativeChildRef {
  readonly ownerId: string;
  readonly schemaVersion: number;
  readonly key: string;
  readonly value: JsonObject;
}

export interface AgentNativeChildDescriptor {
  readonly ref: AgentNativeChildRef;
  readonly parentKey: string | null;
  readonly label: string | null;
  readonly model: string | null;
}

export type AgentNativeChildEvent =
  | { readonly type: 'native-child-created'; readonly child: AgentNativeChildDescriptor }
  | { readonly type: 'native-child-rows'; readonly childKey: string; readonly rows: readonly AgentProducedRow[] }
  | { readonly type: 'native-child-status'; readonly childKey: string; readonly status: NativeChildStatus }
  | { readonly type: 'native-child-detached'; readonly childKey: string }
  | { readonly type: 'native-child-gap'; readonly childKey: string | null }
  | { readonly type: 'native-child-capture-ended'; readonly reason: 'retention-limit' };

export function isNativeChildEvent<T extends { readonly type: string }>(event: T): event is T & AgentNativeChildEvent {
  return event.type.startsWith('native-child-');
}

// Splits on row boundaries and isolates malformed content on Local and remote ingress.
export function normalizeNativeChildEvent(value: unknown): readonly AgentNativeChildEvent[] {
  const gap: AgentNativeChildEvent = { type: 'native-child-gap', childKey: null };
  if (!isRecord(value)) return [gap];
  if (value.type === 'native-child-created') {
    const child = parseAgentNativeChildDescriptor(value.child);
    return child ? [{ type: 'native-child-created', child }] : [gap];
  }
  if (value.type === 'native-child-capture-ended') {
    return value.reason === 'retention-limit' ? [{ type: value.type, reason: value.reason }] : [gap];
  }
  if (value.type === 'native-child-gap' && value.childKey === null) return [gap];
  if (!isNativeChildKey(value.childKey)) return [gap];
  const childKey = value.childKey;
  switch (value.type) {
    case 'native-child-gap':
    case 'native-child-detached': return [{ type: value.type, childKey }];
    case 'native-child-status': return isNativeChildStatus(value.status)
      ? [{ type: value.type, childKey, status: value.status }] : [{ ...gap, childKey }];
    case 'native-child-rows': {
      if (!Array.isArray(value.rows)) return [{ ...gap, childKey }];
      const events: AgentNativeChildEvent[] = [];
      const overhead = encoder.encode(JSON.stringify({ type: value.type, childKey, rows: [] })).byteLength;
      let rows: AgentProducedRow[] = [];
      let bytes = overhead;
      let incomplete = false;
      for (const row of value.rows) {
        try {
          if (!isRecord(row) || !isRecord(row.message)) throw new TypeError('Invalid child row');
          const size = encoder.encode(JSON.stringify(row)).byteLength + 1;
          if (size + overhead > NATIVE_CHILD_EVENT_BYTES) throw new TypeError('Oversized child row');
          const message = parseChatMessage(row.message);
          if (!message || !message.timestamp || (row.providerMeta !== undefined
            && (!isRecord(row.providerMeta) || !jsonValue(row.providerMeta, 0)))) throw new TypeError('Invalid child content');
          if (bytes + size > NATIVE_CHILD_EVENT_BYTES) {
            events.push({ type: 'native-child-rows', childKey, rows });
            rows = [];
            bytes = overhead;
          }
          rows.push({ message, ...(row.providerMeta ? { providerMeta: row.providerMeta as JsonObject } : {}) });
          bytes += size;
        } catch { incomplete = true; }
      }
      if (rows.length) events.push({ type: 'native-child-rows', childKey, rows });
      if (incomplete) events.push({ ...gap, childKey });
      return events;
    }
    default: return [gap];
  }
}

export interface AgentNativeChildHistoryRequest {
  readonly child: AgentNativeChildRef;
  readonly signal: AbortSignal;
}

export interface AgentNativeChildObservation {
  loadHistory(
    request: AgentNativeChildHistoryRequest,
    options?: AgentInstanceCallOptions,
  ): AsyncIterable<readonly AgentImportedTranscriptRow[]>;
}

const encoder = new TextEncoder();

export function isNativeChildKey(value: unknown): value is string {
  return typeof value === 'string' && value.trim().length > 0
    && encoder.encode(value).byteLength <= NATIVE_CHILD_KEY_BYTES;
}

export function parseAgentNativeChildRef(value: unknown): AgentNativeChildRef | null {
  if (!isRecord(value) || !isNativeChildKey(value.ownerId) || !isNativeChildKey(value.key)
    || !Number.isSafeInteger(value.schemaVersion) || Number(value.schemaVersion) < 1
    || !isRecord(value.value) || !boundedJson(value)) return null;
  return {
    ownerId: value.ownerId,
    schemaVersion: Number(value.schemaVersion),
    key: value.key,
    value: structuredClone(value.value) as JsonObject,
  };
}

export function parseAgentNativeChildDescriptor(value: unknown): AgentNativeChildDescriptor | null {
  if (!isRecord(value) || !boundedJson(value)) return null;
  const ref = parseAgentNativeChildRef(value.ref);
  if (!ref || !nullableKey(value.parentKey) || !nullableKey(value.label) || !nullableKey(value.model)) return null;
  return { ref, parentKey: value.parentKey, label: value.label, model: value.model };
}

function nullableKey(value: unknown): value is string | null {
  return value === null || isNativeChildKey(value);
}

function boundedJson(value: unknown): boolean {
  try {
    return encoder.encode(JSON.stringify(value)).byteLength <= NATIVE_CHILD_DESCRIPTOR_BYTES && jsonValue(value, 0);
  } catch { return false; }
}

function jsonValue(value: unknown, depth: number): boolean {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (depth > 16) return false;
  if (Array.isArray(value)) return value.every((item) => jsonValue(item, depth + 1));
  return isRecord(value) && (Object.getPrototypeOf(value) === Object.prototype || Object.getPrototypeOf(value) === null)
    && Object.values(value).every((item) => jsonValue(item, depth + 1));
}
