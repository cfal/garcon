import type { JsonObject } from '@garcon/common/json';
import type {
  AgentTranscriptEntry,
  AgentTranscriptSourceIdentity,
} from '@garcon/server-agent-interface';
import { sourceIdentityKey } from './identity.js';
import type { AgentTranscriptSeedEntry } from './seed-entries.js';

// Compares an existing projection journal against current provider-native
// evidence by canonical source identity. The journal stays the rendering
// authority in every outcome: the audit may import a crash-missed native
// suffix once, advance the native-retention floor when a clean native prefix
// loss explains provider compaction, report the projection running ahead of a
// provider that has not persisted the committed tail yet, or report divergence
// that fences native fork continuity. It never re-renders or removes committed
// rows; content, rendered type, and timestamps never participate in identity.
export type NativeAuditOutcome =
  | { readonly kind: 'skipped' }
  | { readonly kind: 'diverged' }
  | {
      readonly kind: 'aligned';
      readonly suffix: readonly AgentTranscriptSeedEntry[];
      readonly nativeRetentionFloor: number | null;
      // Ordinal of the first committed entry the provider has not persisted;
      // recomputed on every audit rather than recorded, so it clears itself
      // once the provider catches up.
      readonly aheadFromOrdinal: number | null;
      // Native aliases observed for already-committed identities, so rows
      // journalled from live events gain their provider positions once the
      // provider persists them.
      readonly matchedAliases: ReadonlyMap<string, AgentTranscriptSeedEntry>;
    };

export function auditNativeEvidence(options: {
  readonly ownerId: string;
  readonly entries: readonly AgentTranscriptEntry[];
  readonly seeds: readonly AgentTranscriptSeedEntry[];
  // Journal aliases persisted by earlier audits: a row bound to a native
  // entry identity matches through that binding exactly, including admission
  // rows and integration occurrence identities, so a claim never repeats
  // once proven.
  readonly aliases?: JsonObject;
  // Integration-private settlement proof translating live ledger item
  // identities to the provider's durable native identities for this
  // boundary, before any binding has persisted.
  readonly itemAliases?: ReadonlyMap<string, string>;
}): NativeAuditOutcome {
  const namespace = `${options.ownerId}:native`;
  // The only identity-free anchor is the admission row: providers that never
  // notify user items still persist the admitted input as the next native
  // user occurrence, which the admission row claims by order. Every other
  // match requires the adapter's canonical source identity, direct or
  // alias-translated.
  const journal = options.entries.flatMap(
    (entry, index): {
      ordinal: number;
      key: string;
      matchKey: string;
      kind: 'exact' | 'admission';
    }[] => {
      const source = entry.source;
      if (entry.lifetime !== 'durable' || source === null) return [];
      const key = sourceIdentityKey(source);
      const bound = boundAliasEntry(options.aliases?.[key]);
      // A binding to a different native identity is a proven translation; a
      // self-referential alias only restates the row's own identity.
      if (bound && bound.entryId !== source.itemId) {
        return [{
          ordinal: index + 1,
          key,
          matchKey: sourceIdentityKey({
            namespace,
            itemId: bound.entryId,
            subrowId: `row:${bound.withinSourceOrdinal ?? 0}`,
          }),
          kind: 'exact',
        }];
      }
      if (comparableSource(source, namespace)) {
        const itemId = options.itemAliases?.get(source.itemId) ?? source.itemId;
        return [{
          ordinal: index + 1,
          key,
          matchKey: sourceIdentityKey({ ...source, itemId }),
          kind: 'exact',
        }];
      }
      if (source.namespace === 'garcon:admission' && entry.message.type === 'user-message') {
        return [{ ordinal: index + 1, key, matchKey: key, kind: 'admission' }];
      }
      return [];
    },
  );
  // A populated journal without any anchor offers nothing to match against,
  // and importing anything could duplicate rows imported at genesis under
  // process-local fallback identities.
  if (journal.length === 0 && options.entries.length > 0) return { kind: 'skipped' };
  // Legacy rows journalled under a process-local event identity may have a
  // native counterpart the audit cannot match. Rather than suppress every
  // future import for the whole segment, each such row accounts for at most
  // one unmatched native occurrence, so that many low unmatched native rows
  // are held back from import while a genuinely crash-missed canonical suffix
  // beyond them still repairs. Post-V4 adapters owe canonical identities and
  // produce no such rows; this only degrades grandfathered journals.
  const eventNamespace = `${options.ownerId}:event`;
  const unidentifiedCommittedCount = options.entries.filter((entry) => (
    entry.lifetime === 'durable'
    && ((entry.source?.namespace === namespace && entry.source.itemId.startsWith('event:'))
      || entry.source?.namespace === eventNamespace)
  )).length;

  const native: { readonly key: string; readonly seed: AgentTranscriptSeedEntry }[] = [];
  const nativePositions = new Map<string, number>();
  for (const seed of options.seeds) {
    if (!comparableSource(seed.source, namespace)) continue;
    const key = sourceIdentityKey(seed.source);
    // Duplicate native identities make the evidence ambiguous; retry later.
    if (nativePositions.has(key)) return { kind: 'skipped' };
    nativePositions.set(key, native.length);
    native.push({ key, seed });
  }
  // Empty evidence cannot distinguish provider pruning from an unreadable
  // source, and the retention floor is monotonic; leave it for a later audit.
  if (native.length === 0 && journal.length > 0) return { kind: 'skipped' };

  // Provider-identified rows preserve provider order among themselves, and
  // admission rows claim user occurrences in delivery order among
  // themselves. The two families keep separate cursors: an input accepted
  // while a concurrent occurrence was still persisting commits in a journal
  // order that legitimately interleaves differently from the native file.
  let exactCursor = -1;
  let admissionCursor = -1;
  let lastMatchedNativePosition = -1;
  const missing: number[] = [];
  const matchedAliases = new Map<string, AgentTranscriptSeedEntry>();
  const claimed = new Set<number>();
  let firstMatchedJournalIndex = -1;
  let lastMatchedJournalIndex = -1;
  for (const [index, committed] of journal.entries()) {
    let position: number | undefined;
    if (committed.kind === 'exact') {
      position = nativePositions.get(committed.matchKey);
      if (position !== undefined) {
        // Two journal claims of one native position, whether an exact row
        // repeating a position or an exact row colliding with an admission
        // claim, is ambiguous evidence, not a match.
        if (position <= exactCursor || claimed.has(position)) return { kind: 'diverged' };
        exactCursor = position;
      }
    } else {
      for (let candidate = admissionCursor + 1; candidate < native.length; candidate += 1) {
        if (claimed.has(candidate)) continue;
        if (native[candidate]!.seed.message.type !== 'user-message') continue;
        position = candidate;
        break;
      }
      if (position !== undefined) admissionCursor = position;
    }
    if (position === undefined) {
      missing.push(index);
      continue;
    }
    if (firstMatchedJournalIndex === -1) firstMatchedJournalIndex = index;
    lastMatchedJournalIndex = index;
    lastMatchedNativePosition = Math.max(lastMatchedNativePosition, position);
    claimed.add(position);
    matchedAliases.set(committed.key, native[position]!.seed);
  }
  // Missing identities are explainable only at the edges: a missing prefix is
  // provider compaction and a missing tail is a provider that has not
  // persisted the committed suffix yet. A hole between matched identities is
  // neither.
  const missingPrefix = missing.filter((index) => (
    firstMatchedJournalIndex === -1 || index < firstMatchedJournalIndex
  ));
  const missingTail = missing.filter((index) => (
    firstMatchedJournalIndex !== -1 && index > lastMatchedJournalIndex
  ));
  if (missingPrefix.length + missingTail.length !== missing.length) return { kind: 'diverged' };
  // Native rows no committed identity claims are provider-observed new
  // output, wherever the provider recorded them: a retried tool attempt or
  // superseded item the stream never notified appends to the ledger in
  // native order. Divergence is reserved for already committed sources.
  const journalKeys = new Set(journal.flatMap((committed) => (
    committed.kind === 'exact' ? [committed.matchKey] : []
  )));
  // The lowest unidentified-count unmatched native rows are held back as the
  // presumed counterparts of the journal's event-identified rows; the rest
  // are provider-observed new output and import in native order.
  const suffix = native
    .filter((row, position) => !claimed.has(position) && !journalKeys.has(row.key))
    .slice(unidentifiedCommittedCount)
    .map((row) => row.seed);
  // A provider that moved on to new rows without persisting the committed
  // tail is not merely behind.
  if (missingTail.length > 0 && suffix.length > 0) return { kind: 'diverged' };

  return {
    kind: 'aligned',
    suffix,
    nativeRetentionFloor: missingPrefix.length === 0
      ? null
      : journal[missingPrefix.at(-1)!]!.ordinal,
    aheadFromOrdinal: missingTail.length === 0
      ? null
      : journal[missingTail[0]!]!.ordinal,
    matchedAliases,
  };
}

function boundAliasEntry(
  alias: unknown,
): { readonly entryId: string; readonly withinSourceOrdinal: number | null } | null {
  if (!alias || typeof alias !== 'object' || Array.isArray(alias)) return null;
  const record = alias as Record<string, unknown>;
  if (typeof record.entryId !== 'string' || record.entryId.length === 0) return null;
  return {
    entryId: record.entryId,
    withinSourceOrdinal: typeof record.withinSourceOrdinal === 'number'
      && Number.isSafeInteger(record.withinSourceOrdinal)
      && record.withinSourceOrdinal >= 0
      ? record.withinSourceOrdinal
      : null,
  };
}

function comparableSource(
  source: AgentTranscriptSourceIdentity | null,
  namespace: string,
): boolean {
  return source !== null
    && source.namespace === namespace
    && !source.itemId.startsWith('event:');
}
