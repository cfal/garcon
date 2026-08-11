import type { JsonObject } from '@garcon/common/json';
import type {
  AgentTranscriptEntry,
  AgentTranscriptSourceIdentity,
} from '@garcon/server-agent-interface';
import { sourceIdentityKey } from './identity.js';
import type { auditNativeEvidence } from './native-audit.js';
import type { AgentProjectionJournal } from './journal.js';
import { nativeAlias, nativeAliasLineNumber } from './seed-entries.js';

// Native-metadata persistence and alias binding for a journal-backed segment,
// factored out of journal-stream.ts to keep that file within its footprint
// budget. The journal remains the rendering authority in every path here.

export function hasNativeBinding(alias: unknown): boolean {
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return false;
  const record = alias as Record<string, unknown>;
  return (typeof record.entryId === 'string' && record.entryId.length > 0)
    || (typeof record.lineNumber === 'number' && Number.isSafeInteger(record.lineNumber) && record.lineNumber > 0)
    || (typeof record.byteOffset === 'number' && Number.isSafeInteger(record.byteOffset) && record.byteOffset >= 0);
}

// Binds matched aliases and an explained retention-floor advance from one
// audit outcome. Only identities without a native line binding are rebound.
export async function applyAuditMetadata(
  journal: AgentProjectionJournal,
  outcome: Extract<ReturnType<typeof auditNativeEvidence>, { kind: 'aligned' }>,
  importedAliases: JsonObject,
): Promise<void> {
  const state = journal.state;
  const boundAliases = Object.fromEntries(
    [...outcome.matchedAliases]
      .filter(([key]) => state.aliases[key] === undefined
        || nativeAliasLineNumber(state.aliases[key]) === null)
      .flatMap(([key, seed]) => {
        const alias = seed.nativeAlias === undefined ? nativeAlias(seed.message) : seed.nativeAlias;
        return alias ? [[key, alias] as const] : [];
      }),
  );
  const floor = outcome.nativeRetentionFloor;
  if (Object.keys(importedAliases).length > 0
      || Object.keys(boundAliases).length > 0
      || (floor !== null && floor > state.nativeRetentionFloor)) {
    await journal.updateNativeMetadata({
      nativeRetentionFloor: floor !== null && floor > state.nativeRetentionFloor
        ? floor
        : state.nativeRetentionFloor,
      aliases: { ...state.aliases, ...boundAliases, ...importedAliases },
    });
  }
}

export async function persistNativeAliases(
  journal: AgentProjectionJournal,
  entries: readonly AgentTranscriptEntry[],
  serializedAliases: ReadonlyMap<string, JsonObject> = new Map(),
): Promise<void> {
  const additions = entries.flatMap((entry) => {
    const alias = entry.source
      ? serializedAliases.get(sourceIdentityKey(entry.source)) ?? nativeAlias(entry.message)
      : null;
    return alias && entry.source
      ? [[sourceIdentityKey(entry.source), alias] as const]
      : [];
  });
  if (!additions.length) return;
  const state = journal.state;
  await journal.updateNativeMetadata({
    nativeRetentionFloor: state.nativeRetentionFloor,
    aliases: { ...state.aliases, ...Object.fromEntries(additions) },
  });
}

export function admissionSource(operation: {
  readonly clientRequestId: string | null;
  readonly turnId: string;
}): AgentTranscriptSourceIdentity {
  return {
    namespace: 'garcon:admission',
    itemId: operation.clientRequestId ?? operation.turnId,
    subrowId: 'user',
  };
}
