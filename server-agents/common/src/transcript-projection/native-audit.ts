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
      // Rows journalled under process-local event identities cannot be told
      // apart from genuinely missed provider output, so imports and
      // hole-divergence conclusions are suppressed while any exist. Adapters
      // owe canonical identities; this only degrades legacy rows gracefully.
      readonly importSuppressed: boolean;
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
  const importSuppressed = options.entries.some((entry) => (
    entry.lifetime === 'durable'
    && entry.source?.namespace === namespace
    && entry.source.itemId.startsWith('event:')
  ));

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
      // Native order must preserve committed order.
      if (position !== undefined && position <= lastMatchedNativePosition) {
        return { kind: 'diverged' };
      }
    } else {
      for (let candidate = lastMatchedNativePosition + 1; candidate < native.length; candidate += 1) {
        if (claimed.has(candidate)) continue;
        if (native[candidate]!.seed.message.type !== 'user-message') continue;
        position = candidate;
        break;
      }
    }
    if (position === undefined) {
      missing.push(index);
      continue;
    }
    if (firstMatchedJournalIndex === -1) firstMatchedJournalIndex = index;
    lastMatchedJournalIndex = index;
    lastMatchedNativePosition = position;
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
  // Native rows the journal missed may only trail the last matched identity;
  // importing anything earlier would reorder committed ordinals. Rows behind
  // event-identified journal rows are unattributable, not divergent.
  const journalKeys = new Set(journal.flatMap((committed) => (
    committed.kind === 'exact' ? [committed.matchKey] : []
  )));
  if (!importSuppressed) {
    for (const [position, row] of native.entries()) {
      if (position > lastMatchedNativePosition) break;
      if (!claimed.has(position) && !journalKeys.has(row.key)) return { kind: 'diverged' };
    }
  }
  const suffix = importSuppressed
    ? []
    : native
      .slice(lastMatchedNativePosition + 1)
      .filter((row) => !journalKeys.has(row.key))
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
    importSuppressed,
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
