import { isRecord, type JsonObject } from '@garcon/common/json';
import type { AgentImportedTranscriptRow } from './native-history.js';
import type { AgentInstanceCallOptions } from './resources.js';

export const NATIVE_CHILD_DESCRIPTOR_BYTES = 16 * 1024;
export const NATIVE_CHILD_KEY_BYTES = 1024;

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
