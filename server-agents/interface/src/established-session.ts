import { isExecutionIdentity } from '@garcon/common/execution-location';
import { isRecord } from '@garcon/common/json';
import { parseNativeSeedReceipt } from '@garcon/common/transcript-seed';
import type { AgentEstablishedSession } from './contracts/producer.js';
import { isNormalizedJsonObject } from './normalized-json.js';

/** Snapshots and validates the session DTO without wire framing or serialization. */
export function snapshotEstablishedSession(value: unknown): AgentEstablishedSession {
  const session = parseOwnedEstablishedSession(structuredClone(value));
  if (!session) throw new TypeError('Invalid established session');
  return session;
}

/** Validates an already privately owned session, shared by local and wire boundaries. */
export function parseOwnedEstablishedSession(value: unknown): AgentEstablishedSession | null {
  if (!isRecord(value) || !keys(value, ['agentSessionId', 'nativeSession', 'nativeSeedReceipt'])
    || typeof value.agentSessionId !== 'string' || !value.agentSessionId.trim() || value.agentSessionId.includes('\0')) return null;
  let nativeSession = null;
  if (value.nativeSession !== null) {
    const native = value.nativeSession;
    if (!isRecord(native) || !keys(native, ['ownerId', 'schemaVersion', 'value'])
      || !isExecutionIdentity(native.ownerId) || typeof native.schemaVersion !== 'number'
      || !Number.isSafeInteger(native.schemaVersion) || native.schemaVersion < 1
      || !isNormalizedJsonObject(native.value)) return null;
    nativeSession = { ownerId: native.ownerId, schemaVersion: native.schemaVersion, value: native.value };
  }
  if (value.nativeSeedReceipt !== null && (!isRecord(value.nativeSeedReceipt)
    || !keys(value.nativeSeedReceipt, ['agentSessionId', 'placement', 'format', 'codeUnitLength', 'sha256']))) return null;
  const nativeSeedReceipt = value.nativeSeedReceipt === null ? null : parseNativeSeedReceipt(value.nativeSeedReceipt);
  if (value.nativeSeedReceipt !== null && (!nativeSeedReceipt || nativeSeedReceipt.agentSessionId !== value.agentSessionId)) return null;
  return { agentSessionId: value.agentSessionId, nativeSession, nativeSeedReceipt };
}

function keys(value: Record<string, unknown>, fields: readonly string[]): boolean {
  return Object.keys(value).length === fields.length && fields.every((field) => Object.hasOwn(value, field));
}
