import { parseChatId } from './chat-id.js';
import { isExecutionIdentity, parseExecutionLocation, type ExecutionLocation } from './execution-location.js';
import { isRecord } from './json.js';

export interface NativeCleanupEntry {
  readonly chatId: string;
  readonly operationId: string;
  readonly sourceEpoch: string | null;
  readonly registryEpoch: string | null;
  readonly status: 'ownership-conflict' | 'durability-unknown' | 'deletion-pending' | 'native-cleanup-pending';
  readonly owners: readonly { readonly agentId: string; readonly executionLocation: ExecutionLocation }[];
  readonly createdAt: string;
}

export interface NativeCleanupSnapshot { readonly entries: readonly NativeCleanupEntry[] }
export interface NativeCleanupRetryRequest { readonly chatId: string; readonly operationId: string }
export interface NativeCleanupRetryResult { readonly kind: 'scheduled' | 'not-found' }

export function parseNativeCleanupRetryRequest(value: unknown): NativeCleanupRetryRequest | null {
  if (!fields(value, ['chatId', 'operationId']) || !isExecutionIdentity(value.operationId)) return null;
  try { return { chatId: parseChatId(value.chatId), operationId: value.operationId }; }
  catch { return null; }
}

export function parseNativeCleanupRetryResult(value: unknown): NativeCleanupRetryResult | null {
  return fields(value, ['kind']) && (value.kind === 'scheduled' || value.kind === 'not-found') ? { kind: value.kind } : null;
}

export function parseNativeCleanupSnapshot(value: unknown): NativeCleanupSnapshot | null {
  if (!fields(value, ['entries']) || !Array.isArray(value.entries)) return null;
  const entries: NativeCleanupEntry[] = [];
  for (const input of value.entries) {
    if (!fields(input, ['chatId', 'operationId', 'sourceEpoch', 'registryEpoch', 'status', 'owners', 'createdAt'])
      || !isExecutionIdentity(input.operationId) || !epoch(input.sourceEpoch) || !epoch(input.registryEpoch)
      || !cleanupStatus(input.status)
      || !Array.isArray(input.owners) || typeof input.createdAt !== 'string' || !Number.isFinite(Date.parse(input.createdAt))) return null;
    const owners: NativeCleanupEntry['owners'][number][] = [];
    for (const owner of input.owners) {
      if (!fields(owner, ['agentId', 'executionLocation']) || !isExecutionIdentity(owner.agentId)) return null;
      const executionLocation = parseExecutionLocation(owner.executionLocation);
      if (!executionLocation) return null;
      owners.push({ agentId: owner.agentId, executionLocation });
    }
    try {
      entries.push({ chatId: parseChatId(input.chatId), operationId: input.operationId,
        sourceEpoch: input.sourceEpoch, registryEpoch: input.registryEpoch, status: input.status,
        owners, createdAt: input.createdAt });
    } catch { return null; }
  }
  return { entries };
}

function fields(value: unknown, keys: readonly string[]): value is Record<string, unknown> {
  return isRecord(value) && Object.keys(value).length === keys.length && keys.every((key) => Object.hasOwn(value, key));
}
function epoch(value: unknown): value is string | null { return value === null || typeof value === 'string'; }
function cleanupStatus(value: unknown): value is NativeCleanupEntry['status'] {
  return value === 'ownership-conflict' || value === 'durability-unknown' || value === 'deletion-pending' || value === 'native-cleanup-pending';
}
